import { CODEX_PRIVACY_ARGS, PROVIDER_PRIVACY_ENV } from "@starkfuture/shared/providerPrivacy";
import { describe, expect, it } from "@effect/vitest";
import { nativeAgentLaunch } from "./NativeAgentLaunch.ts";

describe("native agent shell launch", () => {
  it("runs Codex interactively rather than starting its app server", () => {
    expect(nativeAgentLaunch({ driver: "codex", config: {}, home: "/Users/test" })).toEqual({
      shell: "codex",
      args: ["--ask-for-approval", "on-request", ...CODEX_PRIVACY_ARGS],
    });
  });
  it("keeps Claude plugin arguments and executable paths as distinct argv values", () => {
    expect(
      nativeAgentLaunch({
        driver: "claudeAgent",
        config: {
          binaryPath: "~/Tools/Claude Code/claude",
          launchArgs: '--plugin-dir "/Users/test/My plugins"',
        },
        home: "/Users/test",
      }),
    ).toEqual({
      shell: "/Users/test/Tools/Claude Code/claude",
      args: [
        "--plugin-dir",
        "/Users/test/My plugins",
        "--permission-mode",
        "default",
        "--settings",
        JSON.stringify({
          env: PROVIDER_PRIVACY_ENV,
          disableAutoMode: "disable",
          permissions: { disableBypassPermissionsMode: "disable" },
        }),
      ],
    });
  });
  it("does not interpret shell substitutions in configuration", () => {
    const result = nativeAgentLaunch({
      driver: "codex",
      config: {
        binaryPath: "/tmp/codex; touch /tmp/unwanted",
        launchArgs: '--config "name=$(whoami)"',
      },
      home: "/Users/test",
    });
    expect(result.shell).toBe("/tmp/codex; touch /tmp/unwanted");
    expect(result.args).toEqual([
      "--config",
      "name=$(whoami)",
      "--ask-for-approval",
      "on-request",
      ...CODEX_PRIVACY_ARGS,
    ]);
  });
  it("keeps explicitly configured permission policies", () => {
    expect(
      nativeAgentLaunch({ driver: "codex", home: "/tmp", config: { launchArgs: "-a untrusted" } })
        .args,
    ).toEqual(["-a", "untrusted", ...CODEX_PRIVACY_ARGS]);
    expect(
      nativeAgentLaunch({
        driver: "claudeAgent",
        home: "/tmp",
        config: { launchArgs: "--permission-mode plan" },
      }).args.slice(0, 2),
    ).toEqual(["--permission-mode", "plan"]);
  });
  it("overrides configured Codex reporting while preserving the selected profile and other settings", () => {
    const { args } = nativeAgentLaunch({
      driver: "codex",
      home: "/tmp",
      config: {
        launchArgs:
          '--profile "company profile" --config analytics.enabled=true -c otel.metrics_exporter="statsig" --config model="configured-model"',
      },
    });
    expect(args.slice(0, 8)).toEqual([
      "--profile",
      "company profile",
      "--config",
      "analytics.enabled=true",
      "-c",
      "otel.metrics_exporter=statsig",
      "--config",
      "model=configured-model",
    ]);
    expect(args.slice(-10)).toEqual([
      "-c",
      "analytics.enabled=false",
      "-c",
      'otel.exporter="none"',
      "-c",
      'otel.trace_exporter="none"',
      "-c",
      'otel.metrics_exporter="none"',
      "-c",
      "otel.log_user_prompt=false",
    ]);
  });
  it("rejects permission bypass and auto mode in native launch settings", () => {
    for (const [driver, launchArgs] of [
      ["codex", "--yolo"],
      ["codex", "-a never"],
      ["claudeAgent", "--dangerously-skip-permissions"],
      ["claudeAgent", "--permission-mode auto"],
    ] as const) {
      expect(() => nativeAgentLaunch({ driver, config: { launchArgs }, home: "/tmp" })).toThrow(
        "requires supervised",
      );
    }
  });
  it("rejects unsupported providers instead of launching a different agent", () => {
    expect(() => nativeAgentLaunch({ driver: "unknown", config: {}, home: "/Users/test" })).toThrow(
      "supports Claude and Codex",
    );
  });
});
