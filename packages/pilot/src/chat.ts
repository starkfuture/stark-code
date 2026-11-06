/**
 * The Pilot chat thread (registry table chat_messages): Pilot's nudges, the person's questions and Pilot's
 * answers, plus notes. One machine-wide thread, newest last.
 *
 *  - A nudge is unread until the person sees it (seen_ms), whatever else happens to it; `unread` counts those.
 *  - state: new -> seen (shown), sent (queued for its session's next turn, by the person or automatically for
 *    rule/risky nudges), dismissed, useful, not_useful.
 *  - Nudges queued for a session (queued_at_ms) reach it once (delivered_at_ms): mid-turn through the tool hooks
 *    (`deliver --tool`: before a Bash call, after any tool call), else at its next prompt (`deliver --context`) or
 *    at the end of its turn (`deliver --rewake`).
 *  - Every text and quote is redacted before it is stored.
 */
import fs from "node:fs";
import path from "node:path";
import type { DB } from "./home.ts";
import { pilotHome } from "./home.ts";
import { redact } from "./secrets.ts";
import { tx } from "./db.ts";
import { cleanLabel } from "./sessionInfo.ts";
import { parseJson } from "./util.ts";

export const NUDGE_KINDS = ["rule", "earlier", "pending", "missing", "risky"] as const;
export type NudgeKind = (typeof NUDGE_KINDS)[number];
export const SOURCES = ["rule", "memory", "prompt", "session", "nudge"] as const;
export type SourceKind = (typeof SOURCES)[number];
export const STATES = ["new", "seen", "sent", "dismissed", "useful", "not_useful"] as const;
export type MessageState = (typeof STATES)[number];
export type Role = "you" | "pilot";
export type MessageKind = "nudge" | "answer" | "message" | "note";

export interface Evidence {
  source: SourceKind;
  where: string;
  quote: string;
  found: boolean;
}

export interface ChatRow {
  id: number;
  at_ms: number;
  role: Role;
  kind: MessageKind;
  nudge_kind: NudgeKind | null;
  text: string;
  evidence_json: string;
  session: string | null;
  repo: string | null;
  confidence: number | null;
  state: MessageState;
  delivered_at_ms: number | null;
  session_label: string | null;
  fingerprint: string | null;
  for_session: string | null;
  queued_at_ms: number | null;
  seen_ms: number | null;
  engine: "claude" | "codex" | null;
}

export interface NewMessage {
  atMs: number;
  role: Role;
  kind: MessageKind;
  nudgeKind?: NudgeKind | null;
  text: string;
  evidence?: Evidence[];
  session?: string | null;
  sessionLabel?: string | null;
  repo?: string | null;
  confidence?: number | null;
  state?: MessageState;
  fingerprint?: string | null;
  forSession?: string | null;
  queued?: boolean;
  /** The engine that produced a Pilot message (null for the person's own). */
  engine?: "claude" | "codex" | null;
}

const clean = (s: string) => redact(s).text;

/**
 * A checked quote as people read it: Markdown emphasis (** and __), backticks, heading marks and leading list or
 * quote markers removed. Only applied after the quote was checked against its source, never before.
 */
export function displayQuote(q: string): string {
  return q
    .replace(/\*\*|__|`/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|(?:[-*+]|\d+[.)]|>)\s+)/, ""))
    .join("\n")
    .trim();
}

export function insertMessage(reg: DB, m: NewMessage): ChatRow {
  const evidence = (m.evidence ?? []).map((e) => ({ ...e, quote: clean(e.quote), where: clean(e.where) }));
  const id = Number(
    reg
      .prepare(
        `INSERT INTO chat_messages(at_ms, role, kind, nudge_kind, text, evidence_json, session, repo, confidence, state, session_label, fingerprint, for_session, queued_at_ms, seen_ms, engine)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.atMs,
        m.role,
        m.kind,
        m.nudgeKind ?? null,
        clean(m.text),
        JSON.stringify(evidence),
        m.session ?? null,
        m.repo ?? null,
        m.confidence ?? null,
        m.state ?? (m.kind === "nudge" ? "new" : "seen"),
        m.sessionLabel ?? null,
        m.fingerprint ?? null,
        m.forSession ? clean(m.forSession) : null,
        m.queued ? m.atMs : null,
        m.kind === "nudge" ? null : m.atMs,
        m.role === "you" ? null : (m.engine ?? null),
      ).lastInsertRowid,
  );
  if (m.queued) syncOutboxFlag(reg, m.atMs);
  return getMessage(reg, id)!;
}

export const getMessage = (reg: DB, id: number): ChatRow | undefined => reg.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as ChatRow | undefined;

/** The API shape (README "JSON API"); field names and values are a contract with apps. */
export function apiMessage(r: ChatRow): Record<string, unknown> {
  const ev = parseJson<Evidence[]>(r.evidence_json, []);
  return {
    id: Number(r.id),
    at: new Date(Number(r.at_ms)).toISOString(),
    role: r.role === "you" ? "you" : "pilot", // rows written before the rename said "lookout"
    kind: r.kind,
    nudgeKind: r.kind === "nudge" && NUDGE_KINDS.includes(r.nudge_kind as NudgeKind) ? r.nudge_kind : null,
    text: r.text,
    // The stored quote is the exact text that was checked; what apps show is the same text without Markdown dressing.
    evidence: (Array.isArray(ev) ? ev : []).map((e) => ({ source: e.source, where: cleanLabel(e.where), quote: displayQuote(e.quote), found: e.found === true })),
    session: r.session ?? null,
    sessionLabel: r.session_label ? cleanLabel(r.session_label) : null,
    repo: r.repo ?? null,
    state: STATES.includes(r.state) ? r.state : "new",
    engine: r.role === "you" || (r.engine !== "claude" && r.engine !== "codex") ? null : r.engine,
  };
}

/** The newest `limit` messages (after `since` when given), oldest first. */
export function listMessages(reg: DB, o: { since?: number; limit: number }): ChatRow[] {
  return (reg.prepare("SELECT * FROM chat_messages WHERE id > ? ORDER BY id DESC LIMIT ?").all(o.since ?? 0, o.limit) as unknown as ChatRow[]).reverse();
}

export const unreadCount = (reg: DB): number =>
  Number((reg.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE kind = 'nudge' AND seen_ms IS NULL AND state IN ('new','sent')").get() as { n: number }).n);

export const NUDGE_ACTIONS = ["send", "seen", "dismiss", "useful", "not_useful"] as const;
export type NudgeAction = (typeof NUDGE_ACTIONS)[number];

/** A session that has ended (SessionEnd hook) or that Pilot never saw cannot take a message any more. */
export function sessionEnded(reg: DB, session: string): boolean {
  const row = reg.prepare("SELECT ended_ms, updated_ms FROM sessions WHERE session = ?").get(session) as { ended_ms: number | null; updated_ms: number } | undefined;
  return !row || (row.ended_ms !== null && row.ended_ms >= row.updated_ms);
}

/** The person acts on one nudge. Throws with a plain message the API returns as its error. */
export function actOnNudge(reg: DB, id: number, action: NudgeAction, nowMs: number): ChatRow {
  return tx(reg, () => {
    const r = getMessage(reg, id);
    if (!r) throw new Error(`no message ${id}`);
    if (r.kind !== "nudge") throw new Error(`message ${id} is not a nudge`);
    const seen = r.seen_ms ?? nowMs;
    if (action === "seen") {
      reg.prepare("UPDATE chat_messages SET seen_ms = ?, state = CASE state WHEN 'new' THEN 'seen' ELSE state END WHERE id = ?").run(seen, id);
    } else if (action === "send") {
      if (!r.session) throw new Error("this nudge belongs to no session");
      if (r.delivered_at_ms === null && sessionEnded(reg, r.session)) throw new Error("session ended");
      reg.prepare("UPDATE chat_messages SET state = 'sent', seen_ms = ?, queued_at_ms = COALESCE(queued_at_ms, ?) WHERE id = ?").run(seen, nowMs, id);
      syncOutboxFlag(reg, nowMs);
    } else {
      const state = action === "dismiss" ? "dismissed" : action;
      reg.prepare("UPDATE chat_messages SET state = ?, seen_ms = ? WHERE id = ?").run(state, seen, id);
    }
    return getMessage(reg, id)!;
  });
}

export function markAllSeen(reg: DB, nowMs: number): number {
  return Number(
    reg.prepare("UPDATE chat_messages SET seen_ms = ?, state = CASE state WHEN 'new' THEN 'seen' ELSE state END WHERE kind = 'nudge' AND seen_ms IS NULL").run(nowMs).changes,
  );
}

/**
 * The text a session gets: short, plain, for Claude. What Pilot noticed (worded for the session), up to two quotes
 * with where they are from, and to check with the user.
 */
export function formatForSession(rows: ChatRow[]): string {
  return rows
    .map((r) => {
      const ev = parseJson<Evidence[]>(r.evidence_json, []).slice(0, 2);
      const quotes = ev.map((e) => `"${displayQuote(e.quote).replace(/\s+/g, " ")}" (${cleanLabel(e.where)})`).join("; ");
      return `Pilot (the user's assistant) noticed: ${(r.for_session ?? r.text).trim()}${quotes ? ` Quote: ${quotes}.` : ""} Check with the user before acting on it.`;
    })
    .join("\n\n");
}

/**
 * ~/.pilot/outbox-pending exists while a nudge queued in the last 24 h waits for its session. The tool hooks test for
 * this file in the shell and start Node only when it exists, so a tool call costs nothing when nothing is queued.
 */
export const outboxFlag = (): string => path.join(pilotHome(), "outbox-pending");
export function syncOutboxFlag(reg: DB, nowMs = Date.now()): void {
  try {
    const n = Number((reg.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE queued_at_ms >= ? AND delivered_at_ms IS NULL").get(nowMs - 86_400_000) as { n: number }).n);
    if (n) fs.writeFileSync(outboxFlag(), "", { mode: 0o600 });
    else fs.rmSync(outboxFlag(), { force: true });
  } catch {
    /* best effort: without the flag the next prompt or turn end still delivers */
  }
}

/** Claim the nudges queued for this session (each reaches the session once) and return the text, or "". */
export function claimQueued(reg: DB, session: string, nowMs: number): string {
  // One indexed read first: tool hooks call this on every tool call while anything is queued.
  const any = reg.prepare("SELECT 1 FROM chat_messages WHERE session = ? AND queued_at_ms IS NOT NULL AND delivered_at_ms IS NULL LIMIT 1").get(session);
  if (!any) return "";
  const rows = tx(reg, () => {
    const due = reg.prepare("SELECT * FROM chat_messages WHERE session = ? AND queued_at_ms IS NOT NULL AND delivered_at_ms IS NULL ORDER BY id").all(session) as unknown as ChatRow[];
    return due.filter((r) => Number(reg.prepare("UPDATE chat_messages SET delivered_at_ms = ? WHERE id = ? AND delivered_at_ms IS NULL").run(nowMs, r.id).changes) === 1);
  });
  syncOutboxFlag(reg, nowMs);
  return rows.length ? formatForSession(rows) : "";
}
