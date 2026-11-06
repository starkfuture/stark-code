import type {
  PilotFailureReason,
  PilotInstallResponse,
  PilotInstallState,
  PilotInstallStatus,
} from "@starkfuture/contracts";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { pilotHome } from "./Pilot.ts";

// Stark Code ships Pilot (packages/pilot) as a Claude Code plugin. Installing
// copies it to `$PILOT_HOME/plugin/<version>`, a folder nothing edits, and
// points Claude Code at it with `claude plugin install pilot --marketplace
// <folder>`. Lookout, and a Pilot read from a working checkout, are removed
// first so only one set of Pilot hooks runs.

/** The packaged app's resource folder for Pilot; build-desktop-artifact.ts stages it. */
export const PILOT_RESOURCE = "pilot";

/** The Pilot this app ships: a resource when packaged, the workspace package in development. */
export const bundledRoot = (environment: DesktopEnvironment.DesktopEnvironment["Service"]) =>
  environment.isPackaged
    ? environment.path.join(environment.resourcesPath, PILOT_RESOURCE)
    : environment.path.join(environment.rootDir, "packages", "pilot");

/** The name of Pilot's plugin and of its marketplace (packages/pilot/.claude-plugin). */
const PILOT = "pilot";
/** Plugin and marketplace names Pilot has shipped under. */
const PILOT_NAMES: ReadonlySet<string> = new Set([PILOT, "lookout"]);
const COMMAND_TIMEOUT_SECONDS = 60;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_LENGTH = 500;

/** Compares dotted versions part by part as numbers; a pre-release sorts before its release. */
export const compareVersions = (a: string, b: string): number => {
  const split = (version: string) => {
    const [core = "", pre] = version.trim().replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index++) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
};

/** One plugin as `claude plugin list --json` reports it. */
export interface InstalledPlugin {
  readonly id: string;
  readonly version: string | null;
  readonly scope: string;
  /** The folder a directory marketplace reads the plugin from. */
  readonly folder: string | null;
}

/** One marketplace as `claude plugin marketplace list --json` reports it. */
export interface KnownMarketplace {
  readonly name: string;
  /** Set for directory marketplaces. */
  readonly path: string | null;
}

export interface PilotInstallPlan {
  readonly state: Exclude<PilotInstallState, "unsupported">;
  /** The fixed copy Claude Code runs now. */
  readonly installedVersion: string | null;
  /** Lookout and other Pilots: every user-scope plugin installing replaces. */
  readonly replaces: ReadonlyArray<InstalledPlugin & { readonly source: string | null }>;
  /** Plugins to uninstall, including an older fixed copy that is updated. */
  readonly uninstall: ReadonlyArray<string>;
  /** Pilot's own marketplaces to remove, so the name "pilot" can point at the new folder. */
  readonly removeMarketplaces: ReadonlyArray<string>;
  /** Whether the bundled Pilot must be copied to its folder and installed from it. */
  readonly installCopy: boolean;
}

const pluginName = (id: string) => id.split("@", 1)[0] ?? id;
const marketplaceName = (id: string) => (id.includes("@") ? id.slice(id.indexOf("@") + 1) : "");

/**
 * Decides what installing changes. A fixed copy is `pilot@pilot` read from a
 * folder under one of `pluginRoots` (`$PILOT_HOME/plugin`, and its real path);
 * every other user-scope Pilot or Lookout plugin is replaced. Only Pilot's own
 * marketplaces are removed; a shared marketplace keeps its other plugins.
 */
export const planPilotInstall = (input: {
  readonly plugins: ReadonlyArray<InstalledPlugin>;
  readonly marketplaces: ReadonlyArray<KnownMarketplace>;
  readonly bundledVersion: string;
  readonly pluginRoots: ReadonlyArray<string>;
  readonly target: string;
}): PilotInstallPlan => {
  const sourceOf = (plugin: InstalledPlugin) =>
    plugin.folder ??
    input.marketplaces.find((marketplace) => marketplace.name === marketplaceName(plugin.id))
      ?.path ??
    null;
  const isFixedCopy = (folder: string | null) =>
    folder !== null &&
    input.pluginRoots.some((root) => folder.startsWith(`${root.replace(/\/+$/, "")}/`));

  const pilots = input.plugins
    .filter((plugin) => plugin.scope === "user" && PILOT_NAMES.has(pluginName(plugin.id)))
    .map((plugin) => ({ ...plugin, source: sourceOf(plugin) }));
  const fixed = pilots.find(
    (plugin) => plugin.id === `${PILOT}@${PILOT}` && isFixedCopy(plugin.source),
  );
  const replaces = pilots.filter((plugin) => plugin !== fixed);
  const installCopy =
    fixed === undefined ||
    fixed.version === null ||
    compareVersions(fixed.version, input.bundledVersion) < 0;
  const uninstall = [...replaces, ...(installCopy && fixed ? [fixed] : [])].map(
    (plugin) => plugin.id,
  );
  const ownMarketplace = input.marketplaces.find((marketplace) => marketplace.name === PILOT);
  const removeMarketplaces = [
    ...new Set([
      ...uninstall.map(marketplaceName).filter((name) => PILOT_NAMES.has(name)),
      // An earlier "pilot" marketplace from another folder would refuse the new one.
      ...(installCopy && ownMarketplace && ownMarketplace.path !== input.target ? [PILOT] : []),
    ]),
  ];
  return {
    state:
      replaces.length > 0
        ? "legacy"
        : fixed === undefined
          ? "not-installed"
          : installCopy
            ? "update"
            : "installed",
    installedVersion: fixed?.version ?? null,
    replaces,
    uninstall,
    removeMarketplaces,
    installCopy,
  };
};

/** Arguments for Claude Code's plugin commands. Every change is made in user scope. */
export const claudePluginArgs = {
  list: () => ["plugin", "list", "--json"],
  marketplaces: () => ["plugin", "marketplace", "list", "--json"],
  uninstall: (id: string) => ["plugin", "uninstall", id, "--scope", "user", "--json"],
  // No scope: the name is also dropped from Claude Code's marketplace registry, which a
  // user-scope removal leaves behind and which would refuse the new folder.
  removeMarketplace: (name: string) => ["plugin", "marketplace", "remove", name, "--json"],
  install: (folder: string) => [
    "plugin",
    "install",
    PILOT,
    "--marketplace",
    folder,
    "--scope",
    "user",
    "--json",
  ],
} as const;

/** Removes every user-scope Pilot and Lookout plugin, and Pilot's own marketplaces. */
export const planPilotUninstall = (input: {
  readonly plugins: ReadonlyArray<InstalledPlugin>;
  readonly marketplaces: ReadonlyArray<KnownMarketplace>;
}) => ({
  uninstall: input.plugins
    .filter((plugin) => plugin.scope === "user" && PILOT_NAMES.has(pluginName(plugin.id)))
    .map((plugin) => plugin.id),
  removeMarketplaces: input.marketplaces
    .map((marketplace) => marketplace.name)
    .filter((name) => PILOT_NAMES.has(name)),
});

/**
 * Settings a checkout may keep in its own `.env`, which the fixed copy does
 * not have, with the value Pilot uses when nothing sets them.
 */
const CARRIED_DEFAULTS: Readonly<Record<string, string>> = { claude_bin: "claude", mode: "local" };

const fromEnvironment = (name: string, environment: NodeJS.ProcessEnv) =>
  [`PILOT_${name.toUpperCase()}`, `LOOKOUT_${name.toUpperCase()}`]
    .map((key) => environment[key]?.trim())
    .find((value) => value !== undefined && value !== "");

const isSet = (name: string, config: Readonly<Record<string, unknown>>) =>
  config[name] !== undefined && config[name] !== null;

/**
 * The settings the fixed copy would lose: values the replaced Pilot uses (its
 * own `pilot config` output) that differ from what the fixed copy would read
 * from the config file, the environment or its defaults. A setting already in
 * the config file is never replaced.
 */
export const settingsToCarry = (input: {
  readonly replaced: Readonly<Record<string, unknown>>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly environment: NodeJS.ProcessEnv;
}): Record<string, string> => {
  const carry: Record<string, string> = {};
  for (const [name, fallback] of Object.entries(CARRIED_DEFAULTS)) {
    const used = input.replaced[name];
    if (typeof used !== "string" || used.trim() === "" || isSet(name, input.config)) continue;
    if (used !== (fromEnvironment(name, input.environment) ?? fallback)) carry[name] = used;
  }
  return carry;
};

/** Settings that may be lost but whose values could not be read: set neither in the config file nor the environment. */
export const unreadSettings = (
  config: Readonly<Record<string, unknown>>,
  environment: NodeJS.ProcessEnv,
) =>
  Object.keys(CARRIED_DEFAULTS).filter(
    (name) => !isSet(name, config) && fromEnvironment(name, environment) === undefined,
  );

/** The config file with `carry` added after what it holds; keys it already has keep their values. */
export const mergeConfig = (
  existing: Readonly<Record<string, unknown>>,
  carry: Readonly<Record<string, string>>,
) =>
  `${JSON.stringify(
    {
      ...existing,
      ...Object.fromEntries(Object.entries(carry).filter(([name]) => !isSet(name, existing))),
    },
    null,
    2,
  )}\n`;

/** The Node binary a Pilot launcher runs (`exec '<node>' '<boot.mjs>' "$@"`, written by Pilot's hooks), or null. */
export const launcherNode = (text: string): string | null => {
  const quoted = /^exec '((?:[^']|'\\'')*)' /m.exec(text)?.[1];
  return quoted === undefined ? null : quoted.replaceAll(`'\\''`, "'");
};

/** A path with the home folder shown as `~`. */
export const tildePath = (file: string, homeDirectory: string) =>
  file === homeDirectory
    ? "~"
    : file.startsWith(`${homeDirectory}/`)
      ? `~${file.slice(homeDirectory.length)}`
      : file;

const ClaudePluginEntry = Schema.Struct({
  id: Schema.String,
  version: Schema.optional(Schema.NullOr(Schema.String)),
  scope: Schema.optional(Schema.String),
  readFromFolder: Schema.optional(Schema.NullOr(Schema.String)),
});
const ClaudeMarketplaceEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.optional(Schema.NullOr(Schema.String)),
});
const ClaudeCommandResult = Schema.Struct({
  outcome: Schema.String,
  message: Schema.optional(Schema.String),
});
const BundleManifest = Schema.Struct({ files: Schema.Array(Schema.String) });
const PluginManifest = Schema.Struct({ name: Schema.String, version: Schema.String });
const ConfigObject = Schema.Record(Schema.String, Schema.Unknown);

const decodePlugins = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ClaudePluginEntry)),
);
const decodeMarketplaces = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ClaudeMarketplaceEntry)),
);
const decodeCommandResult = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeCommandResult));
const decodeBundleManifest = Schema.decodeUnknownOption(Schema.fromJsonString(BundleManifest));
const decodePluginManifest = Schema.decodeUnknownOption(Schema.fromJsonString(PluginManifest));
const decodeConfig = Schema.decodeUnknownOption(Schema.fromJsonString(ConfigObject));

/** The JSON result line Claude Code prints last for a `--json` change, or null. */
const commandResult = (stdout: string) => {
  for (const line of stdout.split("\n").toReversed()) {
    const decoded = decodeCommandResult(line.trim());
    if (Option.isSome(decoded)) return decoded.value;
  }
  return null;
};

/** A packaged path list entry: relative, inside the bundle, nothing unusual. */
const isBundlePath = (entry: string) =>
  /^[\w.][\w./-]*$/.test(entry) && !entry.split("/").includes("..");

const failure = (reason: PilotFailureReason, error: string): PilotInstallResponse => ({
  ok: false,
  reason,
  error: error.slice(0, MAX_ERROR_LENGTH),
});

type RunError = "unavailable" | "failed";
type Ran = Result.Result<{ readonly stdout: string; readonly exitCode: number }, RunError>;

export class PilotInstaller extends Context.Service<
  PilotInstaller,
  {
    /** Where Claude Code's Pilot comes from and what installing would change. */
    readonly status: () => Effect.Effect<PilotInstallResponse>;
    /** Copies the bundled Pilot to its fixed folder, replaces older plugins and installs it. */
    readonly install: () => Effect.Effect<PilotInstallResponse>;
    /** Removes Pilot (and Lookout) from Claude Code and stops the daemon; Pilot's own data stays. */
    readonly uninstall: () => Effect.Effect<PilotInstallResponse>;
  }
>()("@starkfuture/desktop/pilot/PilotInstaller") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = (options: { readonly bundledRoot: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const installs = yield* Semaphore.make(1);

    const readText = (file: string) =>
      fs.readFileString(file).pipe(Effect.option, Effect.map(Option.getOrUndefined));

    const readCapped = (stream: Stream.Stream<Uint8Array, unknown>) =>
      Stream.runFoldEffect(
        stream.pipe(Stream.mapError((): RunError => "failed")),
        () => ({ size: 0, chunks: [] as Uint8Array[] }),
        (acc, chunk) => {
          const size = acc.size + chunk.byteLength;
          if (size > MAX_OUTPUT_BYTES) return Effect.fail<RunError>("failed");
          acc.chunks.push(chunk);
          return Effect.succeed({ size, chunks: acc.chunks });
        },
      ).pipe(Effect.map(({ chunks }) => Buffer.concat(chunks).toString("utf8")));

    /** Runs one command without a shell; stdout, or why it could not run. */
    const run = (
      command: string,
      args: ReadonlyArray<string>,
      cwd: string,
      extraEnv: Readonly<Record<string, string>> = {},
    ): Effect.Effect<Ran> =>
      Effect.gen(function* () {
        const environment = yield* HostProcess.Environment;
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner
              .spawn(
                ChildProcess.make(command, [...args], {
                  cwd,
                  env: { ...environment, ...extraEnv, NO_COLOR: "1" },
                  stdin: "ignore",
                  killSignal: "SIGTERM",
                  forceKillAfter: "2 seconds",
                }),
              )
              .pipe(Effect.mapError((): RunError => "unavailable"));
            const [stdout, , exitCode] = yield* Effect.all(
              [
                readCapped(handle.stdout),
                handle.stderr.pipe(
                  Stream.runDrain,
                  Effect.mapError((): RunError => "failed"),
                ),
                handle.exitCode.pipe(Effect.mapError((): RunError => "failed")),
              ],
              { concurrency: "unbounded" },
            );
            return { stdout, exitCode: Number(exitCode) };
          }),
        ).pipe(Effect.timeoutOption(`${COMMAND_TIMEOUT_SECONDS} seconds`), Effect.result);
        if (Result.isFailure(outcome)) return Result.fail(outcome.failure);
        if (Option.isNone(outcome.success)) return Result.fail("failed" as const);
        return Result.succeed(outcome.success.value);
      });

    const claudeCommand = Effect.map(
      HostProcess.Environment,
      (environment) => environment.PILOT_INSTALL_CLAUDE_BIN?.trim() || "claude",
    );

    const runClaude = (args: ReadonlyArray<string>, cwd: string) =>
      Effect.flatMap(claudeCommand, (command) => run(command, args, cwd));

    /** Claude Code's plugins and marketplaces, or why they could not be read. */
    const listPlugins = (cwd: string) =>
      Effect.gen(function* () {
        const listed = yield* runClaude(claudePluginArgs.list(), cwd);
        if (Result.isFailure(listed))
          return Result.fail(
            listed.failure === "unavailable"
              ? failure(
                  "unavailable",
                  "Claude Code's `claude` command was not found. Install Claude Code, then try again.",
                )
              : failure("failed", "Claude Code did not list its plugins."),
          );
        const plugins = decodePlugins(listed.success.stdout);
        const marketplacesRun = yield* runClaude(claudePluginArgs.marketplaces(), cwd);
        const marketplaces = Result.isSuccess(marketplacesRun)
          ? decodeMarketplaces(marketplacesRun.success.stdout)
          : Option.none();
        if (Option.isNone(plugins) || Option.isNone(marketplaces))
          return Result.fail(
            failure(
              "incompatible",
              "This version of Claude Code lists plugins in a way Stark Code does not understand.",
            ),
          );
        return Result.succeed({
          plugins: plugins.value.map((entry): InstalledPlugin => ({
            id: entry.id,
            version: entry.version ?? null,
            scope: entry.scope ?? "user",
            folder: entry.readFromFolder ?? null,
          })),
          marketplaces: marketplaces.value.map((entry): KnownMarketplace => ({
            name: entry.name,
            path: entry.path ?? null,
          })),
        });
      });

    /**
     * The settings a replaced Pilot uses, from its own `pilot config`, run with
     * the Node its launcher names. Null when it cannot say. Its `.env` is
     * never opened here.
     */
    const replacedSettings = (folder: string, home: string, cwd: string) =>
      Effect.gen(function* () {
        const boot = path.join(folder, "src", "boot.mjs");
        if (!(yield* fs.exists(boot).pipe(Effect.orElseSucceed(() => false)))) return null;
        const node = launcherNode((yield* readText(path.join(home, "bin", PILOT))) ?? "") ?? "node";
        const ran = yield* run(node, [boot, "config"], cwd, { PILOT_HOME: home });
        if (Result.isFailure(ran) || ran.success.exitCode !== 0) return null;
        return Option.getOrNull(decodeConfig(ran.success.stdout));
      });

    /** Everything a status or an install needs to know, or why it cannot be known. */
    const inspect = Effect.gen(function* () {
      const environment = yield* HostProcess.Environment;
      const homeDirectory = yield* HostProcess.HomeDirectory;
      const platform = yield* HostProcess.Platform;
      const home = pilotHome(environment.PILOT_HOME, homeDirectory, path);
      const pluginRoot = path.join(home, "plugin");
      const configFile = path.join(home, "config.json");
      const config = Option.getOrElse(
        decodeConfig((yield* readText(configFile)) ?? "{}"),
        (): Readonly<Record<string, unknown>> => ({}),
      );
      const configuredBin =
        fromEnvironment("claude_bin", environment) ??
        (typeof config.claude_bin === "string" && config.claude_bin.trim()
          ? config.claude_bin.trim()
          : null);
      const profile = tildePath(
        environment.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDirectory, ".claude"),
        homeDirectory,
      );
      const base = {
        bundledVersion: null,
        installedVersion: null,
        profile,
        target: null,
        replaces: [],
        installsCopy: false,
        claudeBin: configuredBin,
        carriedSettings: [],
        missingSettings: [],
        configFile: tildePath(configFile, homeDirectory),
      } satisfies Omit<PilotInstallStatus, "state" | "note">;
      const unsupported = (note: string) =>
        ({ ok: true, value: { ...base, state: "unsupported", note } }) as const;

      if (platform === "win32") return unsupported("Pilot runs on macOS and Linux.");
      const plugin = decodePluginManifest(
        (yield* readText(path.join(options.bundledRoot, ".claude-plugin", "plugin.json"))) ?? "",
      );
      const manifest = decodeBundleManifest(
        (yield* readText(path.join(options.bundledRoot, "package.json"))) ?? "",
      );
      if (Option.isNone(plugin) || Option.isNone(manifest) || plugin.value.name !== PILOT)
        return unsupported("This build of Stark Code does not include Pilot.");
      const bundledVersion = plugin.value.version;
      const target = path.join(pluginRoot, bundledVersion);

      const listed = yield* listPlugins(homeDirectory);
      if (Result.isFailure(listed)) return listed.failure;
      const pluginRoots = [pluginRoot];
      const realRoot = yield* fs.realPath(pluginRoot).pipe(Effect.option);
      if (Option.isSome(realRoot) && realRoot.value !== pluginRoot)
        pluginRoots.push(realRoot.value);
      const plan = planPilotInstall({ ...listed.success, bundledVersion, pluginRoots, target });

      // A replaced checkout may take settings from its own .env, which the fixed copy does not
      // have: ask that Pilot what it uses and carry over what the fixed copy would lose.
      const carry: Record<string, string> = {};
      const missing = new Set<string>();
      const cwd = (yield* fs.exists(home).pipe(Effect.orElseSucceed(() => false)))
        ? home
        : homeDirectory;
      for (const replaced of plan.replaces) {
        if (replaced.source === null) continue;
        const used = yield* replacedSettings(replaced.source, home, cwd);
        if (used === null) {
          // It cannot say what it uses; only a .env there could hold settings the copy would lose.
          if (
            yield* fs
              .exists(path.join(replaced.source, ".env"))
              .pipe(Effect.orElseSucceed(() => false))
          )
            for (const name of unreadSettings(config, environment)) missing.add(name);
          continue;
        }
        for (const [name, value] of Object.entries(
          settingsToCarry({ replaced: used, config, environment }),
        ))
          carry[name] ??= value;
      }

      const value: PilotInstallStatus = {
        ...base,
        state: plan.state,
        bundledVersion,
        installedVersion: plan.installedVersion,
        target: tildePath(target, homeDirectory),
        replaces: plan.replaces.map((replaced) => ({
          id: replaced.id,
          version: replaced.version,
          source: replaced.source === null ? null : tildePath(replaced.source, homeDirectory),
        })),
        installsCopy: plan.installCopy,
        claudeBin: configuredBin ?? carry.claude_bin ?? null,
        carriedSettings: Object.keys(carry).sort(),
        missingSettings: [...missing].filter((name) => carry[name] === undefined).sort(),
        note: null,
      };
      return {
        ok: true,
        value,
        plan,
        carry,
        files: manifest.value.files,
        home,
        pluginRoot,
        configFile,
        target,
      } as const;
    });

    /** Writes the bundled files to `target` through a fresh sibling folder, so readers never see half a copy. */
    const writeCopy = (files: ReadonlyArray<string>, pluginRoot: string, target: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(pluginRoot, { recursive: true, mode: 0o700 });
        const fresh = yield* fs.makeTempDirectory({
          directory: pluginRoot,
          prefix: `.${path.basename(target)}-`,
        });
        yield* Effect.gen(function* () {
          for (const entry of ["package.json", ...files.filter(isBundlePath)]) {
            const destination = path.join(fresh, entry);
            yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
            yield* fs.copy(path.join(options.bundledRoot, entry), destination);
          }
          if (yield* fs.exists(target)) {
            const old = `${fresh}.old`;
            yield* fs.rename(target, old);
            yield* fs.rename(fresh, target);
            yield* fs.remove(old, { recursive: true }).pipe(Effect.ignore);
          } else {
            yield* fs.rename(fresh, target);
          }
        }).pipe(
          Effect.onError(() =>
            fs.remove(fresh, { recursive: true, force: true }).pipe(Effect.ignore),
          ),
        );
      }).pipe(Effect.mapError(() => "Stark Code could not copy Pilot to its folder."));

    /** Adds `carry` to Pilot's config file, keeping every key it has; written whole, then moved into place. */
    const writeSettings = (configFile: string, carry: Readonly<Record<string, string>>) =>
      Effect.gen(function* () {
        const text = yield* readText(configFile);
        const existing = text === undefined ? Option.some({}) : decodeConfig(text);
        if (Option.isNone(existing))
          return yield* Effect.fail(
            `${path.basename(configFile)} is not valid JSON. Fix it, then install again.`,
          );
        const next = `${configFile}.stark-code.tmp`;
        yield* Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(configFile), { recursive: true, mode: 0o700 });
          yield* fs.writeFileString(next, mergeConfig(existing.value, carry), { mode: 0o600 });
          yield* fs.rename(next, configFile);
        }).pipe(Effect.mapError(() => "Stark Code could not write Pilot's settings."));
      });

    /** One plugin change; its error in plain words, or nothing. */
    const change = (args: ReadonlyArray<string>, cwd: string, what: string) =>
      Effect.gen(function* () {
        const ran = yield* runClaude(args, cwd);
        if (Result.isFailure(ran)) return `Claude Code could not ${what}.`;
        const result = commandResult(ran.success.stdout);
        if (result?.outcome === "ok") return null;
        const message = result?.message?.trim();
        return `Claude Code could not ${what}${message ? `: ${message}` : "."}`;
      });

    /** Asks a running daemon to finish its work and stop; the next Claude Code session starts the installed copy. */
    const stopDaemon = (home: string) =>
      Effect.gen(function* () {
        const launcher = path.join(home, "bin", PILOT);
        if (yield* fs.exists(launcher).pipe(Effect.orElseSucceed(() => false)))
          yield* run(launcher, ["stop"], home, { PILOT_HOME: home });
      });

    const settled = (seen: Effect.Success<typeof inspect>): PilotInstallResponse =>
      seen.ok ? { ok: true, value: seen.value } : seen;

    const install = Effect.gen(function* () {
      const seen = yield* inspect;
      if (!seen.ok || !("plan" in seen)) return settled(seen);
      const { value, plan, carry, files, home, pluginRoot, configFile, target } = seen;
      if (value.state === "installed") return settled(seen);
      if (value.missingSettings.length > 0) {
        const names = value.missingSettings;
        const list =
          names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
        return failure(
          "invalid",
          `First add ${list} to ${value.configFile}: Stark Code could not read ${names.length === 1 ? "it" : "them"} from the Pilot being replaced.`,
        );
      }

      const prepared = yield* Effect.gen(function* () {
        if (plan.installCopy) yield* writeCopy(files, pluginRoot, target);
        else
          yield* fs
            .makeDirectory(pluginRoot, { recursive: true, mode: 0o700 })
            .pipe(Effect.mapError(() => "Stark Code could not create Pilot's plugin folder."));
        if (Object.keys(carry).length > 0) yield* writeSettings(configFile, carry);
      }).pipe(Effect.result);
      if (Result.isFailure(prepared)) return failure("failed", prepared.failure);

      const removed = plan.uninstall.length > 0 || plan.removeMarketplaces.length > 0;
      for (const id of plan.uninstall) {
        const error = yield* change(claudePluginArgs.uninstall(id), pluginRoot, `remove ${id}`);
        if (error) return failure("failed", error);
      }
      for (const name of plan.removeMarketplaces) {
        const error = yield* change(
          claudePluginArgs.removeMarketplace(name),
          pluginRoot,
          `remove the ${name} marketplace`,
        );
        if (error) return failure("failed", error);
      }
      if (plan.installCopy) {
        const error = yield* change(claudePluginArgs.install(target), pluginRoot, "install Pilot");
        if (error)
          return failure(
            "failed",
            removed ? `${error} The older Pilot was already removed; install again.` : error,
          );
        yield* stopDaemon(home);
      }

      const after = yield* inspect;
      if (after.ok && after.value.state !== "installed")
        return failure("failed", "Claude Code did not report the installed Pilot. Try again.");
      return settled(after);
    });

    const uninstall = Effect.gen(function* () {
      const environment = yield* HostProcess.Environment;
      const homeDirectory = yield* HostProcess.HomeDirectory;
      const home = pilotHome(environment.PILOT_HOME, homeDirectory, path);
      // Run from Pilot's home, so no project's Claude Code settings are in reach.
      const ready = yield* fs
        .makeDirectory(home, { recursive: true, mode: 0o700 })
        .pipe(Effect.result);
      if (Result.isFailure(ready))
        return failure("failed", "Stark Code could not reach Pilot's folder.");
      const listed = yield* listPlugins(home);
      if (Result.isFailure(listed)) return listed.failure;
      const removal = planPilotUninstall(listed.success);
      for (const id of removal.uninstall) {
        const error = yield* change(claudePluginArgs.uninstall(id), home, `remove ${id}`);
        if (error) return failure("failed", error);
      }
      for (const name of removal.removeMarketplaces) {
        const error = yield* change(
          claudePluginArgs.removeMarketplace(name),
          home,
          `remove the ${name} marketplace`,
        );
        if (error) return failure("failed", error);
      }
      yield* stopDaemon(home);
      return settled(yield* inspect);
    });

    return PilotInstaller.of({
      status: () => inspect.pipe(Effect.map(settled), Effect.withSpan("PilotInstaller.status")),
      install: () => installs.withPermit(install).pipe(Effect.withSpan("PilotInstaller.install")),
      uninstall: () =>
        installs.withPermit(uninstall).pipe(Effect.withSpan("PilotInstaller.uninstall")),
    });
  });

export const layer = (options: { readonly bundledRoot: string }) =>
  Layer.effect(PilotInstaller, make(options));
