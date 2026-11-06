import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.ts";
import { realPathish } from "./home.ts";
import { deniedPathReason, redact } from "./secrets.ts";
import { sha256, tail, truncate } from "./util.ts";

export type EventKind = "prompt" | "edit" | "test" | "stop" | "session";

/** Documented hook fields that identify who produced an event (main session or a subagent). */
const ids = (input: Record<string, any>) => ({
  ...(input.prompt_id ? { prompt_id: String(input.prompt_id) } : {}),
  ...(input.agent_id ? { agent_id: String(input.agent_id), agent_type: input.agent_type ?? null } : {}),
});

export interface NormalizedEvent {
  kind: EventKind;
  dedupeKey: string;
  ccSession: string | null;
  payload: Record<string, unknown>;
}

/** Commands we treat as "test results". Other Bash commands are not development checkpoints. */
export const TEST_COMMAND_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+(?:[^|;&]*\s)?--test\b|\b(?:jest|vitest|mocha|ava|pytest|tox|rspec|phpunit)\b|\bgo\s+test\b|\bcargo\s+(?:test|nextest)\b|\b(?:mvn|gradle|gradlew)\b[^|;&]*\btest\b|\bmake\s+(?:test|check)\b|\bdeno\s+test\b/;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function relInRepo(repoRoot: string, filePath: unknown): string | null {
  if (typeof filePath !== "string" || !filePath) return null;
  const abs = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
  const inside = (r: string) => !!r && !r.startsWith("..") && !path.isAbsolute(r);
  let rel = path.relative(repoRoot, abs);
  // Paths may be spelled through symlinks (/tmp -> /private/tmp on macOS) while the root is a real path.
  if (!inside(rel)) rel = path.relative(realPathish(repoRoot), realPathish(abs));
  if (!inside(rel)) return null; // outside the repo: not ours
  return rel.split(path.sep).join("/");
}

// Redact BEFORE truncating, so a secret cut in half by truncation is still recognised.
const clean = (s: string, max: number) => truncate(redact(s).text, max);

/** Pass/fail from hook data. PostToolUseFailure is authoritative; output parsing is a labelled heuristic. */
function testStatus(hookEvent: string, output: string): { status: "passed" | "failed" | "unknown"; source: string } {
  if (hookEvent === "PostToolUseFailure") return { status: "failed", source: "PostToolUseFailure hook" };
  const failRe = /(^|\n)\s*#?\s*fail(?:ed|ures?)?\s*[:=]?\s*[1-9]\d*|\bnot ok\b|\b[1-9]\d* (?:failed|failing)\b|FAILED|✖|Tests:\s+[1-9]\d* failed/i;
  const passRe = /(^|\n)\s*#?\s*fail\s+0\b|\b0 failed\b|\ball tests passed\b|\bpassed\b|✔|\bok\b/i;
  if (failRe.test(output)) return { status: "failed", source: "output heuristic" };
  if (passRe.test(output)) return { status: "passed", source: "output heuristic" };
  return { status: "unknown", source: "output heuristic" };
}

/**
 * Map one Claude Code hook payload (stdin JSON, documented at code.claude.com/docs/en/hooks)
 * to a development event, or null if it is not relevant to oversight.
 */
export function normalizeHook(input: Record<string, any>, repoRoot: string, nowMs: number): NormalizedEvent | null {
  const ev = String(input.hook_event_name ?? "");
  const session = typeof input.session_id === "string" ? input.session_id : null;
  const minute = Math.floor(nowMs / 60_000);

  switch (ev) {
    case "UserPromptSubmit": {
      const prompt = String(input.prompt ?? "");
      if (!prompt.trim()) return null;
      const id = input.prompt_id ? String(input.prompt_id) : `${sha256(prompt).slice(0, 16)}:${minute}`;
      return {
        kind: "prompt",
        dedupeKey: `prompt:${session}:${id}`,
        ccSession: session,
        payload: { prompt: clean(prompt, 8000), permission_mode: input.permission_mode ?? null, ...ids(input) },
      };
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const tool = String(input.tool_name ?? "");
      const toolInput = (input.tool_input ?? {}) as Record<string, any>;
      const key = input.tool_use_id
        ? `tool:${input.tool_use_id}`
        : `tool:${session}:${sha256(JSON.stringify([tool, toolInput])).slice(0, 24)}:${minute}`;
      if (EDIT_TOOLS.has(tool)) {
        const rel = relInRepo(repoRoot, toolInput.file_path ?? toolInput.notebook_path);
        if (!rel) return null;
        const change: Record<string, unknown> = { tool };
        const denied = deniedPathReason(rel);
        if (denied) {
          // Credential/excluded file: record that it changed, never its content.
          change.excluded = denied;
        } else if (tool === "Edit") {
          change.old_chars = String(toolInput.old_string ?? "").length;
          change.new_chars = String(toolInput.new_string ?? "").length;
          change.new_preview = clean(String(toolInput.new_string ?? ""), 600);
        } else if (tool === "Write") {
          change.chars = String(toolInput.content ?? "").length;
        } else if (tool === "MultiEdit") {
          change.edits = Array.isArray(toolInput.edits) ? toolInput.edits.length : null;
        }
        return { kind: "edit", dedupeKey: key, ccSession: session, payload: { path: rel, failed: ev === "PostToolUseFailure", ...change, ...ids(input) } };
      }
      if (tool === "Bash") {
        const command = String(toolInput.command ?? "");
        if (!TEST_COMMAND_RE.test(command)) return null;
        const resp = (input.tool_response ?? {}) as Record<string, any>;
        const output =
          typeof resp === "string"
            ? resp
            : [resp.stdout, resp.stderr, input.error].filter((x) => typeof x === "string" && x).join("\n");
        const { status, source } = testStatus(ev, output);
        return {
          kind: "test",
          dedupeKey: key,
          ccSession: session,
          payload: { command: clean(command, 500), status, status_source: source, output_tail: tail(redact(output).text, 2000), ...ids(input) },
        };
      }
      return null;
    }
    case "Stop": {
      const msg = String(input.last_assistant_message ?? "");
      return {
        kind: "stop",
        dedupeKey: `stop:${session}:${input.prompt_id ?? ""}:${sha256(msg).slice(0, 16)}${input.prompt_id ? "" : `:${minute}`}`,
        ccSession: session,
        payload: { coding_agent_message: clean(msg, 6000), stop_hook_active: Boolean(input.stop_hook_active), ...ids(input) },
      };
    }
    case "SessionStart":
      return {
        kind: "session",
        dedupeKey: `session:${session}:${input.source ?? ""}:${minute}`,
        ccSession: session,
        payload: { source: input.source ?? null, model: input.model ?? null },
      };
    default:
      return null;
  }
}

/** Read HEAD without spawning git (keeps hooks fast). Returns null on unusual layouts. */
export function readHeadCheap(repoRoot: string): string | null {
  try {
    let gitDir = path.join(repoRoot, ".git");
    const st = fs.statSync(gitDir);
    if (st.isFile()) {
      const m = fs.readFileSync(gitDir, "utf8").match(/gitdir:\s*(.+)/);
      if (!m) return null;
      gitDir = path.resolve(repoRoot, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = head.match(/^ref:\s*(.+)$/)?.[1];
    if (!ref) return null;
    const refFile = path.join(gitDir, ref);
    if (fs.existsSync(refFile)) return fs.readFileSync(refFile, "utf8").trim();
    // Linked worktrees keep branch refs in the common git dir.
    const commonFile = path.join(gitDir, "commondir");
    const common = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, "utf8").trim()) : gitDir;
    if (common !== gitDir && fs.existsSync(path.join(common, ref))) return fs.readFileSync(path.join(common, ref), "utf8").trim();
    const packed = path.join(common, "packed-refs");
    if (fs.existsSync(packed)) {
      const line = fs.readFileSync(packed, "utf8").split("\n").find((l) => l.endsWith(` ${ref}`));
      if (line) return line.split(" ")[0];
    }
    return null;
  } catch {
    return null;
  }
}

/** Insert-or-ignore: duplicate hook deliveries (same dedupe key) are dropped. Returns true if new. */
export function enqueueEvent(db: DB, ev: NormalizedEvent, head: string | null, nowMs: number): boolean {
  const r = db
    .prepare("INSERT OR IGNORE INTO events(dedupe_key, kind, cc_session, ts, ts_ms, head, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(ev.dedupeKey, ev.kind, ev.ccSession, new Date(nowMs).toISOString(), nowMs, head, JSON.stringify(ev.payload));
  return Number(r.changes) > 0;
}
