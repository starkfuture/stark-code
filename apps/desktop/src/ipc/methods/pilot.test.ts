import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as Pilot from "../../pilot/Pilot.ts";
import { ask, cancelAsk, chat, decide, findings, nudge, pause, status } from "./pilot.ts";

// These tests provide the Electron services; importing the package must not download a runtime.
vi.mock("electron", () => ({}));

describe("Pilot IPC", () => {
  const mainFrame = { url: "http://127.0.0.1:5733/chat" };
  const window = { webContents: { id: 7, mainFrame } };
  const trusted = { sender: { id: 7 }, senderFrame: mainFrame };
  const calls: string[] = [];
  const paused = { installed: true, ok: true, value: { ok: true, paused: true, scope: "all" } };
  const run = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        currentMainOrFirst: Effect.succeedSome(window),
      } as never),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        isDevelopment: true,
        devServerUrl: Option.some(new URL("http://127.0.0.1:5733/")),
      } as never),
      Effect.provideService(Pilot.Pilot, {
        status: () =>
          Effect.sync(() => (calls.push("status"), { installed: false, launcher: "/x" })),
        findings: () =>
          Effect.sync(
            () => (calls.push("findings"), { installed: true, ok: true, value: { findings: [] } }),
          ),
        activity: () => Effect.die("unused"),
        decide: () => Effect.die("unused"),
        pause: () => Effect.sync(() => (calls.push("pause"), paused)),
        resume: () => Effect.die("unused"),
      } as never),
    );

  it.effect("serves the app window and refuses iframes, other windows and remote pages", () =>
    Effect.gen(function* () {
      calls.length = 0;
      expect(yield* run(status.handler(undefined, trusted as never))).toEqual({
        installed: false,
        launcher: "/x",
      });
      expect(yield* run(pause.handler({}, trusted as never))).toEqual(paused);
      for (const event of [
        undefined,
        { sender: { id: 8 }, senderFrame: mainFrame },
        { sender: { id: 7 }, senderFrame: { url: mainFrame.url } },
        { sender: { id: 7 }, senderFrame: { url: "https://example.com/" } },
      ]) {
        expect(
          Exit.isFailure(yield* Effect.exit(run(status.handler(undefined, event as never)))),
        ).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(run(pause.handler({}, event as never))))).toBe(
          true,
        );
      }
      expect(calls).toEqual(["status", "pause"]);
    }),
  );

  it.effect("trusts the app's own scheme for the current build only", () =>
    Effect.gen(function* () {
      const answer = { installed: false, launcher: "/x" };
      const serve = (url: string, isDevelopment: boolean) => {
        const frame = { url };
        const event = { sender: { id: 9 }, senderFrame: frame };
        return Effect.exit(
          status.handler(undefined, event as never).pipe(
            Effect.provideService(ElectronWindow.ElectronWindow, {
              currentMainOrFirst: Effect.succeedSome({ webContents: { id: 9, mainFrame: frame } }),
            } as never),
            Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
              isDevelopment,
              devServerUrl: Option.none(),
            } as never),
            Effect.provideService(Pilot.Pilot, {
              status: () => Effect.succeed(answer),
            } as never),
          ),
        );
      };
      expect(Exit.isSuccess(yield* serve("starkcode-dev://app/", true))).toBe(true);
      expect(Exit.isSuccess(yield* serve("starkcode://app/", false))).toBe(true);
      expect(Exit.isFailure(yield* serve("starkcode-dev://app/", false))).toBe(true);
      expect(Exit.isFailure(yield* serve("starkcode-dev://evil/", true))).toBe(true);
    }),
  );

  it.effect("rejects malformed payloads before the service runs", () =>
    Effect.gen(function* () {
      calls.length = 0;
      for (const operation of [
        decide.handler({ ref: "orders#1", action: "delete", note: "x" }, trusted as never),
        decide.handler(
          { ref: "orders#1", action: "dismiss", note: "x".repeat(2001) },
          trusted as never,
        ),
        findings.handler({ repo: 42 }, trusted as never),
        findings.handler({ repo: "" }, trusted as never),
      ]) {
        expect(Exit.isFailure(yield* Effect.exit(run(operation)))).toBe(true);
      }
      expect(calls).toEqual([]);
      expect(yield* run(findings.handler({ repo: "orders", all: true }, trusted as never))).toEqual(
        {
          installed: true,
          ok: true,
          value: { findings: [] },
        },
      );
    }),
  );
});

describe("Pilot chat IPC", () => {
  const mainFrame = { url: "starkcode://app/chat" };
  const window = { webContents: { id: 3, mainFrame } };
  const trusted = { sender: { id: 3 }, senderFrame: mainFrame };
  const calls: string[] = [];
  const run = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        currentMainOrFirst: Effect.succeedSome(window),
      } as never),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        isDevelopment: false,
        devServerUrl: Option.none(),
      } as never),
      Effect.provideService(Pilot.Pilot, {
        chat: () =>
          Effect.sync(
            () => (
              calls.push("chat"),
              { installed: true, ok: true, value: { messages: [], unread: 2 } }
            ),
          ),
        ask: () =>
          Effect.sync(
            () => (
              calls.push("ask"),
              { installed: true, ok: false, reason: "cancelled", error: "x" }
            ),
          ),
        cancelAsk: () => Effect.sync(() => (calls.push("cancelAsk"), { cancelled: true })),
        nudge: () =>
          Effect.sync(
            () => (calls.push("nudge"), { installed: true, ok: true, value: { ok: true } }),
          ),
      } as never),
    );
  const operations = (event: unknown) => [
    chat.handler({ since: 3 }, event as never),
    ask.handler({ text: "what's waiting on me?" }, event as never),
    cancelAsk.handler(undefined, event as never),
    nudge.handler({ id: 4, action: "send" }, event as never),
  ];

  it.effect("serves chat, questions and nudges only to the app window", () =>
    Effect.gen(function* () {
      calls.length = 0;
      for (const event of [
        undefined,
        { sender: { id: 4 }, senderFrame: mainFrame },
        { sender: { id: 3 }, senderFrame: { url: mainFrame.url } },
        { sender: { id: 3 }, senderFrame: { url: "https://example.com/" } },
      ]) {
        for (const operation of operations(event))
          expect(Exit.isFailure(yield* Effect.exit(run(operation)))).toBe(true);
      }
      expect(calls).toEqual([]);
      for (const operation of operations(trusted))
        expect(Exit.isSuccess(yield* Effect.exit(run(operation)))).toBe(true);
      expect(calls).toEqual(["chat", "ask", "cancelAsk", "nudge"]);
    }),
  );

  it.effect("rejects malformed questions and nudges before the service runs", () =>
    Effect.gen(function* () {
      calls.length = 0;
      for (const operation of [
        ask.handler({ text: "" }, trusted as never),
        ask.handler({ text: "  " }, trusted as never),
        ask.handler({ text: "x".repeat(4001) }, trusted as never),
        ask.handler({ text: 42 }, trusted as never),
        nudge.handler({ id: 4, action: "delete" }, trusted as never),
        nudge.handler({ id: "4", action: "seen" }, trusted as never),
        nudge.handler({ all: true, action: "send" }, trusted as never),
        nudge.handler({ action: "seen" }, trusted as never),
        chat.handler({ since: -1 }, trusted as never),
        chat.handler({ limit: 0 }, trusted as never),
      ]) {
        expect(Exit.isFailure(yield* Effect.exit(run(operation)))).toBe(true);
      }
      expect(calls).toEqual([]);
      expect(yield* run(ask.handler({ text: "x".repeat(4000) }, trusted as never))).toMatchObject({
        ok: false,
        reason: "cancelled",
      });
      expect(yield* run(nudge.handler({ all: true, action: "seen" }, trusted as never))).toEqual({
        installed: true,
        ok: true,
        value: { ok: true },
      });
      expect(calls).toEqual(["ask", "nudge"]);
    }),
  );
});
