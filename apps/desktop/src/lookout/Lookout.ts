import {
  LOOKOUT_ASK_MAX_LENGTH,
  LOOKOUT_NOTE_MAX_LENGTH,
  LookoutActivity,
  LookoutAnswer,
  LookoutChat,
  LookoutDecision,
  LookoutFindings,
  LookoutNudgeResult,
  LookoutPauseState,
  LookoutStatus,
  type LookoutActivityInput,
  type LookoutAskInput,
  type LookoutCancelAskResult,
  type LookoutChatInput,
  type LookoutDecideInput,
  type LookoutFailureReason,
  type LookoutFindingsInput,
  type LookoutNudgeInput,
  type LookoutPauseInput,
  type LookoutResponse,
} from "@starkfuture/contracts";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
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

// Lookout is a separate reviewer installed on this Mac. Its stable launcher
// `$LOOKOUT_HOME/bin/lookout` answers `lookout api <method>` with one JSON
// object on stdout (API version 1). The renderer never chooses the binary or
// its arguments; this service builds both and decodes the answer strictly.
// Output can quote source code, so it is never logged.

const API_VERSION = 1;
const TIMEOUT_SECONDS = 10;
/** Lookout answers a question within 60 seconds or reports its own timeout; allow for its start-up. */
const ASK_TIMEOUT_SECONDS = 70;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_LENGTH = 500;
/** Matches Lookout's `<repo>#<id>` handle; the repository part is a name, key or path. */
const FINDING_REF = /^[^#\r\n]{1,200}#\d{1,9}$/;

type Flags = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * The argv for one API call. Values are always attached as `--name=value`, so a
 * note or repository name that starts with "-" can never be read as a flag.
 */
const lookoutArgs = (method: string, flags: Flags = {}): string[] => {
  const args = ["api", method];
  for (const [name, value] of Object.entries(flags)) {
    if (value === undefined || value === false) continue;
    args.push(value === true ? `--${name}` : `--${name}=${value}`);
  }
  return args;
};

/** Why a question cannot be sent, in words for the panel, or null when it can. */
export const askInputError = (input: LookoutAskInput): string | null => {
  if (input.text.trim().length === 0) return "Write a question first.";
  if (input.text.length > LOOKOUT_ASK_MAX_LENGTH)
    return `Keep the question under ${LOOKOUT_ASK_MAX_LENGTH} characters.`;
  // A command-line argument cannot carry a NUL character.
  if (input.text.includes("\0")) return "The question contains a character Lookout cannot read.";
  return null;
};

/** Why a decision cannot be sent, in words for the panel, or null when it can. */
export const decideInputError = (input: LookoutDecideInput): string | null => {
  if (!FINDING_REF.test(input.ref)) return "That finding reference is not valid.";
  const note = input.note?.trim() ?? "";
  if (input.action !== "reopen" && note.length === 0)
    return `Add a short reason to ${input.action} this finding.`;
  if (note.length > LOOKOUT_NOTE_MAX_LENGTH)
    return `Keep the reason under ${LOOKOUT_NOTE_MAX_LENGTH} characters.`;
  if (input.until !== undefined && Number.isNaN(Date.parse(input.until)))
    return "The defer date is not a valid date.";
  return null;
};

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const fail = (reason: LookoutFailureReason, error: string) =>
  ({ installed: true, ok: false, reason, error: error.slice(0, MAX_ERROR_LENGTH) }) as const;

/**
 * Turns one finished `lookout api` run into a response. Exit 1 with
 * `{"api":1,"error":…}` is Lookout's own error; any other shape is
 * reported without forwarding the raw output.
 */
const interpretLookoutOutput = <A>(
  decode: (value: unknown) => Option.Option<A>,
  stdout: string,
  exitCode: number,
): LookoutResponse<A> => {
  // `/bin/sh` reports a missing `node` for the launcher's `exec node …` as 127.
  if (exitCode === 127)
    return fail(
      "unavailable",
      "Lookout could not start. Check that Node.js 22.18 or newer is on your PATH.",
    );
  const parsed = parseJson(stdout);
  if (Option.isNone(parsed))
    return fail(
      "failed",
      exitCode === 0
        ? "Lookout answered with something the app could not read."
        : `Lookout stopped with exit code ${exitCode}.`,
    );
  const body = parsed.value;
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return fail("failed", "Lookout answered with something the app could not read.");
  const { api, error } = body as { api?: unknown; error?: unknown };
  if (api !== API_VERSION)
    return fail(
      "incompatible",
      "This Lookout version speaks a different API. Update Lookout or Stark Code.",
    );
  if (typeof error === "string")
    return fail("failed", error.trim() || "Lookout reported an error.");
  if (exitCode !== 0) return fail("failed", `Lookout stopped with exit code ${exitCode}.`);
  const value = decode(body);
  return Option.isSome(value)
    ? { installed: true, ok: true, value: value.value }
    : fail(
        "incompatible",
        "Lookout sent data this version of Stark Code does not understand. Update Stark Code.",
      );
};

/** `LOOKOUT_HOME` with a leading `~` expanded, like Lookout itself resolves it. */
const lookoutHome = (
  configured: string | undefined,
  homeDirectory: string,
  path: Path.Path,
): string => {
  const value = configured?.trim() || "~/.lookout";
  const expanded =
    value === "~"
      ? homeDirectory
      : value.startsWith("~/")
        ? path.join(homeDirectory, value.slice(2))
        : value;
  return path.resolve(homeDirectory, expanded);
};

type Outcome = { readonly stdout: string; readonly exitCode: number };
type RunError = "unavailable" | "too-large" | "failed";

export class Lookout extends Context.Service<
  Lookout,
  {
    readonly status: () => Effect.Effect<LookoutResponse<LookoutStatus>>;
    readonly findings: (
      input: LookoutFindingsInput,
    ) => Effect.Effect<LookoutResponse<LookoutFindings>>;
    readonly activity: (
      input: LookoutActivityInput,
    ) => Effect.Effect<LookoutResponse<LookoutActivity>>;
    readonly decide: (input: LookoutDecideInput) => Effect.Effect<LookoutResponse<LookoutDecision>>;
    readonly pause: (input: LookoutPauseInput) => Effect.Effect<LookoutResponse<LookoutPauseState>>;
    readonly resume: (
      input: LookoutPauseInput,
    ) => Effect.Effect<LookoutResponse<LookoutPauseState>>;
    readonly chat: (input: LookoutChatInput) => Effect.Effect<LookoutResponse<LookoutChat>>;
    /** One question at a time: a new question, or `cancelAsk`, stops the one in flight. */
    readonly ask: (input: LookoutAskInput) => Effect.Effect<LookoutResponse<LookoutAnswer>>;
    readonly cancelAsk: () => Effect.Effect<LookoutCancelAskResult>;
    readonly nudge: (
      input: LookoutNudgeInput,
    ) => Effect.Effect<LookoutResponse<LookoutNudgeResult>>;
  }
>()("@starkfuture/desktop/lookout/Lookout") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Decisions and pauses write Lookout's databases; send them one at a time.
  const mutations = yield* Semaphore.make(1);
  const reads = new Map<string, Deferred.Deferred<LookoutResponse<unknown>>>();
  // Completing it stops the question in flight; its process is killed as the run's scope closes.
  let stopCurrentAsk: Deferred.Deferred<void> | null = null;

  const isExecutableFile = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type === "File" && (info.mode & 0o111) !== 0),
      Effect.orElseSucceed(() => false),
    );

  const readCapped = (stream: Stream.Stream<Uint8Array, unknown>) =>
    Stream.runFoldEffect(
      stream.pipe(Stream.mapError((): RunError => "failed")),
      () => ({ size: 0, chunks: [] as Uint8Array[] }),
      (acc, chunk) => {
        const size = acc.size + chunk.byteLength;
        if (size > MAX_OUTPUT_BYTES) return Effect.fail<RunError>("too-large");
        acc.chunks.push(chunk);
        return Effect.succeed({ size, chunks: acc.chunks });
      },
    ).pipe(Effect.map(({ chunks }) => Buffer.concat(chunks).toString("utf8")));

  const run = <A>(
    method: string,
    flags: Flags,
    decode: (value: unknown) => Option.Option<A>,
    timeoutSeconds = TIMEOUT_SECONDS,
  ): Effect.Effect<LookoutResponse<A>> =>
    Effect.gen(function* () {
      const environment = yield* HostProcess.Environment;
      const homeDirectory = yield* HostProcess.HomeDirectory;
      const home = lookoutHome(environment.LOOKOUT_HOME, homeDirectory, path);
      const launcher = path.join(home, "bin", "lookout");
      if (!(yield* isExecutableFile(launcher))) return { installed: false, launcher } as const;

      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          // No shell: the kernel runs the launcher's `#!/bin/sh` line itself.
          const handle = yield* spawner
            .spawn(
              ChildProcess.make(launcher, lookoutArgs(method, flags), {
                cwd: homeDirectory,
                env: { ...environment, LOOKOUT_HOME: home, NO_COLOR: "1" },
                stdin: "ignore",
                killSignal: "SIGTERM",
                forceKillAfter: "2 seconds",
              }),
            )
            .pipe(Effect.mapError((): RunError => "unavailable"));
          // Drain stderr so a chatty Lookout cannot block on a full pipe.
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
          return { stdout, exitCode: Number(exitCode) } satisfies Outcome;
        }),
      ).pipe(Effect.timeoutOption(`${timeoutSeconds} seconds`), Effect.result);

      if (Result.isFailure(outcome)) {
        switch (outcome.failure) {
          case "unavailable":
            return fail("unavailable", "Lookout could not start.");
          case "too-large":
            return fail("failed", "Lookout's answer was too large to show.");
          default:
            return fail("failed", "Lookout stopped before it answered.");
        }
      }
      if (Option.isNone(outcome.success))
        return fail("timeout", `Lookout did not answer within ${timeoutSeconds} seconds.`);
      const { stdout, exitCode } = outcome.success.value;
      return interpretLookoutOutput(decode, stdout, exitCode);
    }).pipe(Effect.withSpan("Lookout.run", { attributes: { method } }));

  /** Identical reads in flight share one process. */
  const read = <A>(method: string, flags: Flags, decode: (value: unknown) => Option.Option<A>) =>
    Effect.suspend(() => {
      const key = lookoutArgs(method, flags).join("\0");
      const pending = reads.get(key) as Deferred.Deferred<LookoutResponse<A>> | undefined;
      if (pending) return Deferred.await(pending);
      const deferred = Deferred.makeUnsafe<LookoutResponse<A>>();
      reads.set(key, deferred as Deferred.Deferred<LookoutResponse<unknown>>);
      return run(method, flags, decode).pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            reads.delete(key);
            return Deferred.done(deferred, exit);
          }),
        ),
      );
    });

  const decodeStatus = Schema.decodeUnknownOption(LookoutStatus);
  const decodeFindings = Schema.decodeUnknownOption(LookoutFindings);
  const decodeActivity = Schema.decodeUnknownOption(LookoutActivity);
  const decodeDecision = Schema.decodeUnknownOption(LookoutDecision);
  const decodePause = Schema.decodeUnknownOption(LookoutPauseState);
  const decodeChat = Schema.decodeUnknownOption(LookoutChat);
  const decodeAnswer = Schema.decodeUnknownOption(LookoutAnswer);
  const decodeNudge = Schema.decodeUnknownOption(LookoutNudgeResult);

  const stopAsk = () => {
    const current = stopCurrentAsk;
    stopCurrentAsk = null;
    if (current) Deferred.doneUnsafe(current, Effect.void);
    return current !== null;
  };

  const setPaused = (method: "pause" | "resume", input: LookoutPauseInput) =>
    mutations.withPermit(run(method, { repo: input.repo }, decodePause));

  return Lookout.of({
    status: () => read("status", {}, decodeStatus),
    findings: (input) => read("findings", { repo: input.repo, all: input.all }, decodeFindings),
    activity: (input) => read("activity", { repo: input.repo, limit: input.limit }, decodeActivity),
    decide: (input) => {
      const invalid = decideInputError(input);
      if (invalid !== null) return Effect.succeed(fail("invalid", invalid));
      const note = input.note?.trim();
      return mutations.withPermit(
        run(
          "decide",
          { ref: input.ref, action: input.action, note: note || undefined, until: input.until },
          decodeDecision,
        ),
      );
    },
    pause: (input) => setPaused("pause", input),
    resume: (input) => setPaused("resume", input),
    chat: (input) => read("chat", { since: input.since, limit: input.limit }, decodeChat),
    ask: (input) =>
      Effect.suspend(() => {
        const invalid = askInputError(input);
        if (invalid !== null) return Effect.succeed(fail("invalid", invalid));
        // The panel asks one question at a time; an older question still running is abandoned.
        stopAsk();
        const stop = Deferred.makeUnsafe<void>();
        stopCurrentAsk = stop;
        return run("ask", { text: input.text }, decodeAnswer, ASK_TIMEOUT_SECONDS).pipe(
          Effect.raceFirst(
            Deferred.await(stop).pipe(
              Effect.as(fail("cancelled", "You stopped waiting for Lookout's answer.")),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (stopCurrentAsk === stop) stopCurrentAsk = null;
            }),
          ),
        );
      }),
    cancelAsk: () => Effect.sync(() => ({ cancelled: stopAsk() })),
    nudge: (input) =>
      mutations.withPermit(
        run(
          "nudge",
          "all" in input
            ? { all: true, action: input.action }
            : { id: input.id, action: input.action },
          decodeNudge,
        ),
      ),
  });
});

export const layer = Layer.effect(Lookout, make);
