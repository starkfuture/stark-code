import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as Pilot from "./Pilot.ts";

// Shapes captured from `pilot api` (api version 1).
const STATUS = {
  api: 1,
  generatedAt: "2026-11-05T16:45:37.436Z",
  daemon: { running: true, pid: 64235, heartbeatAt: "2026-11-05T16:45:36.880Z" },
  paused: false,
  profiles: ["/Users/me/.claude"],
  home: "/Users/me/.pilot",
  mode: "local",
  claudeBin: "/Users/me/.local/bin/claude",
  delivery: "session",
  selftest: { ok: true, reason: "passed 2026-11-05T14:50:47.576Z" },
  budget: { windowHours: 24, capCents: 1000, spentCents: 0, availableCents: 1000 },
  repos: [
    {
      key: "orders-service-b7f807d25c",
      name: "orders-service",
      root: "/Users/me/work/orders-service",
      lastEventAt: "2026-11-05T16:08:16.655Z",
      paused: false,
      excluded: false,
      pendingEvents: 0,
      openFindings: 1,
      toldSession: 1,
      activeJob: null,
      lastRun: {
        id: 4,
        kind: "review",
        status: "done",
        finishedAt: "2026-11-05T16:09:00.000Z",
        costCents: 12,
        summary: "1 finding",
      },
      futureField: "ignored",
    },
  ],
};

interface Spawned {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
}

/**
 * A Pilot that answers every call with `reply` and records how it was run.
 * With a `gate`, it exits only once the gate opens; `spawned` completes on the first run.
 */
const fakePilot = (
  reply: { stdout?: string | Uint8Array; exitCode?: number },
  gate?: Deferred.Deferred<void>,
) => {
  const calls: Spawned[] = [];
  /** Runs stopped before they exited, such as a cancelled question. */
  const interrupted: Array<ReadonlyArray<string>> = [];
  const spawned = Deferred.makeUnsafe<void>();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const { command: file, args, options } = command as ChildProcess.StandardCommand;
      calls.push({ command: file, args, options });
      Deferred.doneUnsafe(spawned, Effect.void);
      const bytes =
        typeof reply.stdout === "string"
          ? new TextEncoder().encode(reply.stdout)
          : (reply.stdout ?? new Uint8Array());
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: (gate ? Deferred.await(gate) : Effect.void).pipe(
          Effect.as(ChildProcessSpawner.ExitCode(reply.exitCode ?? 0)),
          Effect.onInterrupt(() => Effect.sync(() => interrupted.push(args))),
        ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(bytes),
        stderr: Stream.make(new TextEncoder().encode("warning: noisy stderr\n")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { calls, interrupted, spawner, spawned };
};

// A chat message as Pilot returns it.
const message = (id: number, role: "you" | "pilot", text: string) => ({
  id,
  at: "2026-11-06T09:13:00.000Z",
  role,
  kind: role === "you" ? "message" : "answer",
  nudgeKind: null,
  text,
  evidence: [],
  session: null,
  sessionLabel: null,
  repo: null,
  state: "seen",
});
const ANSWER = {
  api: 1,
  question: message(42, "you", "what's waiting on me?"),
  answer: message(43, "pilot", "Nothing is waiting on you."),
};

/** A temporary Pilot home, with or without its launcher, and the service reading it. */
const setup = (
  fake: ReturnType<typeof fakePilot>,
  options: { installed?: boolean; executable?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDirectory = yield* fs.makeTempDirectoryScoped();
    const home = path.join(homeDirectory, "pilot-home");
    const launcher = path.join(home, "bin", "pilot");
    if (options.installed !== false) {
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(launcher, options.executable === false ? 0o644 : 0o755);
    }
    const service = yield* Pilot.make.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
    );
    const within = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(HostProcess.Environment, { PILOT_HOME: home, PATH: "/usr/bin" }),
        Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
      );
    return { service, within, home, homeDirectory, launcher };
  });

it.layer(NodeServices.layer)("Pilot", (it) => {
  it.effect("reports a missing or non-executable launcher without running anything", () =>
    Effect.gen(function* () {
      for (const options of [{ installed: false }, { executable: false }]) {
        const fake = fakePilot({ stdout: JSON.stringify(STATUS) });
        const { service, within, launcher } = yield* setup(fake, options);
        expect(yield* within(service.status())).toEqual({ installed: false, launcher });
        expect(fake.calls).toHaveLength(0);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("runs the launcher without a shell and decodes the status", () =>
    Effect.gen(function* () {
      const fake = fakePilot({ stdout: `${JSON.stringify(STATUS)}\n` });
      const { service, within, home, homeDirectory, launcher } = yield* setup(fake);
      const response = yield* within(service.status());
      expect(response).toMatchObject({ installed: true, ok: true });
      if (!response.installed || !response.ok) return;
      expect(response.value.repos[0]?.name).toBe("orders-service");
      expect(response.value.repos[0]).not.toHaveProperty("futureField");
      expect(fake.calls).toEqual([
        {
          command: launcher,
          args: ["api", "status"],
          options: expect.objectContaining({
            cwd: homeDirectory,
            stdin: "ignore",
            env: expect.objectContaining({ PILOT_HOME: home, NO_COLOR: "1", PATH: "/usr/bin" }),
          }),
        },
      ]);
      expect(fake.calls[0]?.options.shell).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("attaches every value to its flag so a leading dash stays a value", () =>
    Effect.gen(function* () {
      const fake = fakePilot({
        stdout: JSON.stringify({ api: 1, error: "no finding" }),
        exitCode: 1,
      });
      const { service, within } = yield* setup(fake);
      yield* within(
        service.decide({
          ref: "orders-service#3",
          action: "defer",
          note: "  -m after the release ",
          until: "2026-12-01T00:00:00.000Z",
        }),
      );
      yield* within(service.findings({ repo: "--all", all: true }));
      yield* within(service.activity({ limit: 20 }));
      yield* within(service.resume({}));
      expect(fake.calls.map((call) => call.args)).toEqual([
        [
          "api",
          "decide",
          "--ref=orders-service#3",
          "--action=defer",
          "--note=-m after the release",
          "--until=2026-12-01T00:00:00.000Z",
        ],
        ["api", "findings", "--repo=--all", "--all"],
        ["api", "activity", "--limit=20"],
        ["api", "resume"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a decision before running Pilot", () =>
    Effect.gen(function* () {
      const fake = fakePilot({ stdout: "{}" });
      const { service, within } = yield* setup(fake);
      for (const input of [
        { ref: "no-hash", action: "accept", note: "fine" },
        { ref: "orders#3\nrm", action: "accept", note: "fine" },
        { ref: "orders#3", action: "dismiss", note: "   " },
        { ref: "orders#3", action: "defer", note: "later", until: "soon" },
      ] as const) {
        expect(yield* within(service.decide(input))).toMatchObject({
          installed: true,
          ok: false,
          reason: "invalid",
        });
      }
      expect(fake.calls).toHaveLength(0);
      // Reopening needs no reason.
      expect(Pilot.decideInputError({ ref: "orders#3", action: "reopen" })).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("maps Pilot's own error, bad output, other versions and a missing node", () =>
    Effect.gen(function* () {
      const cases = [
        [
          { stdout: JSON.stringify({ api: 1, error: 'no watched repository "x"' }), exitCode: 1 },
          { reason: "failed", error: 'no watched repository "x"' },
        ],
        [{ stdout: "Error: something broke\n{" }, { reason: "failed" }],
        [
          { stdout: "", exitCode: 2 },
          { reason: "failed", error: "Pilot stopped with exit code 2." },
        ],
        [{ stdout: JSON.stringify({ ...STATUS, api: 2 }) }, { reason: "incompatible" }],
        [{ stdout: JSON.stringify({ ...STATUS, mode: "cloud" }) }, { reason: "incompatible" }],
        [{ stdout: "", exitCode: 127 }, { reason: "unavailable" }],
      ] as const;
      for (const [reply, expected] of cases) {
        const { service, within } = yield* setup(fakePilot(reply));
        expect(yield* within(service.status())).toMatchObject({
          installed: true,
          ok: false,
          ...expected,
        });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("refuses output larger than the cap", () =>
    Effect.gen(function* () {
      const { service, within } = yield* setup(
        fakePilot({ stdout: new Uint8Array(8 * 1024 * 1024 + 1) }),
      );
      expect(yield* within(service.status())).toMatchObject({
        ok: false,
        reason: "failed",
        error: "Pilot's answer was too large to show.",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("shares one process between identical reads in flight", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const fake = fakePilot({ stdout: JSON.stringify(STATUS) }, gate);
      const { service, within } = yield* setup(fake);
      const first = yield* within(service.status()).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(fake.spawned);
      const second = yield* within(service.status()).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(gate, undefined);
      const [a, b] = [yield* Fiber.join(first), yield* Fiber.join(second)];
      expect(a).toEqual(b);
      expect(a).toMatchObject({ ok: true });
      expect(fake.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("passes chat, question and nudge values as attached flags", () =>
    Effect.gen(function* () {
      const fake = fakePilot({ stdout: JSON.stringify({ api: 1, error: "nope" }), exitCode: 1 });
      const { service, within } = yield* setup(fake);
      yield* within(service.chat({ since: 40, limit: 200 }));
      yield* within(service.chat({}));
      yield* within(service.ask({ text: "--all\nwhat did I ask yesterday?" }));
      yield* within(service.ask({ text: "and with Codex?", engine: "codex" }));
      yield* within(service.settings({}));
      yield* within(service.settings({ engine: "codex" }));
      yield* within(service.nudge({ id: 41, action: "not_useful" }));
      yield* within(service.nudge({ all: true, action: "seen" }));
      expect(fake.calls.map((call) => call.args)).toEqual([
        ["api", "chat", "--since=40", "--limit=200"],
        ["api", "chat"],
        ["api", "ask", "--text=--all\nwhat did I ask yesterday?"],
        ["api", "ask", "--text=and with Codex?", "--engine=codex"],
        ["api", "settings"],
        ["api", "settings", "--engine=codex"],
        ["api", "nudge", "--id=41", "--action=not_useful"],
        ["api", "nudge", "--all", "--action=seen"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a blank question before running Pilot", () =>
    Effect.gen(function* () {
      const fake = fakePilot({ stdout: JSON.stringify(ANSWER) });
      const { service, within } = yield* setup(fake);
      for (const text of ["   ", "a\0b", "x".repeat(4001)])
        expect(yield* within(service.ask({ text }))).toMatchObject({
          ok: false,
          reason: "invalid",
        });
      expect(fake.calls).toHaveLength(0);
      expect(yield* within(service.ask({ text: "what's waiting on me?" }))).toMatchObject({
        ok: true,
        value: { answer: { text: "Nothing is waiting on you." } },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("waits seventy seconds for an answer, not ten", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const fake = fakePilot({ stdout: "" }, gate);
      const { service, within } = yield* setup(fake);
      const call = yield* within(service.ask({ text: "what's waiting on me?" })).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(fake.spawned);
      yield* TestClock.adjust("61 seconds");
      expect(call.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(call)).toMatchObject({
        ok: false,
        reason: "timeout",
        error: "Pilot did not answer within 70 seconds.",
      });
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("stops a cancelled question and leaves nothing in flight", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const fake = fakePilot({ stdout: JSON.stringify(ANSWER) }, gate);
      const { service, within } = yield* setup(fake);
      expect(yield* service.cancelAsk()).toEqual({ cancelled: false });
      const first = yield* within(service.ask({ text: "first" })).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(fake.spawned);
      expect(yield* service.cancelAsk()).toEqual({ cancelled: true });
      expect(yield* Fiber.join(first)).toMatchObject({ ok: false, reason: "cancelled" });
      expect(fake.interrupted).toEqual([["api", "ask", "--text=first"]]);
      expect(yield* service.cancelAsk()).toEqual({ cancelled: false });

      // A new question replaces one still in flight, and then answers normally.
      const second = yield* within(service.ask({ text: "second" })).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const third = yield* within(service.ask({ text: "third" })).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      expect(yield* Fiber.join(second)).toMatchObject({ ok: false, reason: "cancelled" });
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(third)).toMatchObject({ ok: true });
      expect(yield* service.cancelAsk()).toEqual({ cancelled: false });
    }).pipe(Effect.scoped),
  );

  it.effect("gives up after ten seconds", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const fake = fakePilot({ stdout: "" }, gate);
      const { service, within } = yield* setup(fake);
      const call = yield* within(service.status()).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(fake.spawned);
      yield* TestClock.adjust("11 seconds");
      expect(yield* Fiber.join(call)).toMatchObject({ ok: false, reason: "timeout" });
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("runs the self-test and reads its verdict from the exit code", () =>
    Effect.gen(function* () {
      for (const [exitCode, expected] of [
        [0, { installed: true, ok: true, value: { passed: true } }],
        [1, { installed: true, ok: true, value: { passed: false } }],
        [127, { ok: false, reason: "unavailable" }],
        [3, { ok: false, reason: "failed" }],
      ] as const) {
        const fake = fakePilot({ stdout: "PASS  [isolation] no tools\n", exitCode });
        const { service, within, launcher } = yield* setup(fake);
        expect(yield* within(service.selftest())).toMatchObject(expected);
        expect(fake.calls.map((call) => [call.command, ...call.args])).toEqual([
          [launcher, "selftest"],
        ]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("waits up to four minutes for the self-test", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const fake = fakePilot({ stdout: "" }, gate);
      const { service, within } = yield* setup(fake);
      const call = yield* within(service.selftest()).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(fake.spawned);
      yield* TestClock.adjust("200 seconds");
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(call)).toMatchObject({ ok: true, value: { passed: true } });
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});
