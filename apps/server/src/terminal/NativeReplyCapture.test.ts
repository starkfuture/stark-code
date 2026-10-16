// @effect-diagnostics nodeBuiltinImport:off -- Exercise the real standalone hook and loopback transport without starting provider CLIs.
// @effect-diagnostics globalFetchInEffect:off -- Assert actual HTTP rejection, binding and closed-socket behavior at the native endpoint boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { parse as parseToml } from "smol-toml";
import * as NativeReplyCapture from "./NativeReplyCapture.ts";
import { nativeAgentLaunch } from "./NativeAgentLaunch.ts";
import type { NativeAgentReply } from "@starkfuture/contracts";

const delivery = (values: Record<string, unknown> = {}) => ({
  deliveryId: NodeCrypto.randomUUID(),
  hook_event_name: "Stop",
  session_id: "provider-session",
  turn_id: "turn-1",
  stop_hook_active: false,
  last_assistant_message: "A completed reply.",
  ...values,
});
const post = (
  launch: NativeReplyCapture.NativeReplyLaunch,
  value: unknown,
  headers: Record<string, string> = {},
) =>
  Effect.promise(async () => {
    const response = await fetch(launch.env.STARK_NATIVE_REPLY_ENDPOINT!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${launch.env.STARK_NATIVE_REPLY_TOKEN}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(value),
    });
    await response.text();
    return response.status;
  });
const create = Effect.fn(function* (directory?: string) {
  const fs = yield* FileSystem.FileSystem;
  const root =
    directory ?? (yield* fs.makeTempDirectoryScoped({ prefix: "stark-native-capture-" }));
  const replies: NativeAgentReply[] = [];
  const capture = yield* NativeReplyCapture.make({
    directory: root,
    nodeExecutable: process.execPath,
    platform: yield* HostProcess.Platform,
    onReply: (reply) =>
      Effect.sync(() => {
        replies.push(reply);
      }),
  });
  const launch = yield* capture.bind({
    threadId: "stark-thread",
    terminalId: "native-shell",
    provider: "codex",
  });
  return { capture, launch, replies, root };
});

const decodeStopHooks = Schema.decodeUnknownSync(
  Schema.Struct({
    hooks: Schema.Struct({
      Stop: Schema.Array(
        Schema.Struct({
          hooks: Schema.Array(
            Schema.Struct({
              type: Schema.Literal("command"),
              command: Schema.String,
              async: Schema.Boolean,
            }),
          ),
        }),
      ),
    }),
  }),
);

it.layer(NodeServices.layer)("native completed replies", (it) => {
  it.effect.each(["claude", "codex"] as const)(
    "captures %s replies through the hook in its real launch configuration",
    (provider, ctx) =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        if (platform === "win32") return ctx.skip("POSIX hook execution requires a POSIX host");
        const { capture, root } = yield* create();
        const launch = yield* capture.bind({
          threadId: `${provider}-launch-thread`,
          terminalId: "native",
          provider,
        });
        const { args } = nativeAgentLaunch({
          driver: provider === "claude" ? "claudeAgent" : "codex",
          config: {},
          home: root,
          platform,
          nodeExecutable: process.execPath,
          replyCaptureCommand: launch.command,
        });
        const settings =
          provider === "claude"
            ? JSON.parse(args[args.indexOf("--settings") + 1]!)
            : parseToml(args.find((arg) => arg.startsWith("hooks="))!);
        const stopHooks = decodeStopHooks(settings).hooks.Stop.flatMap((group) => group.hooks);
        expect(stopHooks).toHaveLength(1);
        expect(stopHooks[0]?.async).toBe(true);
        const text =
          "# Verified reply\n\n**Result:** Ready to read.\n\n| Check | Result |\n| --- | --- |\n| Capture | Pass |\n\n![Screenshot](./screenshots/result.png)";
        const result = yield* Effect.promise(
          () =>
            new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
              // Run the command a real CLI receives, never a model turn or user hook.
              const child = NodeChildProcess.spawn("/bin/sh", ["-c", stopHooks[0]!.command], {
                env: { PATH: "/usr/bin:/bin", ...launch.env },
              });
              let out = "";
              let err = "";
              child.stdout.on("data", (chunk) => (out += chunk));
              child.stderr.on("data", (chunk) => (err += chunk));
              child.on("error", reject);
              child.on("close", (code) => resolve({ code, out, err }));
              child.stdin.end(
                JSON.stringify({
                  hook_event_name: "Stop",
                  session_id: `${provider}-session`,
                  ...(provider === "codex" ? { turn_id: "codex-turn" } : {}),
                  stop_hook_active: false,
                  last_assistant_message: text,
                }),
              );
            }),
        );
        expect(result).toEqual({ code: 0, out: "{}\n", err: "" });
        const retained = yield* capture.list({ threadId: `${provider}-launch-thread` });
        expect(retained).toHaveLength(1);
        expect(retained[0]).toMatchObject({
          provider,
          sessionId: `${provider}-session`,
          turnId: provider === "codex" ? "codex-turn" : null,
          text,
          sequence: 1,
        });
      }).pipe(Effect.scoped),
  );

  it.effect("survives a hook that disconnects halfway through its POST", () =>
    Effect.gen(function* () {
      const { launch, capture } = yield* create();
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            const request = NodeHttp.request(launch.env.STARK_NATIVE_REPLY_ENDPOINT!, {
              method: "POST",
              headers: {
                authorization: `Bearer ${launch.env.STARK_NATIVE_REPLY_TOKEN}`,
                "content-type": "application/json",
                "content-length": "1000",
                expect: "100-continue",
              },
            });
            request.on("error", () => {});
            request.on("close", resolve);
            request.on("continue", () => request.write('{"partial":', () => request.destroy()));
            request.flushHeaders();
          }),
      );
      expect(yield* post(launch, delivery())).toBe(200);
      expect(yield* capture.list({ threadId: "stark-thread" })).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
  it.effect("rejects invalid, misbound, browser-origin and oversized deliveries", () =>
    Effect.gen(function* () {
      const { capture, launch, replies } = yield* create();
      expect(yield* post(launch, delivery(), { authorization: `Bearer ${"a".repeat(64)}` })).toBe(
        403,
      );
      expect(yield* post(launch, delivery(), { origin: "http://untrusted.example" })).toBe(403);
      expect(yield* post(launch, delivery({ threadId: "another-thread" }))).toBe(400);
      expect(
        yield* post(launch, delivery({ hook_event_name: "SubagentStop", agent_id: "child" })),
      ).toBe(400);
      expect(yield* post(launch, delivery({ last_assistant_message: null }))).toBe(400);
      expect(yield* post(launch, delivery({ turn_id: null }))).toBe(400);
      const oversized = yield* post(
        launch,
        delivery({ last_assistant_message: "x".repeat(1_100_000) }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(oversized) || oversized.value === 413).toBe(true);
      expect(replies).toEqual([]);
      expect(yield* capture.list({ threadId: "another-thread" })).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("truncates long endpoint deliveries at a complete UTF-8 character and marks them", () =>
    Effect.gen(function* () {
      const { capture, launch } = yield* create();
      const prefix = "x".repeat(131_071);
      expect(
        yield* post(launch, delivery({ last_assistant_message: prefix + "💡".repeat(10_000) })),
      ).toBe(200);
      const rows = yield* capture.list({ threadId: "stark-thread" });
      expect(rows[0]?.text).toBe(prefix);
      expect(rows[0]?.truncated).toBe(true);
      expect(Buffer.byteLength(rows[0]!.text)).toBeLessThanOrEqual(131_072);
      expect(rows[0]?.text).not.toContain("�");
      expect(
        yield* post(
          launch,
          delivery({
            turn_id: "turn-2",
            last_assistant_message: "Already shortened",
            truncated: true,
          }),
        ),
      ).toBe(200);
      expect((yield* capture.list({ threadId: "stark-thread" }))[1]?.truncated).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "deduplicates concurrent deliveries and retains late replies without overwriting newer turns",
    () =>
      Effect.gen(function* () {
        const { capture, launch, replies } = yield* create();
        const newer = delivery({ turn_id: "turn-2", last_assistant_message: "Newer completion" });
        expect(
          yield* Effect.all([post(launch, newer), post(launch, newer)], {
            concurrency: "unbounded",
          }),
        ).toEqual([200, 200]);
        expect(
          yield* post(
            launch,
            delivery({ turn_id: "turn-2", last_assistant_message: "Newer completion" }),
          ),
        ).toBe(200);
        expect(
          yield* post(
            launch,
            delivery({ turn_id: "turn-1", last_assistant_message: "Delayed older completion" }),
          ),
        ).toBe(200);
        expect(replies.map((reply) => reply.text)).toEqual([
          "Newer completion",
          "Delayed older completion",
        ]);
        expect(
          (yield* capture.list({ threadId: "stark-thread", terminalId: "native-shell" })).map(
            (reply) => reply.sequence,
          ),
        ).toEqual([1, 2]);
        expect(
          yield* capture.list({ threadId: "stark-thread", terminalId: "other-terminal" }),
        ).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "runs the shipped helper with a short PATH, emits neutral JSON and ignores null or child replies",
    () =>
      Effect.gen(function* () {
        const { capture } = yield* create();
        const launch = yield* capture.bind({
          threadId: "claude-thread",
          terminalId: "native",
          provider: "claude",
        });
        const run = (value: unknown) =>
          Effect.promise(
            () =>
              new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
                const child = NodeChildProcess.spawn("/bin/sh", ["-c", launch.command], {
                  env: { PATH: "/usr/bin:/bin", ...launch.env },
                });
                let out = "",
                  err = "";
                child.stdout.on("data", (chunk) => (out += chunk));
                child.stderr.on("data", (chunk) => (err += chunk));
                child.on("error", reject);
                child.on("close", (code) => resolve({ code, out, err }));
                child.stdin.end(JSON.stringify(value));
              }),
          );
        expect(yield* run(delivery({ turn_id: null }))).toEqual({ code: 0, out: "{}\n", err: "" });
        expect(
          yield* run(
            delivery({
              turn_id: null,
              session_id: "session-after-clear",
              last_assistant_message: "Reply after /clear",
            }),
          ),
        ).toEqual({ code: 0, out: "{}\n", err: "" });
        expect(yield* run(delivery({ last_assistant_message: null }))).toEqual({
          code: 0,
          out: "{}\n",
          err: "",
        });
        expect(yield* run(delivery({ agent_id: "child" }))).toEqual({
          code: 0,
          out: "{}\n",
          err: "",
        });
        const longPrefix = "x".repeat(131_071);
        expect(
          yield* run(
            delivery({
              turn_id: null,
              last_assistant_message: longPrefix + "💡" + "y".repeat(2_000_000),
            }),
          ),
        ).toEqual({ code: 0, out: "{}\n", err: "" });
        // The helper still has a finite defensive input limit and drains oversize stdin neutrally.
        expect(yield* run(delivery({ last_assistant_message: "z".repeat(8_388_608) }))).toEqual({
          code: 0,
          out: "{}\n",
          err: "",
        });
        const rows = yield* capture.list({ threadId: "claude-thread" });
        expect(rows.map((reply) => reply.text)).toEqual([
          "A completed reply.",
          "Reply after /clear",
          longPrefix,
        ]);
        expect(rows.at(-1)?.truncated).toBe(true);
        expect(rows[0]?.truncated).toBeUndefined();
        expect(rows.every((reply) => reply.provider === "claude" && reply.turnId === null)).toBe(
          true,
        );
      }).pipe(Effect.scoped),
  );

  it.effect("retains replies across reopen and server scope restart, but closes its endpoint", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "stark-capture-restart-" });
      const scope = yield* Scope.make();
      const first = yield* create(directory).pipe(Effect.provideService(Scope.Scope, scope));
      expect(yield* post(first.launch, delivery())).toBe(200);
      yield* Scope.close(scope, Exit.void);
      const failed = yield* Effect.tryPromise(() =>
        fetch(first.launch.env.STARK_NATIVE_REPLY_ENDPOINT!),
      ).pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      const second = yield* create(directory);
      expect((yield* second.capture.list({ threadId: "stark-thread" }))[0]?.text).toBe(
        "A completed reply.",
      );
      expect(yield* post(second.launch, delivery())).toBe(200);
      expect(yield* second.capture.list({ threadId: "stark-thread" })).toHaveLength(1);
      expect(yield* post(second.launch, delivery({ turn_id: "turn-2" }))).toBe(200);
      expect((yield* second.capture.list({ threadId: "stark-thread" })).at(-1)?.sequence).toBe(2);
      const documents = (yield* fs.readDirectory(directory)).filter((name) =>
        name.endsWith(".json"),
      );
      expect(documents).toHaveLength(1);
      expect(Number((yield* fs.stat(`${directory}/${documents[0]}`)).mode) & 0o777).toBe(0o600);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "accepts a late completion briefly after exit and revokes deleted terminal bindings",
    () =>
      Effect.gen(function* () {
        const { capture, launch } = yield* create();
        yield* capture.retire({ threadId: "stark-thread", terminalId: "native-shell" });
        expect(yield* post(launch, delivery())).toBe(200);
        yield* TestClock.adjust("61 seconds");
        expect(yield* post(launch, delivery({ turn_id: "expired" }))).toBe(403);
        const another = yield* capture.bind({
          threadId: "stark-thread",
          terminalId: "second",
          provider: "codex",
        });
        expect(yield* post(another, delivery())).toBe(200);
        yield* capture.remove({ threadId: "stark-thread", terminalId: "native-shell" });
        expect(
          yield* capture.list({ threadId: "stark-thread", terminalId: "native-shell" }),
        ).toEqual([]);
        expect(
          yield* capture.list({ threadId: "stark-thread", terminalId: "second" }),
        ).toHaveLength(1);
        yield* capture.remove({ threadId: "stark-thread" });
        expect(yield* post(another, delivery())).toBe(403);
        expect(yield* capture.list({ threadId: "stark-thread" })).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("bounds persisted text while retaining the latest capture sequence", () =>
    Effect.gen(function* () {
      const { capture, launch, root } = yield* create();
      for (let index = 0; index < 20; index++)
        expect(
          yield* post(
            launch,
            delivery({ turn_id: `turn-${index}`, last_assistant_message: "x".repeat(131_072) }),
          ),
        ).toBe(200);
      const rows = yield* capture.list({ threadId: "stark-thread" });
      expect(rows.length).toBeLessThan(20);
      expect(rows.at(-1)?.sequence).toBe(20);
      const fs = yield* FileSystem.FileSystem;
      for (const name of yield* fs.readDirectory(root))
        if (name.endsWith(".json"))
          expect((yield* fs.stat(`${root}/${name}`)).size).toBeLessThanOrEqual(2_097_152n);
    }).pipe(Effect.scoped),
  );
});
