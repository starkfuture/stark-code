import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@starkfuture/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ResponseVisuals from "./ResponseVisuals.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fromJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const useful = {
  summary: "Two steps.",
  table: null,
  flowchart: {
    nodes: [
      { id: "a", label: "Prepare" },
      { id: "b", label: "Review" },
    ],
    edges: [{ from: "a", to: "b" }],
  },
  reason: null,
};
const envelope = (result: unknown) =>
  json({
    result: json(result),
    usage: {
      input_tokens: 120,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
      output_tokens: 60,
    },
    total_cost_usd: 0.001,
    modelUsage: { "claude-sonnet-5-5": {} },
  });
const base = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "stark-response-visual-test-" }),
  ServerSettings.layerTest({
    providerInstances: {
      [ProviderInstanceId.make("claude")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        config: { binaryPath: "claude", homePath: "" },
      },
    },
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "stark-visual-cache-test-" });
  const home = path.join(stateDir, "home");
  const executable = path.join(home, ".local", "bin", "claude");
  yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
  yield* fs.writeFileString(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const calls: ChildProcess.StandardCommand[] = [];
  const prompts: string[] = [];
  let closed = 0;
  const control = { output: envelope(useful), stderr: "", exitCode: 0, wait: false };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand")
        return yield* Effect.die("Expected direct CLI command");
      calls.push(command);
      const stdin = command.options.stdin;
      if (stdin && typeof stdin === "object" && "stream" in stdin && Stream.isStream(stdin.stream))
        prompts.push(
          yield* stdin.stream.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (a, b) => a + b,
            ),
          ),
        );
      expect(yield* fs.readDirectory(command.options.cwd!)).toEqual([]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed++;
        }),
      );
      yield* Deferred.succeed(started, undefined);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: (control.wait ? Deferred.await(release) : Effect.void).pipe(
          Effect.as(ChildProcessSpawner.ExitCode(control.exitCode)),
        ),
        isRunning: Effect.succeed(control.wait),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(control.output)),
        stderr: Stream.encodeText(Stream.make(control.stderr)),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const build = ResponseVisuals.ResponseVisuals.pipe(
    Effect.provide(ResponseVisuals.layer),
    Effect.provideService(ServerConfig.ServerConfig, { ...config, stateDir }),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Environment, {
      PATH: "/usr/bin:/bin",
      HOME: home,
      CLAUDE_CODE_EFFORT_LEVEL: "xhigh",
      ANTHROPIC_MODEL: "expensive",
      NODE_OPTIONS: "--import unsafe",
    }),
  );
  return {
    fs,
    path,
    stateDir,
    executable,
    build,
    service: yield* build,
    calls,
    prompts,
    control,
    started,
    release,
    get closed() {
      return closed;
    },
  };
});

it.layer(base)("ResponseVisuals", (it) => {
  it.effect(
    "uses the implicit default Claude instance and finds a native install with a Dock PATH",
    () =>
      Effect.gen(function* () {
        expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
        const f = yield* fixture.pipe(Effect.provide(ServerSettings.layerTest()));
        const result = yield* f.service.format({ answer: "Prepare, then review." });
        expect(result.summary).toBe("Two steps.");
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]!.command).toBe(f.executable);
        expect(f.calls[0]!.options.env?.PATH).toMatch(/^\/usr\/bin:\/bin:/);
      }).pipe(Effect.scoped),
  );

  it.effect("uses only the selected answer, an isolated Sonnet invocation, and reports usage", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const answer = "UNIQUE_SELECTED_ANSWER: Prepare, then review.";
      const result = yield* f.service.format({ answer, language: "English" });
      expect(result.mermaid).toBe('flowchart TD\nna["Prepare"]\nnb["Review"]\nna --> nb');
      expect(result.generationUsage).toEqual({
        freshInputTokens: 120,
        cacheReadInputTokens: 40,
        cacheWriteInputTokens: 10,
        outputTokens: 60,
        costUsd: 0.001,
      });
      expect(f.calls).toHaveLength(1);
      const command = f.calls[0]!;
      const args = command.args;
      for (const [flag, value] of [
        ["--model", "claude-sonnet-5-5"],
        ["--effort", "low"],
        ["--max-turns", "1"],
        ["--max-budget-usd", "0.08"],
        ["--tools", ""],
        ["--setting-sources", ""],
        ["--mcp-config", '{"mcpServers":{}}'],
      ])
        expect(args[args.indexOf(flag!) + 1]).toBe(value);
      for (const flag of [
        "--safe-mode",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--no-chrome",
      ])
        expect(args).toContain(flag);
      expect(args).not.toContain("--json-schema");
      expect(args.join(" ")).not.toContain(answer);
      expect(command.options.env?.CLAUDE_CODE_EFFORT_LEVEL).toBe("low");
      expect(command.options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("2048");
      expect(command.options.env?.MAX_THINKING_TOKENS).toBe("0");
      expect(command.options.env?.ANTHROPIC_MODEL).toBeUndefined();
      expect(command.options.env?.NODE_OPTIONS).toBeUndefined();
      expect(fromJson(f.prompts[0])).toEqual({
        answer,
        language: "English",
        visualRequest: "auto",
      });
      expect(yield* f.fs.exists(command.options.cwd!)).toBe(false);
      expect(f.closed).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reuses a durable bounded cache and keys language and visual preference separately",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const input = { answer: "unique-secret-answer" };
        const first = yield* f.service.format(input);
        expect((yield* f.service.format(input)).cacheHit).toBe(true);
        const restored = yield* f.build;
        expect(yield* restored.format(input)).toEqual({ ...first, cacheHit: true });
        expect(f.calls).toHaveLength(1);
        yield* restored.format({ ...input, language: "Spanish" });
        yield* restored.format({ ...input, visualRequest: "table" });
        expect(f.calls).toHaveLength(3);
        const file = f.path.join(f.stateDir, "response-visuals-v1.json");
        expect(yield* f.fs.readFileString(file)).not.toContain(input.answer);
        expect((yield* f.fs.stat(file)).mode & 0o777).toBe(0o600);
        for (let i = 0; i < 65; i++) yield* restored.format({ answer: `answer ${i}` });
        const cached = fromJson(yield* f.fs.readFileString(file));
        expect(Array.isArray(cached) && cached.length).toBe(64);
        expect((yield* f.fs.stat(file)).size <= 1024n * 1024n).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("permits no additions with a reason and safely constructs diagram labels", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.control.output = envelope({
        summary: null,
        table: null,
        flowchart: null,
        reason: "Already concise.",
      });
      expect((yield* f.service.format({ answer: "Yes." })).reason).toBe("Already concise.");
      f.control.output = envelope({
        ...useful,
        flowchart: {
          ...useful.flowchart,
          nodes: [
            { id: "a", label: 'Prepare"\nclick a "https://evil.invalid"' },
            { id: "b", label: "Review" },
          ],
        },
      });
      const result = yield* f.service.format({ answer: "Prepare and review" });
      expect(result.mermaid?.split("\n")).toHaveLength(4);
      expect(result.mermaid).not.toContain("\nclick");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects over-limit input and malformed output without repair or fallback calls", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const answer of ["", " ", "x".repeat(24_001), "界".repeat(20_000)]) {
        expect((yield* f.service.format({ answer }).pipe(Effect.flip)).reason).toBe("invalid");
      }
      expect(f.calls).toHaveLength(0);
      const invalidOutputs = [
        "not json",
        envelope({ ...useful, summary: "x".repeat(281) }),
        envelope({ ...useful, table: { columns: ["A", "B"], rows: [["one", "two", "extra"]] } }),
        envelope({
          ...useful,
          flowchart: { ...useful.flowchart, edges: [{ from: "a", to: "missing" }] },
        }),
        envelope({ summary: null, table: null, flowchart: null, reason: null }),
        "x".repeat(32 * 1024 + 1),
      ];
      for (const output of invalidOutputs) {
        f.control.output = output;
        const error = yield* f.service.format({ answer: "valid answer" }).pipe(Effect.flip);
        expect(error.reason).toBe("output");
        expect(error.message).not.toContain(output);
      }
      expect(f.calls).toHaveLength(invalidOutputs.length);
      expect(f.closed).toBe(invalidOutputs.length);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects parallel generation, times out, and releases subprocess scope for a retry",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.control.wait = true;
        const running = yield* f.service
          .format({ answer: "Slow answer" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(f.started);
        expect((yield* f.service.format({ answer: "Other answer" }).pipe(Effect.flip)).reason).toBe(
          "busy",
        );
        yield* TestClock.adjust("46 seconds");
        expect((yield* Fiber.join(running)).reason).toBe("timeout");
        expect(f.closed).toBe(1);
        f.control.wait = false;
        expect((yield* f.service.format({ answer: "Retry" })).cacheHit).toBe(false);
        expect(f.calls).toHaveLength(2);
      }).pipe(Effect.scoped),
  );

  it.effect("does not fallback on CLI errors or accept another reported model", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.control.exitCode = 1;
      f.control.stderr = "private command failure details";
      const failed = yield* f.service.format({ answer: "One" }).pipe(Effect.flip);
      expect(failed.reason).toBe("unavailable");
      expect(failed.message).not.toContain(f.control.stderr);
      f.control.exitCode = 0;
      f.control.stderr = "";
      f.control.output = json({ result: json(useful), modelUsage: { "claude-opus-5-5": {} } });
      expect((yield* f.service.format({ answer: "Two" }).pipe(Effect.flip)).reason).toBe("output");
      expect(f.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );
});
