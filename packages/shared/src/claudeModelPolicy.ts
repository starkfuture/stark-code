/** Stark-owned Claude work uses Sonnet for helpers; history retains its reported model. */
export const CLAUDE_HELPER_MODEL = "claude-sonnet-5-5";

/** Official CLI controls; FORCE requires Claude Code 2.1.257+, Sonnet 5.5 requires 2.1.284+. */
export const CLAUDE_HELPER_MODEL_ENV = {
  ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_HELPER_MODEL,
  // Retain the deprecated control for older helper code paths.
  ANTHROPIC_SMALL_FAST_MODEL: CLAUDE_HELPER_MODEL,
  CLAUDE_CODE_SUBAGENT_MODEL: CLAUDE_HELPER_MODEL,
  CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
} as const;

/** Match aliases and provider-qualified/versioned Haiku IDs, not arbitrary prose. */
export function isClaudeHaikuModel(model: string): boolean {
  return /(?:^|[/:.])(?:claude-)?haiku(?:$|[-.\d]|\[)|(?:^|[/:.])claude-\d[\w.-]*-haiku(?:$|[-.])/i.test(
    model.trim(),
  );
}

/** Apply only to a new dispatch, never to usage or persisted transcript metadata. */
export function permittedClaudeModel(model: string): string {
  return isClaudeHaikuModel(model) ? CLAUDE_HELPER_MODEL : model;
}

/** Apply after user/profile env so a saved Haiku alias cannot undo the helper policy. */
export function claudeModelEnvironment(environment: Record<string, string | undefined>) {
  const result: Record<string, string | undefined> = { ...environment, ...CLAUDE_HELPER_MODEL_ENV };
  for (const key of [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
  ]) {
    const model = result[key];
    if (model !== undefined) result[key] = permittedClaudeModel(model);
  }
  return result;
}
