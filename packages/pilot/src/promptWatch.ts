/**
 * Prompt watching (docs/prompt-watch.md): Pilot reads what the person asks their Claude Code sessions and tells
 * them, in the chat, when they are forgetting something it can quote. It runs in the daemon, never in a hook.
 *
 * One check per human prompt (quick follow-ups in one session merge), at most one nudge per check:
 *  1. trigger: a human UserPromptSubmit (no agent_id, not an automated turn), once the session has been quiet for
 *     prompt_quiet_ms (8 s); a finished turn in between keeps two prompts apart. Prompts older than 10 min when the
 *     daemon sees them are not checked.
 *  2. skip without a model run: prompts under 15 characters unless they approve something risky the session just
 *     proposed; a session nudged in the last 10 min unless the prompt starts something risky; paused; no budget.
 *  3. `claude -p` (oneshot.ts: isolated, no tools, prompt_check_model, 90 s) over the context promptContext.ts builds.
 *  4. code decides: every quote must match its source (else the nudge is dropped), at least one quote is not the
 *     new prompt itself, confidence >= nudge_min_confidence (0.85 for a kind marked "not useful" 3 times), never a
 *     repeat (kind + normalised quotes), at most one nudge per session per 10 min except `risky`.
 *  5. a nudge becomes a chat message and, with nudge_to_session "all" (default), is queued for its session. The
 *     session gets it mid-turn (the next tool call, before a Bash call runs), else at its next prompt or turn end.
 * Every check is recorded in watch_runs (activity) with its cost; nothing about prompt text goes in its summary.
 */
import type { ChildProcess } from "node:child_process";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { tx } from "./db.ts";
import type { DB } from "./home.ts";
import { kvGetReg, pilotHome } from "./home.ts";
import { insertMessage, NUDGE_KINDS, sessionEnded, type ChatRow, type Evidence, type NudgeKind } from "./chat.ts";
import { machineBudget } from "./budget.ts";
import { ENGINE_NAME, fallbackNote, think, type ThinkResult } from "./engines.ts";
import type { ThinkEngine } from "./config.ts";
import { buildAskContext, buildCheckContext, loadPrompts, loadSessions, loadTurns, locateQuote, normQuote, resolveEvidence, turnBefore, type BuiltContext, type PromptRow, type Source } from "./promptContext.ts";
import { redact } from "./secrets.ts";
import { selfTestStatus } from "./selftest.ts";
import { repoNameFor, sessionLabel } from "./sessionInfo.ts";
import { sha256 } from "./util.ts";

export const SPACING_MS = 10 * 60_000;
export const MAX_PROMPT_AGE_MS = 10 * 60_000;
export const SHORT_PROMPT = 15;
export const SEND_CONFIDENCE = 0.8;
export const RAISED_BAR = 0.85;
export const NOT_USEFUL_LIMIT = 3;

/** A session's last message proposing one of these makes a short "yes" / "go" worth checking. */
const RISKY_APPROVAL = /\b(merg(?:e|es|ed|ing)|prod|production|deploy\w*|delet\w*|send|sending|publish\w*|push\w*)\b/i;
/** A prompt that may start something hard to undo (a `risky` nudge can pass the 10-minute spacing). */
const RISKY_WORDS =
  /\b(merg\w*|prod|production|deploy\w*|release\w*|delet\w*|drop|remove|destroy|wipe|truncate|reset|force|send|post|publish\w*|push\w*|pay\w*|money|refund\w*|charg\w*|migrat\w*|revok\w*|rotat\w*|kubectl|dispatch|apply|terraform|invite|close)\b/i;

// ---------------------------------------------------------------------------------------------------------------
// Trigger, debounce and skip rules (pure)

/**
 * Unchecked prompts, grouped per session: quick follow-ups merge, but a finished turn (`turnTimes`) between two prompts
 * starts a new group. A group is due once its session has been quiet for quietMs; prompts older than maxAgeMs apart.
 */
export function duePrompts(
  rows: PromptRow[],
  nowMs: number,
  quietMs: number,
  maxAgeMs = MAX_PROMPT_AGE_MS,
  turnTimes: Map<string, number[]> = new Map(),
): { due: PromptRow[][]; waiting: number; stale: PromptRow[] } {
  const unchecked = rows.filter((r) => r.checkId === null);
  const stale = unchecked.filter((r) => nowMs - r.tsMs > maxAgeMs);
  const bySession = new Map<string, PromptRow[]>();
  for (const r of unchecked) {
    if (nowMs - r.tsMs > maxAgeMs) continue;
    bySession.set(r.session, [...(bySession.get(r.session) ?? []), r]);
  }
  const due: PromptRow[][] = [];
  let waiting = 0;
  for (const [session, list] of bySession) {
    list.sort((a, b) => a.tsMs - b.tsMs);
    const turns = turnTimes.get(session) ?? [];
    const groups: PromptRow[][] = [];
    for (const p of list) {
      const g = groups.at(-1);
      if (g && !turns.some((t) => t > g.at(-1)!.tsMs && t < p.tsMs)) g.push(p);
      else groups.push([p]);
    }
    for (const g of groups) {
      if (nowMs - groups.at(-1)!.at(-1)!.tsMs >= quietMs || g !== groups.at(-1)) due.push(g);
      else waiting++;
    }
  }
  due.sort((a, b) => a.at(-1)!.tsMs - b.at(-1)!.tsMs);
  return { due, waiting, stale };
}

/** Why a prompt group needs no model run, or null. */
export function skipReason(prompts: PromptRow[], lastTurn: string | null): string | null {
  if (prompts.some((p) => p.text.trim().length >= SHORT_PROMPT)) return null;
  if (lastTurn && RISKY_APPROVAL.test(lastTurn)) return null;
  return "short prompt, nothing risky to approve";
}

export const startsRisky = (prompts: PromptRow[]): boolean => prompts.some((p) => RISKY_WORDS.test(p.text));

// ---------------------------------------------------------------------------------------------------------------
// The model's job

export const CHECK_SCHEMA = {
  type: "object",
  properties: {
    why: { type: "string", description: "One or two sentences: why you speak or stay silent." },
    speak: { type: "boolean" },
    kind: { type: "string", enum: [...NUDGE_KINDS, "none"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: {
      type: "array",
      maxItems: 3,
      items: { type: "object", properties: { ref: { type: "string" }, quote: { type: "string" } }, required: ["ref", "quote"], additionalProperties: false },
    },
    text: { type: "string", description: "To the person: one or two plain sentences. Empty when silent." },
    for_session: { type: "string", description: "To the coding session, third person. Empty when silent." },
  },
  required: ["why", "speak", "kind", "confidence", "evidence", "text", "for_session"],
  additionalProperties: false,
} as const;

export const CHECK_SYSTEM = `You are Pilot. You watch what one person types into their Claude Code sessions, and you tell them, in a short chat message, when the prompt they just sent shows them forgetting something. You never do the work and you never talk to the coding session yourself.

Silence is the normal result. Most prompts are fine: return speak=false unless one of the kinds below clearly applies AND you can quote the thing being forgotten from the context.

Kinds. Pick the first one that fits, in this order:
- rule: the new prompt goes against, or skips, a standing rule the person wrote (a CLAUDE.md / CLAUDE.local.md line or a memory file in section 4). The coding session already has its CLAUDE.md loaded, so only speak about a rule when the prompt itself conflicts with it (it asks for what the rule forbids, or gives an approval in a form the rule does not accept) or when the session is likely to skip it.
- earlier: the person said something earlier (in this session or another one, sections 2-3) that the new prompt drops or contradicts.
- pending: something is waiting on the person and the new prompt moves on without it: another session ended its turn with a question to the person that was never answered (section 5), a Pilot nudge they never saw, or something they said they would decide later. When section 5 lists an unanswered question from another session and the new prompt neither answers it nor is about it, remind them of that question (that is the whole point: the other session is blocked until they answer).
- missing: the prompt lacks something the session needs and will likely guess wrong (which sandbox, which branch, which environment), and the answer is in the context.
- risky: the prompt starts something hard to undo (production, merge, delete, send, money) and a relevant fact from the context is not in the prompt.

Never speak about: style or wording, "you could also", general advice, praise, restating the prompt, anything the session can see for itself, anything you cannot quote exactly. Do not invent rules. Terse prompts, typos and informal approvals ("go", "yes", "ok") are normal and fine on their own.

Evidence: 1 to 3 items {ref, quote}. ref is the bracketed id of a source in the context (P…, S…, R…, N…). quote is copied character for character from that source: one line or a short passage, without the "12| " line-number prefix. At least one quote must show the thing being forgotten (the rule, the earlier statement, the unanswered question), not just the new prompt. Quote the line that carries the content, never a heading or a label alone ("## Rules", "Your calls:"). A quote that does not match its source makes Pilot drop the whole message.

text: one or two plain sentences to the person, in the second person: what they are about to forget and why it matters now. No preamble, no hedging, no ids in brackets.
for_session: one or two sentences for the coding session, in the third person ("The user's rule says …", "Earlier the user said …"), stating only the fact.
confidence: 0 to 1, how sure you are that this is a real lapse the person would thank you for. Below 0.7 means stay silent.
When silent: speak=false, kind "none", confidence 0, evidence [], text "", for_session "".`;

export const ASK_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    evidence: {
      type: "array",
      maxItems: 4,
      items: { type: "object", properties: { ref: { type: "string" }, quote: { type: "string" } }, required: ["ref", "quote"], additionalProperties: false },
    },
  },
  required: ["text", "evidence"],
  additionalProperties: false,
} as const;

export const ASK_SYSTEM = `You are Pilot, a quiet assistant that watches what one person asks their Claude Code sessions. Answer the person's question about their own sessions, using only the context: their prompts, what their sessions said at the end of their turns, open items, their written rules and memory, and the chat so far.

Lead with the answer. Be brief and concrete: at most six short sentences or a short list, plain words, no preamble. If the context does not hold the answer, say so plainly. Never invent sessions, prompts or rules. Do not write the bracketed ids in the text.

Evidence: 0 to 4 items {ref, quote} backing the answer. ref is the bracketed id of a source (P…, S…, R…, N…); quote is copied character for character from that source, without any "12| " line-number prefix. Quote the line that carries the content, never a heading or a label alone.`;

// ---------------------------------------------------------------------------------------------------------------
// Deciding (pure)

export interface PriorNudge {
  id: number;
  session: string | null;
  kind: string | null;
  atMs: number;
  fingerprint: string | null;
  /** For rule nudges: the rule lines cited (path:line), so the same rule is not repeated to one session within a day. */
  ruleLines?: string[];
}

export const RULE_REPEAT_MS = 24 * 3600_000;
const ruleLinesOf = (ev: Evidence[]): string[] => [...new Set(ev.filter((e) => e.source === "rule" || e.source === "memory").map((e) => e.where))].sort();

export type Verdict =
  | { action: "nudge"; kind: NudgeKind; text: string; forSession: string; confidence: number; evidence: Evidence[]; fingerprint: string; why: string; removed?: string[] }
  | { action: "silent" | "dropped" | "held"; why: string; kind?: NudgeKind; text?: string; confidence?: number; evidence?: Evidence[]; removed?: string[] };

// ---------------------------------------------------------------------------------------------------------------
// Grounding: every sentence of a nudge must be supported by its quotes or the new prompt

export const GROUND_SCHEMA = {
  type: "object",
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object",
        properties: { n: { type: "integer" }, supported: { type: "boolean" }, why: { type: "string" } },
        required: ["n", "supported", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["sentences"],
  additionalProperties: false,
} as const;

export const GROUND_SYSTEM = `You check a short message, sentence by sentence, against the only sources it may rely on: the new prompt the person typed, and the quotes listed under it (each was already checked word for word against its file, prompt or message; "where it sits" shows the rest of the quoted line or message).

A sentence is supported when those sources state it, or it follows directly from them. A question to the person, or a suggestion that only asks them to do what a quoted rule requires, is supported when the rest of it is.
A sentence is not supported when it adds anything the sources do not say: a fact, a time ("3 minutes ago"), a number, a consequence, a claim about what the person said, meant or wants.
Read the new prompt first: it is the person's latest word. A sentence that tells them, or the session, what they said or wanted earlier is not supported when the new prompt says the opposite (for example the sentence says they wanted to wait and the new prompt says not to wait), even though an older quote says it. The person changing their mind is not a lapse.

Answer for every numbered sentence: {n, supported, why}, with why in a few words.`;

/** Sentences, split at ., ! or ? followed by a space and a capital, a digit or a quote mark. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=["\u201C'(\[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Where a checked quote sits: for a file, its whole line(s); for a prompt or message, the text around it. A sentence
 * may paraphrase the rest of a quoted rule's line, so the check sees that line, not just the quoted words.
 */
export function sourceExcerpt(sources: Map<string, Source> | undefined, e: Evidence): string | null {
  if (!sources) return null;
  for (const src of sources.values()) {
    if (src.kind !== e.source) continue;
    const hit = locateQuote(src.text, e.quote);
    if (!hit.found) continue;
    if (src.kind === "rule" || src.kind === "memory") {
      // The quoted line and the rest of its section (a heading's body, a bullet's continuation), up to the next heading.
      const lines = src.text.split("\n");
      const out: string[] = [];
      for (let i = hit.line! - 1; i < lines.length && out.join("\n").length < 900; i++) {
        if (i > hit.line! - 1 && /^#{1,6} /.test(lines[i])) break;
        out.push(lines[i]);
      }
      return out.join("\n").trim().slice(0, 900);
    }
    const flat = src.text.replace(/\s+/g, " ").trim();
    if (flat.length <= 900) return flat;
    const i = flat.toLowerCase().indexOf(e.quote.replace(/\s+/g, " ").trim().slice(0, 30).toLowerCase());
    const at = Math.max(0, i < 0 ? 0 : i - 350);
    return `${at > 0 ? "…" : ""}${flat.slice(at, at + 900)}…`;
  }
  return null;
}

/** The grounding run's input: the new prompt, the checked quotes (with their lines), and the numbered sentences. */
export function groundingInput(prompts: PromptRow[], v: Extract<Verdict, { action: "nudge" }>, sources?: Map<string, Source>): { input: string; person: string[]; session: string[] } {
  const person = splitSentences(v.text);
  const session = splitSentences(v.forSession);
  const quotes = v.evidence
    .map((e) => {
      const ex = sourceExcerpt(sources, e);
      return `- ${e.source} (${e.where}): "${e.quote.replace(/\s+/g, " ").trim()}"${ex ? `\n  where it sits: ${ex.replace(/\n/g, "\n  ")}` : ""}`;
    })
    .join("\n");
  const numbered = (xs: string[], from: number) => xs.map((x, i) => `${from + i}. ${x}`).join("\n");
  return {
    person,
    session,
    input: [
      `# The new prompt\n${prompts.map((p) => p.text).join("\n\n")}`,
      `# Quotes (checked against their sources)\n${quotes}`,
      `# Message sentences, to the person\n${numbered(person, 1)}`,
      `# Message sentences, for the coding session\n${numbered(session, person.length + 1)}`,
    ].join("\n\n"),
  };
}

/**
 * Keeps only the supported sentences. A nudge with no supported sentence for the person is dropped; when the run
 * itself fails, the nudge is dropped too (an unchecked claim is never shown).
 */
export function applyGrounding(v: Extract<Verdict, { action: "nudge" }>, g: { person: string[]; session: string[] }, out: unknown): Verdict {
  const rows = (Array.isArray((out as { sentences?: unknown })?.sentences) ? (out as { sentences: unknown[] }).sentences : []) as Array<{ n?: unknown; supported?: unknown }>;
  const ok = (n: number) => rows.some((r) => Number(r.n) === n && r.supported === true);
  const person = g.person.filter((_, i) => ok(i + 1));
  const session = g.session.filter((_, i) => ok(g.person.length + i + 1));
  const removed = [...g.person.filter((_, i) => !ok(i + 1)), ...g.session.filter((_, i) => !ok(g.person.length + i + 1))];
  if (!person.length) return { action: "dropped", why: "no sentence of the message was supported by its quotes or the prompt", kind: v.kind, text: v.text, confidence: v.confidence, evidence: v.evidence, removed };
  return { ...v, text: person.join(" "), forSession: session.length ? session.join(" ") : person.join(" "), removed };
}

export const fingerprintOf = (kind: string, quotes: string[]): string => sha256(`${kind}\n${quotes.map(normQuote).sort().join("\n")}`).slice(0, 24);

export interface EvaluateOptions {
  session: string;
  nowMs: number;
  minConfidence: (kind: NudgeKind) => number;
  prior: PriorNudge[];
  newRefs: Set<string>;
}

const cleanText = (v: unknown, max: number): string => redact(String(v ?? "").replace(/\s+/g, " ").trim()).text.slice(0, max);

export function evaluate(out: unknown, ctx: Pick<BuiltContext, "sources">, o: EvaluateOptions): Verdict {
  const x = out as Record<string, unknown> | null;
  if (!x || typeof x !== "object") return { action: "dropped", why: "no valid answer from the model" };
  const why = cleanText(x.why, 400);
  if (x.speak !== true) return { action: "silent", why };
  const kind = x.kind as NudgeKind;
  if (!NUDGE_KINDS.includes(kind)) return { action: "dropped", why: `unknown kind "${String(x.kind)}"` };
  const confidence = Number(x.confidence);
  const min = o.minConfidence(kind);
  const text = cleanText(x.text, 600);
  if (!(confidence >= min)) return { action: "silent", why: `confidence ${Number.isFinite(confidence) ? confidence.toFixed(2) : "?"} below ${min} (${why})`, kind, text, confidence };
  if (!text) return { action: "dropped", why: "empty message", kind };
  const items = (Array.isArray(x.evidence) ? x.evidence : []).slice(0, 3) as Array<{ ref?: unknown; quote?: unknown }>;
  const evidence = resolveEvidence(ctx.sources, items);
  if (!evidence.length) return { action: "dropped", why: "no quote", kind, text, confidence };
  const bad = evidence.find((e) => !e.found);
  if (bad) return { action: "dropped", why: `a quote did not match its source (${bad.source})`, kind, text, confidence, evidence };
  const refOf = (i: { ref?: unknown }) => String(i.ref ?? "").replace(/[[\]\s]/g, "");
  if (items.every((i) => o.newRefs.has(refOf(i)))) return { action: "dropped", why: "it quotes only the new prompt, not what is being forgotten", kind, text, confidence, evidence };
  // A reminder of something waiting (pending) is the same reminder whichever new prompt it is attached to.
  const waiting = kind === "pending" ? evidence.filter((e) => e.source === "session" || e.source === "nudge") : [];
  const fingerprint = fingerprintOf(kind, (waiting.length ? waiting : evidence).map((e) => e.quote));
  const dup = o.prior.find((p) => p.fingerprint === fingerprint);
  if (dup) return { action: "dropped", why: `repeats nudge #${dup.id}`, kind, text, confidence, evidence };
  // The same rule lines told to the same session within a day (a resubmitted or reworded prompt) is a repeat too.
  const lines = kind === "rule" ? ruleLinesOf(evidence).join("\n") : "";
  const sameRule = lines
    ? o.prior.find((p) => p.kind === "rule" && p.session === o.session && o.nowMs - p.atMs < RULE_REPEAT_MS && (p.ruleLines ?? []).join("\n") === lines)
    : undefined;
  if (sameRule) return { action: "dropped", why: `repeats nudge #${sameRule.id} (same rule, same session, within a day)`, kind, text, confidence, evidence };
  const recent = kind !== "risky" ? o.prior.find((p) => p.session === o.session && p.atMs <= o.nowMs && o.nowMs - p.atMs < SPACING_MS) : undefined;
  if (recent) return { action: "held", why: `Pilot spoke to this session ${Math.max(1, Math.round((o.nowMs - recent.atMs) / 60_000))} min ago (10 min spacing)`, kind, text, confidence, evidence };
  return { action: "nudge", kind, text, forSession: cleanText(x.for_session, 600) || text, confidence, evidence, fingerprint, why };
}

/** The confidence a kind needs: nudge_min_confidence, raised to 0.85 once the person marked 3 of that kind "not useful". */
export function minConfidenceFor(cfg: Pick<Config, "nudgeMinConfidence">, notUseful: Partial<Record<string, number>>): (k: NudgeKind) => number {
  return (k) => ((notUseful[k] ?? 0) >= NOT_USEFUL_LIMIT ? Math.max(cfg.nudgeMinConfidence, RAISED_BAR) : cfg.nudgeMinConfidence);
}

/** Whether a nudge also goes into its session's next turn (nudge_to_session; `delivery: inbox` keeps Pilot quiet). */
/**
 * Whether a nudge also goes into its session (nudge_to_session): "all" (default) sends every nudge that passed the
 * checks; "risky" only rule and risky nudges with confidence >= 0.8; "off" none. `delivery: inbox` keeps Pilot out.
 */
export function routesToSession(cfg: Pick<Config, "nudgeToSession" | "delivery">, kind: NudgeKind, confidence: number): boolean {
  if (cfg.delivery !== "session" || cfg.nudgeToSession === "off") return false;
  if (cfg.nudgeToSession === "all") return true;
  return confidence >= SEND_CONFIDENCE && (kind === "rule" || kind === "risky");
}

// ---------------------------------------------------------------------------------------------------------------
// Registry helpers

export function priorNudges(reg: DB): PriorNudge[] {
  return (reg.prepare("SELECT id, session, nudge_kind, at_ms, fingerprint, evidence_json FROM chat_messages WHERE kind = 'nudge' ORDER BY id").all() as Array<{
    id: number;
    session: string | null;
    nudge_kind: string | null;
    at_ms: number;
    fingerprint: string | null;
    evidence_json: string;
  }>).map((r) => ({
    id: Number(r.id),
    session: r.session,
    kind: r.nudge_kind,
    atMs: Number(r.at_ms),
    fingerprint: r.fingerprint,
    ruleLines: r.nudge_kind === "rule" ? ruleLinesOf(JSON.parse(r.evidence_json || "[]") as Evidence[]) : undefined,
  }));
}

export function notUsefulCounts(reg: DB): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reg.prepare("SELECT nudge_kind AS k, COUNT(*) AS n FROM chat_messages WHERE kind = 'nudge' AND state = 'not_useful' GROUP BY nudge_kind").all() as Array<{ k: string; n: number }>) out[r.k] = Number(r.n);
  return out;
}

export const recentNudges = (reg: DB, sinceMs: number): ChatRow[] =>
  reg.prepare("SELECT * FROM chat_messages WHERE kind = 'nudge' AND at_ms >= ? ORDER BY id").all(sinceMs) as unknown as ChatRow[];

/** A run is recorded with the engine it starts on; Claude's cap is reserved against the budget while it runs. */
function startRun(reg: DB, kind: "check" | "ask", session: string | null, repo: string | null, nowMs: number, engine: ThinkEngine, cfg: Config): number {
  return Number(
    reg
      .prepare("INSERT INTO watch_runs(kind, session, repo, created_ms, status, reserved_cents, engine) VALUES (?, ?, ?, ?, 'running', ?, ?)")
      .run(kind, session, repo, nowMs, engine === "claude" ? cfg.promptCheckBudgetCents : 0, engine).lastInsertRowid,
  );
}

function finishRun(reg: DB, id: number, status: string, summary: string, costCents: number, messageId: number | null = null, engine?: ThinkEngine): void {
  reg
    .prepare("UPDATE watch_runs SET status = ?, summary = ?, cost_cents = ?, reserved_cents = 0, finished_ms = ?, message_id = ?, engine = COALESCE(?, engine) WHERE id = ?")
    .run(status, summary, costCents, Date.now(), messageId, engine ?? null, id);
}

/** Room left in the machine-wide budget window for one more call capped at `cents`. */
export function budgetRoom(cfg: Config, cents: number): string | null {
  const b = machineBudget(cfg);
  return b.availableCents >= cents ? null : `budget: $${(b.spentCents / 100).toFixed(2)} spent + $${(b.reservedCents / 100).toFixed(2)} reserved of $${(b.capCents / 100).toFixed(2)} in the last ${cfg.budgetWindowHours} h`;
}

/** Activity summary of a run that did not answer (plain words; never prompt text). */
const failure = (r: ThinkResult): string =>
  r.timedOut
    ? "failed: no answer within the time limit"
    : r.error === "cancelled"
      ? "cancelled"
      : r.error && /installed|signed out|usage limit|self-test|budget|could not start/.test(r.error)
        ? `skipped: ${r.error}`
        : `failed: ${ENGINE_NAME[r.engine]} stopped without an answer (see daemon.log)`;

// ---------------------------------------------------------------------------------------------------------------
// One check

export interface CheckOutcome {
  status: "nudge" | "silent" | "dropped" | "held" | "skipped" | "failed";
  summary: string;
  costCents: number;
  verdict?: Verdict;
  context?: BuiltContext;
  error?: string;
  durationMs?: number;
  /** Token counts of the model runs (Claude), for cost analysis. */
  usage?: { input: number; output: number; cacheWrite: number; cacheRead: number; costUsd: number };
  /** The engine that answered, and why it was not the one asked for. */
  engine?: ThinkEngine;
  fallback?: string | null;
}

export interface CheckDeps {
  nowMs: number;
  prior: PriorNudge[];
  nudgesForOpen: ChatRow[];
  notUseful: Record<string, number>;
  onSpawn?: (c: ChildProcess) => void;
  /** Default: the `engine` setting. */
  engine?: ThinkEngine;
}

/** Runs one check for a session's prompt group and decides; records nothing (callers do). */
export async function checkPrompts(reg: DB, cfg: Config, group: PromptRow[], d: CheckDeps): Promise<CheckOutcome> {
  const session = group[0].session;
  const turns = loadTurns(reg, group[0].tsMs - 7 * 86_400_000, group[0].tsMs);
  const last = turnBefore(turns, session, group[0].tsMs);
  const skip = skipReason(group, last?.text ?? null);
  if (skip) return { status: "skipped", summary: `skipped: ${skip}`, costCents: 0 };
  const recent = d.prior.find((p) => p.session === session && p.atMs <= d.nowMs && d.nowMs - p.atMs < SPACING_MS);
  if (recent && !startsRisky(group)) return { status: "skipped", summary: `skipped: Pilot spoke to this session ${Math.max(1, Math.round((d.nowMs - recent.atMs) / 60_000))} min ago and nothing here is risky`, costCents: 0 };
  const context = buildCheckContext(reg, { session, prompts: group }, { nowMs: d.nowMs, nudges: d.nudgesForOpen });
  const r = await think(reg, cfg, d.engine ?? cfg.engine, {
    system: CHECK_SYSTEM,
    input: context.text,
    schema: CHECK_SCHEMA as unknown as Record<string, unknown>,
    timeoutMs: cfg.promptCheckTimeoutSec * 1000,
    prefix: "cpw-",
    onSpawn: d.onSpawn,
  });
  const by = { engine: r.engine, fallback: r.fallback };
  if (!r.ok) {
    const summary = failure(r);
    return { status: summary.startsWith("skipped") ? "skipped" : "failed", summary, costCents: r.costCents, context, error: r.error, durationMs: r.durationMs, usage: r.usage, ...by };
  }
  let verdict = evaluate(r.output, context, { session, nowMs: d.nowMs, minConfidence: minConfidenceFor(cfg, d.notUseful), prior: d.prior, newRefs: context.newRefs });
  let costCents = r.costCents;
  let usage = r.usage;
  if (verdict.action === "nudge") {
    // Only when a check produced a nudge: a second, small run checks each sentence against the quotes and the prompt.
    const g = groundingInput(group, verdict, context.sources);
    const gr = await think(reg, cfg, r.engine, {
      system: GROUND_SYSTEM,
      input: g.input,
      schema: GROUND_SCHEMA as unknown as Record<string, unknown>,
      timeoutMs: Math.min(60_000, cfg.promptCheckTimeoutSec * 1000),
      prefix: "cpw-",
      onSpawn: d.onSpawn,
    });
    costCents += gr.costCents;
    if (usage && gr.usage) usage = { input: usage.input + gr.usage.input, output: usage.output + gr.usage.output, cacheWrite: usage.cacheWrite + gr.usage.cacheWrite, cacheRead: usage.cacheRead + gr.usage.cacheRead, costUsd: usage.costUsd + gr.usage.costUsd };
    verdict = gr.ok
      ? applyGrounding(verdict, g, gr.output)
      : { action: "dropped", why: `the sentence check did not run (${gr.error ?? "no answer"})`, kind: verdict.kind, text: verdict.text, confidence: verdict.confidence, evidence: verdict.evidence };
  }
  const summary =
    verdict.action === "nudge"
      ? `nudge (${verdict.kind}, confidence ${verdict.confidence.toFixed(2)})`
      : verdict.action === "silent"
        ? "silent"
        : `${verdict.action}: ${verdict.why.replace(/\(.*$/, "").trim()}`;
  const instead = r.fallback ? ` · ${ENGINE_NAME[r.engine]} instead: ${r.fallback}` : "";
  const trimmed = verdict.action === "nudge" && verdict.removed?.length ? ` (${verdict.removed.length} unsupported sentence${verdict.removed.length > 1 ? "s" : ""} removed)` : "";
  return { status: verdict.action, summary: `${summary}${trimmed}${instead}`, costCents, verdict, context, durationMs: r.durationMs, usage, ...by };
}

/** Stores a nudge in the chat (and queues it for its session when routing says so). */
export function recordNudge(
  reg: DB,
  cfg: Config,
  v: Extract<Verdict, { action: "nudge" }>,
  session: string,
  nowMs: number,
  by: Pick<ThinkResult, "engine" | "fallback"> = { engine: cfg.engine, fallback: null },
): ChatRow {
  const sessions = loadSessions(reg, loadPrompts(reg, nowMs - 72 * 3600_000, nowMs).filter((p) => p.session === session));
  const s = sessions.get(session);
  const queued = routesToSession(cfg, v.kind, v.confidence) && !sessionEnded(reg, session);
  return insertMessage(reg, {
    atMs: nowMs,
    role: "pilot",
    kind: "nudge",
    nudgeKind: v.kind,
    text: `${v.text}${fallbackNote(by)}`,
    evidence: v.evidence,
    engine: by.engine,
    session,
    sessionLabel: s?.label ?? sessionLabel(null, null, session),
    repo: s?.repo ?? null,
    confidence: v.confidence,
    state: queued ? "sent" : "new",
    fingerprint: v.fingerprint,
    forSession: v.forSession,
    queued,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The daemon's loop

export class PromptWatcher {
  readonly reg: DB;
  readonly log: (m: string) => void;
  readonly ensureSelfTest?: (cfg: Config) => Promise<void>;
  private running: Promise<void> | null = null;
  private child: ChildProcess | null = null;
  private waiting = 0;

  constructor(reg: DB, log: (m: string) => void, ensureSelfTest?: (cfg: Config) => Promise<void>) {
    this.reg = reg;
    this.log = log;
    this.ensureSelfTest = ensureSelfTest;
  }

  /** A check is running, or a prompt is waiting for its session to go quiet. */
  busy(): boolean {
    return !!this.running || this.waiting > 0;
  }

  /** One pass: start at most one check (never blocks). */
  tick(paused: boolean): void {
    if (this.running) return;
    const cfg = loadConfig(pilotHome(), { cheap: true });
    const now = Date.now();
    const rows = loadPrompts(this.reg, now - MAX_PROMPT_AGE_MS - 3600_000, now).filter((r) => r.checkId === null);
    const turnTimes = new Map<string, number[]>();
    if (rows.length) for (const t of loadTurns(this.reg, now - MAX_PROMPT_AGE_MS - 3600_000, now)) turnTimes.set(t.session, [...(turnTimes.get(t.session) ?? []), t.tsMs]);
    const { due, waiting, stale } = duePrompts(rows, now, cfg.promptQuietMs, MAX_PROMPT_AGE_MS, turnTimes);
    this.waiting = waiting;
    if (stale.length) this.claim(stale, -1);
    if (!due.length) return;
    const group = due[0];
    const session = group[0].session;
    const repo = repoNameFor((this.reg.prepare("SELECT cwd FROM sessions WHERE session = ?").get(session) as { cwd: string | null } | undefined)?.cwd);
    if (paused || kvGetReg<boolean>(this.reg, "paused", false)) {
      const id = startRun(this.reg, "check", session, repo, now, cfg.engine, cfg);
      this.claim(group, id);
      finishRun(this.reg, id, "skipped", "skipped: paused", 0);
      return;
    }
    const id = startRun(this.reg, "check", session, repo, now, cfg.engine, cfg);
    this.claim(group, id);
    this.running = this.execute(cfg, id, group)
      .catch((e) => {
        this.log(`[prompt watch] check #${id} error: ${(e as Error).message}`);
        finishRun(this.reg, id, "failed", "failed: internal error (see daemon.log)", 0);
      })
      .finally(() => {
        this.running = null;
        this.child = null;
      });
  }

  private claim(group: PromptRow[], id: number): void {
    tx(this.reg, () => {
      const upd = this.reg.prepare("UPDATE session_prompts SET check_id = ? WHERE dedupe_key = ? AND check_id IS NULL");
      for (const p of group) upd.run(id, p.key);
    });
  }

  private async execute(cfg: Config, id: number, group: PromptRow[]): Promise<void> {
    if (cfg.engine === "claude" && !selfTestStatus(cfg).ok && this.ensureSelfTest) await this.ensureSelfTest(cfg);
    const now = Date.now();
    const out = await checkPrompts(this.reg, cfg, group, {
      nowMs: now,
      prior: priorNudges(this.reg),
      nudgesForOpen: recentNudges(this.reg, now - 48 * 3600_000),
      notUseful: notUsefulCounts(this.reg),
      onSpawn: (c) => (this.child = c),
    });
    let messageId: number | null = null;
    let summary = out.summary;
    if (out.verdict?.action === "nudge") {
      const m = recordNudge(this.reg, cfg, out.verdict, group[0].session, Date.now(), { engine: out.engine ?? cfg.engine, fallback: out.fallback ?? null });
      messageId = m.id;
      summary = `nudge #${m.id} (${m.nudge_kind}, confidence ${out.verdict.confidence.toFixed(2)})${m.queued_at_ms ? "; queued for its session (next tool call)" : ""}`;
    }
    if (out.error) this.log(`[prompt watch] check #${id}: ${out.error.slice(0, 300)}`);
    finishRun(this.reg, id, out.status, summary, out.costCents, messageId, out.engine);
    const took = out.durationMs ? ` · ${(out.durationMs / 1000).toFixed(1)} s` : "";
    this.log(`[prompt watch] check #${id} (${group.length} prompt${group.length > 1 ? "s" : ""}, ${out.engine ?? cfg.engine}): ${summary} · $${(out.costCents / 100).toFixed(2)}${took}`);
    if (out.verdict && process.env.PILOT_DEBUG_CHECKS === "1") this.log(`[prompt watch] check #${id} why: ${out.verdict.why}`);
  }

  /** Stop a running check (daemon shutdown). */
  async stop(): Promise<void> {
    if (!this.running) return;
    const { killGroup } = await import("./oneshot.ts");
    killGroup(this.child);
    await Promise.race([this.running, new Promise((r) => setTimeout(r, 10_000))]);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Chat: the person asks Pilot

export const MAX_QUESTION = 4000;

export interface AskResult {
  question: ChatRow;
  answer: ChatRow;
}

/**
 * Stores the question, answers it from the same kind of context (plus the thread's last 20 messages), checks every
 * quote (a quote that does not match is kept with found: false), stores the answer. On failure a note explains it
 * in the thread and the error is thrown.
 */
export async function askPilot(
  reg: DB,
  cfg: Config,
  raw: string,
  o: { onSpawn?: (c: ChildProcess) => void; shouldStop?: () => boolean; engine?: ThinkEngine } = {},
): Promise<AskResult> {
  const text = raw.trim();
  if (!text) throw new Error("--text is empty");
  if (text.length > MAX_QUESTION) throw new Error(`--text is longer than ${MAX_QUESTION} characters`);
  const now = Date.now();
  const thread = (reg.prepare("SELECT * FROM chat_messages ORDER BY id DESC LIMIT 20").all() as unknown as ChatRow[]).reverse();
  const question = insertMessage(reg, { atMs: now, role: "you", kind: "message", text });
  const chosen = o.engine ?? cfg.engine;
  const fail = (why: string, runId: number | null, cost = 0, engine: ThinkEngine = chosen): never => {
    // Cancelled by the person: the question stays, nothing else is added to the thread.
    if (why !== "cancelled") insertMessage(reg, { atMs: Date.now(), role: "pilot", kind: "note", text: `Pilot could not answer: ${why}.`, engine });
    if (runId !== null) finishRun(reg, runId, why === "cancelled" ? "cancelled" : "failed", why === "cancelled" ? "cancelled by the person" : `failed: ${why}`, cost, null, engine);
    throw new Error(why === "cancelled" ? "Cancelled." : `${why[0].toUpperCase()}${why.slice(1)}.`);
  };
  const runId = startRun(reg, "ask", null, null, now, chosen, cfg);
  const context = buildAskContext(reg, text, { nowMs: now, thread, nudges: recentNudges(reg, now - 48 * 3600_000) });
  const r = await think(reg, cfg, chosen, {
    system: ASK_SYSTEM,
    input: context.text,
    schema: ASK_SCHEMA as unknown as Record<string, unknown>,
    timeoutMs: cfg.askTimeoutSec * 1000,
    prefix: "cpa-",
    onSpawn: o.onSpawn,
    shouldStop: o.shouldStop,
  });
  if (!r.ok) {
    const why = r.timedOut ? `no answer within ${cfg.askTimeoutSec} s` : r.error === "cancelled" || o.shouldStop?.() ? "cancelled" : (r.error ?? "the model run failed").slice(0, 200);
    fail(why, runId, r.costCents, r.engine);
  }
  const out = r.output as { text?: unknown; evidence?: unknown };
  const answerText = String(out.text ?? "").trim();
  if (!answerText) fail("the model returned an empty answer", runId, r.costCents, r.engine);
  const evidence = resolveEvidence(context.sources, (Array.isArray(out.evidence) ? out.evidence : []).slice(0, 4) as Array<{ ref?: unknown; quote?: unknown }>);
  const answer = insertMessage(reg, { atMs: Date.now(), role: "pilot", kind: "answer", text: `${answerText}${fallbackNote(r)}`, evidence, engine: r.engine });
  const found = `${evidence.filter((e) => e.found).length}/${evidence.length} quotes found`;
  finishRun(reg, runId, "done", `answered by ${ENGINE_NAME[r.engine]} (${found})${r.fallback ? `; ${r.fallback}` : ""}`, r.costCents, answer.id, r.engine);
  return { question, answer };
}
