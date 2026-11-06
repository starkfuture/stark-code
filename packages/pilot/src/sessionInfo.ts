/**
 * Small, dependency-light helpers about sessions, shared by the hook (hot path) and prompt watching:
 * which prompts a person typed, a session's end-of-turn message, and how a session is labelled.
 */
import fs from "node:fs";
import path from "node:path";
import { findRepoRoot } from "./home.ts";
import { redact } from "./secrets.ts";

/**
 * Text that arrives through UserPromptSubmit but was not typed by the person: background task notifications,
 * subagent hand-backs, system reminders and local command output that Claude Code feeds back as a user turn.
 */
const AUTOMATED = /^\s*<(task-notification|agent-message|system-reminder|local-command-[a-z-]+|command-stdout|command-stderr|bash-stdout|bash-stderr|user-prompt-submit-hook)\b/i;

export function isHumanPrompt(text: string, payload: { agent_id?: unknown } = {}): boolean {
  if (payload.agent_id) return false; // a subagent's prompt is context, never checked
  return !!text.trim() && !AUTOMATED.test(text);
}

/** End-of-turn messages are kept head + tail (questions sit at the end), redacted, capped at 4k chars. */
export const TURN_CAP = 4000;
export function capTurn(text: string): string {
  const t = redact(text).text.trim();
  if (t.length <= TURN_CAP) return t;
  return `${t.slice(0, 1000)}\n[…]\n${t.slice(-(TURN_CAP - 1010))}`;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text as string)
          .join("\n")
      : "";

/**
 * The last assistant text in a Claude Code transcript (JSONL), reading only its tail (capped), for Stop payloads
 * that do not carry last_assistant_message. Null when it cannot be read.
 */
export function transcriptLastMessage(file: unknown, maxBytes = 256 * 1024): string | null {
  if (typeof file !== "string" || !file) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith("{")) continue;
      try {
        const m = JSON.parse(line);
        if (m?.type !== "assistant" || m?.isSidechain) continue;
        const t = textOf(m.message?.content).trim();
        if (t) return t;
      } catch {
        /* a line cut by the tail window */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** True when the final paragraph of a session's message asks the person something. */
export function endsWithQuestion(text: string): boolean {
  const paras = text.trim().split(/\n\s*\n/);
  const last = (paras.at(-1) ?? "").replace(/[*_`]/g, "");
  return last.split("\n").some((l) => /\?["')\]]*$/.test(l.trim()));
}

/** The repository a session works in: its git working tree's name, else the cwd's folder name. */
export function repoNameFor(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  try {
    const root = findRepoRoot(cwd);
    return path.basename(root ?? cwd) || null;
  } catch {
    return path.basename(cwd) || null;
  }
}

/**
 * Text a person can read: system-reminder blocks removed whole, other XML-ish tags (<pasted_content id="…">,
 * <command-name>, …) removed but their content kept, whitespace collapsed.
 */
export function readableText(s: string): string {
  return s
    .replace(/<system-reminder\b[^>]*>[\s\S]*?(<\/system-reminder>|$)/gi, " ")
    .replace(/<\/?[A-Za-z][\w:.-]*(\s[^<>]*)?\/?>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "repo · first prompt" with the first readable prompt cut to 40 characters, else "untitled". */
export function sessionLabel(repo: string | null, firstPrompt: string | null, _session: string): string {
  const p = firstPrompt ? readableText(firstPrompt) : "";
  const cut = p.length > 40 ? `${p.slice(0, 39)}…` : p;
  return `${repo ?? "no repo"} · ${cut || "untitled"}`;
}

/** A label stored before labels were cleaned (or a `where` built from one): tags stripped, readable again. */
export const cleanLabel = (label: string): string => readableText(label).replace(/ · $/, " · untitled");
