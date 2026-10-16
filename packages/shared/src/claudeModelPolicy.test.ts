import { describe, expect, it } from "vite-plus/test";
import {
  CLAUDE_HELPER_MODEL,
  claudeModelEnvironment,
  isClaudeHaikuModel,
  permittedClaudeModel,
} from "./claudeModelPolicy.ts";

describe("Claude model policy", () => {
  it.each([
    "haiku",
    "HAIKU",
    "haiku-5.5",
    "claude-haiku-4-5-20251001",
    "anthropic/claude-haiku-5-5",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "claude-3-5-haiku-20241022",
    "claude-haiku-5-5[1m]",
  ])("recognizes blocked model %s", (model) => {
    expect(isClaudeHaikuModel(model)).toBe(true);
    expect(permittedClaudeModel(model)).toBe(CLAUDE_HELPER_MODEL);
  });
  it.each(["claude-sonnet-5-5", "opus", "fable", "my-haiku-proxy", "gpt-6-astra"])(
    "preserves opaque or permitted ID %s",
    (model) => {
      expect(isClaudeHaikuModel(model)).toBe(false);
      expect(permittedClaudeModel(model)).toBe(model);
    },
  );
  it("repairs inherited Haiku aliases without changing an allowed main model", () => {
    const source = {
      ANTHROPIC_MODEL: "opus",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "haiku",
      CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0",
    };
    expect(claudeModelEnvironment(source)).toMatchObject({
      ANTHROPIC_MODEL: "opus",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5-5",
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5-5",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    });
    expect(source.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("haiku");
  });
});
