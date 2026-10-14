import { CODEX_PRIVACY_ARGS, PROVIDER_PRIVACY_ENV } from "@starkfuture/shared/providerPrivacy";
import { STARK_PAGES_ENV } from "@starkfuture/shared/starkPages";
import { describe, expect, it } from "@effect/vitest";
import { nativeAgentLaunch } from "./NativeAgentLaunch.ts";

const defaultCodexPolicy = [
  "--ask-for-approval",
  "on-request",
  "--sandbox",
  "read-only",
  "-c",
  'approvals_reviewer="user"',
  "-c",
  "sandbox_workspace_write.network_access=false",
  "--no-daemon",
];

describe("native agent shell launch", () => {
  it("runs Codex interactively rather than starting its app server", () => {
    expect(nativeAgentLaunch({ driver: "codex", config: {}, home: "/Users/test" })).toEqual({
      shell: "codex",
      args: [...defaultCodexPolicy, ...CODEX_PRIVACY_ARGS],
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
          env: { ...PROVIDER_PRIVACY_ENV, ...STARK_PAGES_ENV },
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
      ...defaultCodexPolicy,
      ...CODEX_PRIVACY_ARGS,
    ]);
  });
  it("keeps explicitly configured permission policies", () => {
    expect(
      nativeAgentLaunch({ driver: "codex", home: "/tmp", config: { launchArgs: "-a untrusted" } })
        .args,
    ).toEqual([...defaultCodexPolicy, ...CODEX_PRIVACY_ARGS]);
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
      ["codex", "-anever"],
      ["codex", "-a=never"],
      ["codex", "--ask-for-approval=never"],
      ["codex", "-s danger-full-access"],
      ["codex", "-sdanger-full-access"],
      ["codex", "-s=danger-full-access"],
      ["codex", "--sandbox danger-full-access"],
      ["codex", "--sandbox=danger-full-access"],
      ["codex", "--approve-for-me"],
      ["codex", "--not-so-yolo"],
      ["codex", "--dangerously-bypass-hook-trust"],
      ["codex", "--remote ws://localhost:1234"],
      ["codex", "-c 'approval_policy=\"never\"'"],
      ["codex", '-capproval_policy="never"'],
      ["codex", '--config=approval_policy="never"'],
      ["codex", '--config \'"approval_policy"="never"\''],
      ["codex", "-c 'sandbox_mode=\"danger-full-access\"'"],
      ["codex", "-c 'sandbox_mode=\"danger-full-access\"' -s workspace-write"],
      ["codex", "-c 'approvals_reviewer=\"auto_review\"'"],
      ["codex", "-c 'approval_policy={ sandbox_approval=false }'"],
      ["claudeAgent", "--dangerously-skip-permissions"],
      ["claudeAgent", "--permission-mode auto"],
    ] as const) {
      expect(() => nativeAgentLaunch({ driver, config: { launchArgs }, home: "/tmp" })).toThrow(
        "requires supervised",
      );
    }
  });
  it("retains safe sandbox flags and their stricter config overrides", () => {
    for (const launchArgs of [
      "-s read-only",
      "-sread-only",
      "-s=read-only",
      "--sandbox=read-only",
    ]) {
      const { args } = nativeAgentLaunch({ driver: "codex", config: { launchArgs }, home: "/tmp" });
      expect(args).toEqual([...defaultCodexPolicy, ...CODEX_PRIVACY_ARGS]);
      expect(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2)).toEqual([
        "--sandbox",
        "read-only",
      ]);
    }
  });
  it("applies safe launch policy after personal profile configuration", () => {
    const { args } = nativeAgentLaunch({
      driver: "codex",
      home: "/tmp",
      config: { launchArgs: "--profile company --model company-model -c 'plugins.enabled=true'" },
    });
    expect(args.slice(0, 6)).toEqual([
      "--profile",
      "company",
      "--model",
      "company-model",
      "-c",
      "plugins.enabled=true",
    ]);
    expect(args.slice(6)).toEqual([...defaultCodexPolicy, ...CODEX_PRIVACY_ARGS]);
  });
  it("refuses prompts after an options delimiter", () => {
    expect(() =>
      nativeAgentLaunch({
        driver: "codex",
        home: "/tmp",
        config: { launchArgs: '--profile company -- "explain these flags"' },
      }),
    ).toThrow("Remove --");
  });
  it("normalises repeated safe policy flags without duplicate CLI options", () => {
    const { args } = nativeAgentLaunch({
      driver: "codex",
      home: "/tmp",
      config: {
        launchArgs:
          "-s workspace-write --sandbox read-only -a on-request --ask-for-approval untrusted",
      },
    });
    expect(args.filter((arg) => arg === "--sandbox")).toHaveLength(1);
    expect(args.filter((arg) => arg === "--ask-for-approval")).toHaveLength(1);
    expect(args).toEqual([...defaultCodexPolicy, ...CODEX_PRIVACY_ARGS]);
  });
  it("rejects unsupported providers instead of launching a different agent", () => {
    expect(() => nativeAgentLaunch({ driver: "unknown", config: {}, home: "/Users/test" })).toThrow(
      "supports Claude and Codex",
    );
  });
});
