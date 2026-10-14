import { describe, expect, it } from "@effect/vitest";
import { nativeAgentLaunch } from "./NativeAgentLaunch.ts";

describe("native agent shell launch", () => {
  it("runs Codex interactively rather than starting its app server", () => {
    expect(nativeAgentLaunch({ driver: "codex", config: {}, home: "/Users/test" })).toEqual({
      shell: "codex",
      args: ["--ask-for-approval", "on-request"],
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
      args: ["--plugin-dir", "/Users/test/My plugins", "--permission-mode", "default"],
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
    expect(result.args).toEqual(["--config", "name=$(whoami)", "--ask-for-approval", "on-request"]);
  });
  it("keeps explicitly configured permission policies", () => {
    expect(nativeAgentLaunch({ driver: "codex", home: "/tmp", config: { launchArgs: "-a untrusted" } }).args).toEqual(["-a", "untrusted"]);
    expect(nativeAgentLaunch({ driver: "claudeAgent", home: "/tmp", config: { launchArgs: "--permission-mode plan" } }).args).toEqual(["--permission-mode", "plan"]);
  });
  it("rejects unsupported providers instead of launching a different agent", () => {
    expect(() => nativeAgentLaunch({ driver: "unknown", config: {}, home: "/Users/test" })).toThrow(
      "supports Claude and Codex",
    );
  });
});
