import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as Lookout from "../../lookout/Lookout.ts";
import { decide, findings, pause, status } from "./lookout.ts";

// These tests provide the Electron services; importing the package must not download a runtime.
vi.mock("electron", () => ({}));

describe("Lookout IPC", () => {
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
      Effect.provideService(Lookout.Lookout, {
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
            Effect.provideService(Lookout.Lookout, {
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
