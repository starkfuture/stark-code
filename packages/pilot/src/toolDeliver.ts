/**
 * `pilot deliver --tool`: the PreToolUse (Bash) and PostToolUse (every tool) hooks. A nudge reaches the session
 * mid-turn, 10-20 s after the prompt it is about, while the session is working on it, and before a Bash call such
 * as `gh pr merge` runs. Claude Code 2.1.319 accepts `hookSpecificOutput.additionalContext` from both events (its
 * hook output schema: PreToolUse {hookEventName, permissionDecision, permissionDecisionReason, updatedInput,
 * additionalContext, ...}; PostToolUse {hookEventName, additionalContext, ...}).
 *
 * Fast and fail-open: the hook command starts Node only when ~/.pilot/outbox-pending exists (chat.ts); then one
 * indexed registry read for this session, and a claim only when something is queued. Never a permission decision.
 */
import { claimQueued } from "./chat.ts";
import { currentProfile, envVar, isWatchedProfile, openRegistry } from "./home.ts";

async function readStdin(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

export async function runToolDeliver(): Promise<number> {
  if (envVar("IN_INVESTIGATION")) return 0;
  const input = await readStdin();
  const session = typeof input.session_id === "string" ? input.session_id : null;
  const event = input.hook_event_name === "PreToolUse" ? "PreToolUse" : "PostToolUse";
  if (!session || !isWatchedProfile(currentProfile())) return 0;
  const text = claimQueued(openRegistry(), session, Date.now());
  if (text) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`);
  return 0;
}
