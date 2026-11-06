import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  claudePluginArgs,
  compareVersions,
  launcherNode,
  make,
  mergeConfig,
  planPilotInstall,
  planPilotUninstall,
  settingsToCarry,
  unreadSettings,
  type InstalledPlugin,
  type KnownMarketplace,
} from "./PilotInstaller.ts";

const ROOT = "/Users/me/.pilot/plugin";
const TARGET = `${ROOT}/0.4.0`;
const plan = (plugins: InstalledPlugin[], marketplaces: KnownMarketplace[] = []) =>
  planPilotInstall({
    plugins,
    marketplaces,
    bundledVersion: "0.4.0",
    pluginRoots: [ROOT],
    target: TARGET,
  });
const plugin = (id: string, folder: string | null, version = "0.3.0", scope = "user") => ({
  id,
  version,
  scope,
  folder,
});

describe("compareVersions", () => {
  it("orders versions by number, with a pre-release before its release", () => {
    expect(compareVersions("0.3.0", "0.4.0")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBe(1);
  });
});

describe("planPilotInstall", () => {
  it("installs a fresh copy when Claude Code has no Pilot", () => {
    expect(plan([plugin("codex@openai-codex", null)])).toEqual({
      state: "not-installed",
      installedVersion: null,
      replaces: [],
      uninstall: [],
      removeMarketplaces: [],
      installCopy: true,
    });
  });

  it("replaces a Pilot read from a working checkout and frees the pilot marketplace", () => {
    const result = plan(
      [plugin("pilot@pilot", "/Users/me/work/dev-copilot")],
      [{ name: "pilot", path: "/Users/me/work/dev-copilot" }],
    );
    expect(result).toMatchObject({
      state: "legacy",
      installedVersion: null,
      uninstall: ["pilot@pilot"],
      removeMarketplaces: ["pilot"],
      installCopy: true,
    });
    expect(result.replaces).toEqual([
      {
        ...plugin("pilot@pilot", "/Users/me/work/dev-copilot"),
        source: "/Users/me/work/dev-copilot",
      },
    ]);
  });

  it("removes Lookout beside a current fixed copy without reinstalling Pilot", () => {
    const result = plan(
      [plugin("lookout@lookout", null, "0.2.0"), plugin("pilot@pilot", TARGET, "0.4.0")],
      [
        { name: "lookout", path: "/Users/me/work/lookout" },
        { name: "pilot", path: TARGET },
      ],
    );
    expect(result).toMatchObject({
      state: "legacy",
      installedVersion: "0.4.0",
      uninstall: ["lookout@lookout"],
      removeMarketplaces: ["lookout"],
      installCopy: false,
    });
    // Lookout's folder comes from its marketplace when the plugin list does not name one.
    expect(result.replaces[0]?.source).toBe("/Users/me/work/lookout");
  });

  it("updates an older fixed copy and keeps a newer or equal one", () => {
    const older = `${ROOT}/0.3.0`;
    expect(plan([plugin("pilot@pilot", older)], [{ name: "pilot", path: older }])).toMatchObject({
      state: "update",
      installedVersion: "0.3.0",
      uninstall: ["pilot@pilot"],
      removeMarketplaces: ["pilot"],
      installCopy: true,
    });
    for (const version of ["0.4.0", "0.5.0"]) {
      const folder = `${ROOT}/${version}`;
      expect(
        plan([plugin("pilot@pilot", folder, version)], [{ name: "pilot", path: folder }]),
      ).toEqual({
        state: "installed",
        installedVersion: version,
        replaces: [],
        uninstall: [],
        removeMarketplaces: [],
        installCopy: false,
      });
    }
  });

  it("leaves shared marketplaces and other scopes alone", () => {
    const result = plan(
      [
        plugin("pilot@team-skills", null),
        plugin("pilot@pilot", "/Users/me/repo", "0.3.0", "project"),
        plugin("pilot-tools@team-skills", null),
      ],
      [{ name: "team-skills", path: null }],
    );
    expect(result).toMatchObject({
      state: "legacy",
      uninstall: ["pilot@team-skills"],
      removeMarketplaces: [],
      installCopy: true,
    });
  });

  it("frees a leftover pilot marketplace from another folder, but not the target itself", () => {
    expect(plan([], [{ name: "pilot", path: "/Users/me/work/dev-copilot" }])).toMatchObject({
      state: "not-installed",
      removeMarketplaces: ["pilot"],
    });
    expect(plan([], [{ name: "pilot", path: TARGET }])).toMatchObject({
      state: "not-installed",
      removeMarketplaces: [],
    });
  });

  it("recognizes a fixed copy reported through the folder's real path", () => {
    const result = planPilotInstall({
      plugins: [plugin("pilot@pilot", "/private/tmp/h/.pilot/plugin/0.4.0", "0.4.0")],
      marketplaces: [],
      bundledVersion: "0.4.0",
      pluginRoots: ["/tmp/h/.pilot/plugin", "/private/tmp/h/.pilot/plugin"],
      target: "/tmp/h/.pilot/plugin/0.4.0",
    });
    expect(result.state).toBe("installed");
  });
});

describe("claudePluginArgs", () => {
  it("changes only user scope and asks for one JSON result line", () => {
    expect(claudePluginArgs.list()).toEqual(["plugin", "list", "--json"]);
    expect(claudePluginArgs.marketplaces()).toEqual(["plugin", "marketplace", "list", "--json"]);
    expect(claudePluginArgs.uninstall("lookout@lookout")).toEqual([
      "plugin",
      "uninstall",
      "lookout@lookout",
      "--scope",
      "user",
      "--json",
    ]);
    expect(claudePluginArgs.removeMarketplace("pilot")).toEqual([
      "plugin",
      "marketplace",
      "remove",
      "pilot",
      "--json",
    ]);
    expect(claudePluginArgs.install(TARGET)).toEqual([
      "plugin",
      "install",
      "pilot",
      "--marketplace",
      TARGET,
      "--scope",
      "user",
      "--json",
    ]);
  });
});

describe("planPilotUninstall", () => {
  it("removes every user-scope Pilot and Lookout, and only Pilot's own marketplaces", () => {
    expect(
      planPilotUninstall({
        plugins: [
          plugin("pilot@pilot", TARGET),
          plugin("lookout@lookout", null),
          plugin("pilot@pilot", "/repo", "0.3.0", "project"),
          plugin("codex@openai-codex", null),
        ],
        marketplaces: [
          { name: "pilot", path: TARGET },
          { name: "lookout", path: null },
          { name: "team-skills", path: null },
        ],
      }),
    ).toEqual({
      uninstall: ["pilot@pilot", "lookout@lookout"],
      removeMarketplaces: ["pilot", "lookout"],
    });
  });
});

describe("carrying settings", () => {
  it("carries what the replaced Pilot uses and the fixed copy would not, never over the config file", () => {
    const replaced = { claude_bin: "/opt/claude-wrapper", mode: "local", engine: "codex" };
    expect(settingsToCarry({ replaced, config: {}, environment: {} })).toEqual({
      claude_bin: "/opt/claude-wrapper",
    });
    expect(
      settingsToCarry({ replaced: { ...replaced, mode: "offline" }, config: {}, environment: {} }),
    ).toEqual({
      claude_bin: "/opt/claude-wrapper",
      mode: "offline",
    });
    // Already in the config file, or already what the environment gives the fixed copy.
    expect(
      settingsToCarry({ replaced, config: { claude_bin: "claude-personal" }, environment: {} }),
    ).toEqual({});
    expect(
      settingsToCarry({
        replaced,
        config: {},
        environment: { LOOKOUT_CLAUDE_BIN: "/opt/claude-wrapper" },
      }),
    ).toEqual({});
    expect(
      settingsToCarry({
        replaced: { claude_bin: "claude", mode: "local" },
        config: {},
        environment: {},
      }),
    ).toEqual({});
  });

  it("names the settings it cannot read unless something else sets them", () => {
    expect(unreadSettings({}, {})).toEqual(["claude_bin", "mode"]);
    expect(unreadSettings({ mode: "local" }, { PILOT_CLAUDE_BIN: "c" })).toEqual([]);
  });

  it("adds carried settings after the config file's own and keeps its values", () => {
    expect(
      mergeConfig(
        { nudge_to_session: "all", mode: "offline" },
        { claude_bin: "/opt/w", mode: "local" },
      ),
    ).toBe('{\n  "nudge_to_session": "all",\n  "mode": "offline",\n  "claude_bin": "/opt/w"\n}\n');
  });

  it("reads the Node a launcher runs, quotes included", () => {
    expect(
      launcherNode(
        "#!/bin/sh\n# Written by Pilot\nexec '/opt/node 22/bin/node' '/x/src/boot.mjs' \"$@\"\n",
      ),
    ).toBe("/opt/node 22/bin/node");
    expect(launcherNode(`exec '/it'\\''s/node' '/x/boot.mjs' "$@"`)).toBe("/it's/node");
    expect(launcherNode("#!/bin/sh\nexit 0\n")).toBeNull();
  });
});

/**
 * A `claude` that keeps a plugin list and changes it like Claude Code does,
 * and a replaced Pilot whose `pilot config` prints `replacedConfig`.
 * Every run is recorded.
 */
const fakeClaude = (initial: {
  plugins: Array<Record<string, unknown>>;
  marketplaces: Array<Record<string, unknown>>;
  replacedConfig?: string;
}) => {
  const state = structuredClone(initial);
  const calls: Array<{
    command: string;
    args: ReadonlyArray<string>;
    cwd?: string;
    env: Record<string, string | undefined>;
  }> = [];
  const reply = (args: ReadonlyArray<string>): string => {
    const [, sub, a, b] = args;
    if (sub === "list") return JSON.stringify(state.plugins);
    if (sub === "marketplace" && a === "list") return JSON.stringify(state.marketplaces);
    if (sub === "uninstall") {
      state.plugins = state.plugins.filter((entry) => entry.id !== a);
      return JSON.stringify({ command: "uninstall", outcome: "ok" });
    }
    if (sub === "marketplace" && a === "remove") {
      state.marketplaces = state.marketplaces.filter((entry) => entry.name !== b);
      state.plugins = state.plugins.filter((entry) => !String(entry.id).endsWith(`@${b}`));
      return JSON.stringify({ command: "marketplace-remove", outcome: "ok" });
    }
    if (sub === "install") {
      const folder = args[args.indexOf("--marketplace") + 1]!;
      if (state.marketplaces.some((entry) => entry.name === "pilot" && entry.path !== folder))
        return `${JSON.stringify({ command: "install", outcome: "failed", message: 'Marketplace "pilot" is already added from a different source.' })}\n`;
      state.marketplaces.push({ name: "pilot", source: "directory", path: folder });
      state.plugins.push({
        id: "pilot@pilot",
        version: folder.split("/").pop(),
        scope: "user",
        enabled: true,
        readFromFolder: folder,
      });
      return `Installing…\n${JSON.stringify({ command: "install", outcome: "ok" })}\n`;
    }
    return "";
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const { command: file, args, options } = command as ChildProcess.StandardCommand;
      calls.push({
        command: file,
        args,
        ...(typeof options.cwd === "string" ? { cwd: options.cwd } : {}),
        env: (options.env ?? {}) as Record<string, string | undefined>,
      });
      const stdout =
        file === "claude" ? reply(args) : args[1] === "config" ? (state.replacedConfig ?? "") : "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { state, calls, spawner };
};

const NODE = "/opt/hooks node/bin/node";

/**
 * A home folder with a bundled Pilot 0.4.0, a checkout of an older Pilot with
 * a `.env`, a launcher that names the hooks' Node, and the installer reading them.
 */
const setup = (fake: ReturnType<typeof fakeClaude>, configJson?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDirectory = yield* fs.makeTempDirectoryScoped();
    const bundle = path.join(homeDirectory, "bundle");
    const write = (file: string, text: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, text);
      });
    yield* write(
      path.join(bundle, "package.json"),
      JSON.stringify({
        name: "@starkfuture/pilot",
        files: [".claude-plugin", "hooks", "src", "../outside"],
      }),
    );
    yield* write(
      path.join(bundle, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "pilot", version: "0.4.0" }),
    );
    yield* write(path.join(bundle, "hooks", "hooks.json"), '{"hooks":{"PreToolUse":[]}}');
    yield* write(path.join(bundle, "src", "boot.mjs"), "// boot\n");
    yield* write(path.join(bundle, "test", "pilot.test.ts"), "// not shipped\n");
    yield* write(path.join(bundle, ".env"), "PILOT_MODE=offline\n");
    const pilotHome = path.join(homeDirectory, ".pilot");
    if (configJson !== undefined) yield* write(path.join(pilotHome, "config.json"), configJson);
    const checkout = path.join(homeDirectory, "work", "dev-copilot");
    yield* write(path.join(checkout, "src", "boot.mjs"), "// the older Pilot\n");
    yield* write(path.join(checkout, ".env"), "# settings the test never reads\n");
    const launcher = path.join(pilotHome, "bin", "pilot");
    yield* write(launcher, `#!/bin/sh\nexec '${NODE}' '${checkout}/src/boot.mjs' "$@"\n`);

    const installer = yield* make({ bundledRoot: bundle }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
    );
    const within = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(HostProcess.Environment, {
          PATH: "/usr/bin",
          CLAUDE_CONFIG_DIR: path.join(homeDirectory, "claude-profile"),
        }),
        Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
    return { installer, within, homeDirectory, pilotHome, checkout, launcher, fs, path };
  });

const fromCheckout = (checkout: string) => ({
  id: "pilot@pilot",
  version: "0.3.0",
  scope: "user",
  readFromFolder: checkout,
});
const WRAPPER_CONFIG = JSON.stringify({ claude_bin: "/opt/claude-wrapper", mode: "local" });

it.layer(NodeServices.layer)("PilotInstaller", (it) => {
  it.effect(
    "reports a checkout install and the settings it would carry, read from its own config",
    () =>
      Effect.gen(function* () {
        const fake = fakeClaude({ plugins: [], marketplaces: [], replacedConfig: WRAPPER_CONFIG });
        const { installer, within, checkout, pilotHome } = yield* setup(fake);
        fake.state.plugins.push(fromCheckout(checkout));
        fake.state.marketplaces.push({ name: "pilot", source: "directory", path: checkout });

        expect(yield* within(installer.status())).toEqual({
          ok: true,
          value: {
            state: "legacy",
            bundledVersion: "0.4.0",
            installedVersion: null,
            profile: "~/claude-profile",
            target: "~/.pilot/plugin/0.4.0",
            replaces: [{ id: "pilot@pilot", version: "0.3.0", source: "~/work/dev-copilot" }],
            installsCopy: true,
            claudeBin: "/opt/claude-wrapper",
            carriedSettings: ["claude_bin"],
            missingSettings: [],
            configFile: "~/.pilot/config.json",
            note: null,
          },
        });
        // Reading the status changes nothing; the older Pilot is asked with its hooks' Node.
        expect(fake.calls.map((call) => [call.command, ...call.args.slice(0, 3)])).toEqual([
          ["claude", "plugin", "list", "--json"],
          ["claude", "plugin", "marketplace", "list"],
          [NODE, `${checkout}/src/boot.mjs`, "config"],
        ]);
        expect(fake.calls[2]?.env.PILOT_HOME).toBe(pilotHome);
        expect(fake.calls[0]?.env.CLAUDE_CONFIG_DIR).toMatch(/claude-profile$/);
      }).pipe(Effect.scoped),
  );

  it.effect("waits when the older Pilot cannot say what it uses and keeps a .env", () =>
    Effect.gen(function* () {
      const fake = fakeClaude({ plugins: [], marketplaces: [], replacedConfig: "Error: boom" });
      const { installer, within, checkout, fs, pilotHome } = yield* setup(fake);
      fake.state.plugins.push(fromCheckout(checkout));

      expect(yield* within(installer.status())).toMatchObject({
        ok: true,
        value: { carriedSettings: [], missingSettings: ["claude_bin", "mode"], claudeBin: null },
      });
      expect(yield* within(installer.install())).toMatchObject({
        ok: false,
        reason: "invalid",
        error: expect.stringContaining("First add claude_bin and mode to ~/.pilot/config.json:"),
      });
      expect(
        fake.calls
          .filter((call) => call.command === "claude")
          .every((call) => call.args.includes("list")),
      ).toBe(true);
      expect(yield* fs.exists(`${pilotHome}/plugin`)).toBe(false);
      expect(yield* fs.exists(`${pilotHome}/config.json`)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "copies the shipped files, carries settings, replaces the checkout and Lookout, then installs",
    () =>
      Effect.gen(function* () {
        const fake = fakeClaude({ plugins: [], marketplaces: [], replacedConfig: WRAPPER_CONFIG });
        const { installer, within, checkout, fs, path, pilotHome, launcher } = yield* setup(
          fake,
          JSON.stringify({ nudge_to_session: "all" }),
        );
        fake.state.plugins.push(
          { id: "lookout@lookout", version: "0.2.0", scope: "user", readFromFolder: null },
          fromCheckout(checkout),
        );
        fake.state.marketplaces.push(
          { name: "lookout", source: "directory", path: "/elsewhere/lookout" },
          { name: "pilot", source: "directory", path: checkout },
        );

        expect(yield* within(installer.install())).toMatchObject({
          ok: true,
          value: {
            state: "installed",
            installedVersion: "0.4.0",
            replaces: [],
            claudeBin: "/opt/claude-wrapper",
            carriedSettings: [],
          },
        });

        // Settings are added to the config file, which keeps what it had.
        expect(JSON.parse(yield* fs.readFileString(path.join(pilotHome, "config.json")))).toEqual({
          nudge_to_session: "all",
          claude_bin: "/opt/claude-wrapper",
        });
        const target = path.join(pilotHome, "plugin", "0.4.0");
        const changes = fake.calls.filter(
          (call) => !call.args.includes("list") && !call.args.includes("config"),
        );
        expect(changes.map((call) => [call.command, ...call.args])).toEqual([
          ["claude", ...claudePluginArgs.uninstall("lookout@lookout")],
          ["claude", ...claudePluginArgs.uninstall("pilot@pilot")],
          ["claude", ...claudePluginArgs.removeMarketplace("lookout")],
          ["claude", ...claudePluginArgs.removeMarketplace("pilot")],
          ["claude", ...claudePluginArgs.install(target)],
          [launcher, "stop"],
        ]);
        expect(
          changes.every(
            (call) => call.cwd === path.join(pilotHome, "plugin") || call.args[0] === "stop",
          ),
        ).toBe(true);

        expect((yield* fs.readDirectory(target, { recursive: true })).sort()).toEqual([
          ".claude-plugin",
          ".claude-plugin/plugin.json",
          "hooks",
          "hooks/hooks.json",
          "package.json",
          "src",
          "src/boot.mjs",
        ]);
        // No half-written folders are left beside it.
        expect(yield* fs.readDirectory(path.join(pilotHome, "plugin"))).toEqual(["0.4.0"]);
      }).pipe(Effect.scoped),
  );

  it.effect("does nothing when the current fixed copy is installed", () =>
    Effect.gen(function* () {
      const fake = fakeClaude({ plugins: [], marketplaces: [] });
      const { installer, within, pilotHome, path } = yield* setup(fake);
      const target = path.join(pilotHome, "plugin", "0.4.0");
      fake.state.plugins.push({
        id: "pilot@pilot",
        version: "0.4.0",
        scope: "user",
        readFromFolder: target,
      });
      fake.state.marketplaces.push({ name: "pilot", source: "directory", path: target });

      expect(yield* within(installer.install())).toMatchObject({
        ok: true,
        value: { state: "installed" },
      });
      expect(fake.calls.every((call) => call.args.includes("list"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("uninstalls Pilot and Lookout, stops the daemon and keeps Pilot's data", () =>
    Effect.gen(function* () {
      const fake = fakeClaude({ plugins: [], marketplaces: [] });
      const { installer, within, pilotHome, path, fs, launcher } = yield* setup(
        fake,
        JSON.stringify({ claude_bin: "claude-personal" }),
      );
      const target = path.join(pilotHome, "plugin", "0.4.0");
      yield* fs.makeDirectory(target, { recursive: true });
      fake.state.plugins.push(
        { id: "pilot@pilot", version: "0.4.0", scope: "user", readFromFolder: target },
        { id: "lookout@lookout", version: "0.2.0", scope: "user", readFromFolder: null },
      );
      fake.state.marketplaces.push(
        { name: "pilot", source: "directory", path: target },
        { name: "team-skills", source: "github", path: null },
      );

      expect(yield* within(installer.uninstall())).toMatchObject({
        ok: true,
        value: { state: "not-installed", installedVersion: null },
      });
      const changes = fake.calls.filter((call) => !call.args.includes("list"));
      expect(changes.map((call) => [call.command, ...call.args])).toEqual([
        ["claude", ...claudePluginArgs.uninstall("pilot@pilot")],
        ["claude", ...claudePluginArgs.uninstall("lookout@lookout")],
        ["claude", ...claudePluginArgs.removeMarketplace("pilot")],
        [launcher, "stop"],
      ]);
      expect(changes.every((call) => call.cwd === pilotHome)).toBe(true);
      expect(fake.state.marketplaces.map((entry) => entry.name)).toEqual(["team-skills"]);
      for (const kept of ["config.json", "bin/pilot", "plugin/0.4.0"])
        expect(yield* fs.exists(path.join(pilotHome, kept))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a build without Pilot, Windows, and a missing claude command", () =>
    Effect.gen(function* () {
      const fake = fakeClaude({ plugins: [], marketplaces: [] });
      const { within, homeDirectory } = yield* setup(fake);
      const noBundle = yield* make({ bundledRoot: `${homeDirectory}/missing` }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      expect(yield* within(noBundle.status())).toMatchObject({
        ok: true,
        value: { state: "unsupported", note: "This build of Stark Code does not include Pilot." },
      });

      const { installer } = yield* setup(fake);
      expect(
        yield* within(
          installer.status().pipe(Effect.provideService(HostProcess.Platform, "win32")),
        ),
      ).toMatchObject({
        ok: true,
        value: { state: "unsupported", note: "Pilot runs on macOS and Linux." },
      });

      const missing = ChildProcessSpawner.make(() => Effect.fail(new Error("ENOENT") as never));
      const noClaude = yield* make({ bundledRoot: `${homeDirectory}/bundle` }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, missing),
      );
      expect(yield* within(noClaude.status())).toMatchObject({ ok: false, reason: "unavailable" });
    }).pipe(Effect.scoped),
  );
});
