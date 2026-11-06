import {
  PILOT_ASK_MAX_LENGTH,
  PILOT_NOTE_MAX_LENGTH,
  PilotActivity,
  PilotAnswer,
  PilotChat,
  PilotDecision,
  PilotFindings,
  PilotNudgeResult,
  PilotPauseState,
  PilotStatus,
  type PilotActivityInput,
  type PilotAskInput,
  type PilotCancelAskResult,
  type PilotChatInput,
  type PilotDecideInput,
  type PilotFailureReason,
  type PilotFindingsInput,
  type PilotNudgeInput,
  type PilotPauseInput,
  type PilotResponse,
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

// Pilot is a separate reviewer installed on this Mac. Its stable launcher
// `$PILOT_HOME/bin/pilot` answers `pilot api <method>` with one JSON
// object on stdout (API version 1). The renderer never chooses the binary or
// its arguments; this service builds both and decodes the answer strictly.
// Output can quote source code, so it is never logged.

const API_VERSION = 1;
const TIMEOUT_SECONDS = 10;
/** Pilot answers a question within 60 seconds or reports its own timeout; allow for its start-up. */
const ASK_TIMEOUT_SECONDS = 70;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_LENGTH = 500;
/** Matches Pilot's `<repo>#<id>` handle; the repository part is a name, key or path. */
const FINDING_REF = /^[^#\r\n]{1,200}#\d{1,9}$/;

type Flags = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * The argv for one API call. Values are always attached as `--name=value`, so a
 * note or repository name that starts with "-" can never be read as a flag.
 */
const pilotArgs = (method: string, flags: Flags = {}): string[] => {
  const args = ["api", method];
  for (const [name, value] of Object.entries(flags)) {
    if (value === undefined || value === false) continue;
    args.push(value === true ? `--${name}` : `--${name}=${value}`);
  }
  return args;
};

/** Why a question cannot be sent, in words for the panel, or null when it can. */
export const askInputError = (input: PilotAskInput): string | null => {
  if (input.text.trim().length === 0) return "Write a question first.";
  if (input.text.length > PILOT_ASK_MAX_LENGTH)
    return `Keep the question under ${PILOT_ASK_MAX_LENGTH} characters.`;
  // A command-line argument cannot carry a NUL character.
  if (input.text.includes("\0")) return "The question contains a character Pilot cannot read.";
  return null;
};

/** Why a decision cannot be sent, in words for the panel, or null when it can. */
export const decideInputError = (input: PilotDecideInput): string | null => {
  if (!FINDING_REF.test(input.ref)) return "That finding reference is not valid.";
  const note = input.note?.trim() ?? "";
  if (input.action !== "reopen" && note.length === 0)
    return `Add a short reason to ${input.action} this finding.`;
  if (note.length > PILOT_NOTE_MAX_LENGTH)
    return `Keep the reason under ${PILOT_NOTE_MAX_LENGTH} characters.`;
  if (input.until !== undefined && Number.isNaN(Date.parse(input.until)))
    return "The defer date is not a valid date.";
  return null;
};

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const fail = (reason: PilotFailureReason, error: string) =>
  ({ installed: true, ok: false, reason, error: error.slice(0, MAX_ERROR_LENGTH) }) as const;

/**
 * Turns one finished `pilot api` run into a response. Exit 1 with
 * `{"api":1,"error":…}` is Pilot's own error; any other shape is
 * reported without forwarding the raw output.
 */
const interpretPilotOutput = <A>(
  decode: (value: unknown) => Option.Option<A>,
  stdout: string,
  exitCode: number,
): PilotResponse<A> => {
  // `/bin/sh` reports a missing `node` for the launcher's `exec node …` as 127.
  if (exitCode === 127)
    return fail(
      "unavailable",
      "Pilot could not start. Check that Node.js 22.18 or newer is on your PATH.",
    );
  const parsed = parseJson(stdout);
  if (Option.isNone(parsed))
    return fail(
      "failed",
      exitCode === 0
        ? "Pilot answered with something the app could not read."
        : `Pilot stopped with exit code ${exitCode}.`,
    );
  const body = parsed.value;
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return fail("failed", "Pilot answered with something the app could not read.");
  const { api, error } = body as { api?: unknown; error?: unknown };
  if (api !== API_VERSION)
    return fail(
      "incompatible",
      "This Pilot version speaks a different API. Update Pilot or Stark Code.",
    );
  if (typeof error === "string") return fail("failed", error.trim() || "Pilot reported an error.");
  if (exitCode !== 0) return fail("failed", `Pilot stopped with exit code ${exitCode}.`);
  const value = decode(body);
  return Option.isSome(value)
    ? { installed: true, ok: true, value: value.value }
    : fail(
        "incompatible",
        "Pilot sent data this version of Stark Code does not understand. Update Stark Code.",
      );
};

/** `PILOT_HOME` with a leading `~` expanded, like Pilot itself resolves it. */
const pilotHome = (
  configured: string | undefined,
  homeDirectory: string,
  path: Path.Path,
): string => {
  const value = configured?.trim() || "~/.pilot";
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

export class Pilot extends Context.Service<
  Pilot,
  {
    readonly status: () => Effect.Effect<PilotResponse<PilotStatus>>;
    readonly findings: (input: PilotFindingsInput) => Effect.Effect<PilotResponse<PilotFindings>>;
    readonly activity: (input: PilotActivityInput) => Effect.Effect<PilotResponse<PilotActivity>>;
    readonly decide: (input: PilotDecideInput) => Effect.Effect<PilotResponse<PilotDecision>>;
    readonly pause: (input: PilotPauseInput) => Effect.Effect<PilotResponse<PilotPauseState>>;
    readonly resume: (input: PilotPauseInput) => Effect.Effect<PilotResponse<PilotPauseState>>;
    readonly chat: (input: PilotChatInput) => Effect.Effect<PilotResponse<PilotChat>>;
    /** One question at a time: a new question, or `cancelAsk`, stops the one in flight. */
    readonly ask: (input: PilotAskInput) => Effect.Effect<PilotResponse<PilotAnswer>>;
    readonly cancelAsk: () => Effect.Effect<PilotCancelAskResult>;
    readonly nudge: (input: PilotNudgeInput) => Effect.Effect<PilotResponse<PilotNudgeResult>>;
  }
>()("@starkfuture/desktop/pilot/Pilot") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Decisions and pauses write Pilot's databases; send them one at a time.
  const mutations = yield* Semaphore.make(1);
  const reads = new Map<string, Deferred.Deferred<PilotResponse<unknown>>>();
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
  ): Effect.Effect<PilotResponse<A>> =>
    Effect.gen(function* () {
      const environment = yield* HostProcess.Environment;
      const homeDirectory = yield* HostProcess.HomeDirectory;
      const home = pilotHome(environment.PILOT_HOME, homeDirectory, path);
      const launcher = path.join(home, "bin", "pilot");
      if (!(yield* isExecutableFile(launcher))) return { installed: false, launcher } as const;

      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          // No shell: the kernel runs the launcher's `#!/bin/sh` line itself.
          const handle = yield* spawner
            .spawn(
              ChildProcess.make(launcher, pilotArgs(method, flags), {
                cwd: homeDirectory,
                env: { ...environment, PILOT_HOME: home, NO_COLOR: "1" },
                stdin: "ignore",
                killSignal: "SIGTERM",
                forceKillAfter: "2 seconds",
              }),
            )
            .pipe(Effect.mapError((): RunError => "unavailable"));
          // Drain stderr so a chatty Pilot cannot block on a full pipe.
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
            return fail("unavailable", "Pilot could not start.");
          case "too-large":
            return fail("failed", "Pilot's answer was too large to show.");
          default:
            return fail("failed", "Pilot stopped before it answered.");
        }
      }
      if (Option.isNone(outcome.success))
        return fail("timeout", `Pilot did not answer within ${timeoutSeconds} seconds.`);
      const { stdout, exitCode } = outcome.success.value;
      return interpretPilotOutput(decode, stdout, exitCode);
    }).pipe(Effect.withSpan("Pilot.run", { attributes: { method } }));

  /** Identical reads in flight share one process. */
  const read = <A>(method: string, flags: Flags, decode: (value: unknown) => Option.Option<A>) =>
    Effect.suspend(() => {
      const key = pilotArgs(method, flags).join("\0");
      const pending = reads.get(key) as Deferred.Deferred<PilotResponse<A>> | undefined;
      if (pending) return Deferred.await(pending);
      const deferred = Deferred.makeUnsafe<PilotResponse<A>>();
      reads.set(key, deferred as Deferred.Deferred<PilotResponse<unknown>>);
      return run(method, flags, decode).pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            reads.delete(key);
            return Deferred.done(deferred, exit);
          }),
        ),
      );
    });

  const decodeStatus = Schema.decodeUnknownOption(PilotStatus);
  const decodeFindings = Schema.decodeUnknownOption(PilotFindings);
  const decodeActivity = Schema.decodeUnknownOption(PilotActivity);
  const decodeDecision = Schema.decodeUnknownOption(PilotDecision);
  const decodePause = Schema.decodeUnknownOption(PilotPauseState);
  const decodeChat = Schema.decodeUnknownOption(PilotChat);
  const decodeAnswer = Schema.decodeUnknownOption(PilotAnswer);
  const decodeNudge = Schema.decodeUnknownOption(PilotNudgeResult);

  const stopAsk = () => {
    const current = stopCurrentAsk;
    stopCurrentAsk = null;
    if (current) Deferred.doneUnsafe(current, Effect.void);
    return current !== null;
  };

  const setPaused = (method: "pause" | "resume", input: PilotPauseInput) =>
    mutations.withPermit(run(method, { repo: input.repo }, decodePause));

  return Pilot.of({
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
              Effect.as(fail("cancelled", "You stopped waiting for Pilot's answer.")),
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

export const layer = Layer.effect(Pilot, make);
