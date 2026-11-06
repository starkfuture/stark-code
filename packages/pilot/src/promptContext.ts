/**
 * What a prompt check (or a chat answer) gets to read, built by code from the registry and the person's own files,
 * capped at about 40k characters, newest first and trimmed per section. Every quotable source gets a short ref
 * ([P3] a prompt, [S2] a session's end-of-turn message, [R1] a rules or memory file, [N1] an earlier nudge), and the
 * model cites evidence by ref + exact quote. Code then checks each quote against that source and fills in `where`
 * (path:line for files, "session label · ISO time" for prompts, messages and nudges): the model never decides either.
 *
 * Sections of a prompt check (docs/prompt-watch.md §3):
 *  1. the new prompt(s), its session label, repo and cwd
 *  2. the same session's earlier prompts (latest 15) and its last end-of-turn message before the new prompt
 *  3. other sessions' prompts from the last 48 h (latest 40, compact, labelled)
 *  4. rules: the profile's CLAUDE.md, each CLAUDE.md / CLAUDE.local.md / .claude/CLAUDE.md from the top folder down to
 *     the cwd (repo and work root included), the project memory index (MEMORY.md) and up to 5 memory files that
 *     share words with the prompt; line-numbered
 *  5. open items: other sessions whose last message asked something and got no prompt since; nudges the person
 *     never saw (30 min or older)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DB } from "./home.ts";
import type { ChatRow, Evidence, SourceKind } from "./chat.ts";
import { redact } from "./secrets.ts";
import { endsWithQuestion, isHumanPrompt, readableText, repoNameFor, sessionLabel } from "./sessionInfo.ts";
import { parseJson } from "./util.ts";

export const WINDOW_MS = 48 * 3600_000;

export interface PromptRow {
  key: string;
  session: string;
  tsMs: number;
  text: string;
  checkId: number | null;
}

export interface SessionRow {
  session: string;
  profile: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  firstPrompt: string | null;
  updatedMs: number;
  endedMs: number | null;
  repo: string | null;
  label: string;
}

export interface TurnRow {
  session: string;
  tsMs: number;
  text: string;
}

export interface Source {
  ref: string;
  kind: SourceKind;
  text: string;
  path?: string;
  label?: string;
  atMs?: number;
  session?: string;
}

export interface BuiltContext {
  text: string;
  sources: Map<string, Source>;
  sizes: Record<string, number>;
  /** Refs of the prompt(s) being checked: a nudge must also quote something else (the thing being forgotten). */
  newRefs: Set<string>;
}

// ---------------------------------------------------------------------------------------------------------------
// Registry access

/** The person's prompts in [since, until], oldest first. Automated turns and subagent prompts are left out. */
export function loadPrompts(reg: DB, sinceMs: number, untilMs = Number.MAX_SAFE_INTEGER): PromptRow[] {
  const rows = reg
    .prepare("SELECT dedupe_key, session, ts_ms, payload, check_id FROM session_prompts WHERE ts_ms >= ? AND ts_ms <= ? ORDER BY ts_ms, rowid")
    .all(sinceMs, untilMs) as Array<{ dedupe_key: string; session: string; ts_ms: number; payload: string; check_id: number | null }>;
  const out: PromptRow[] = [];
  for (const r of rows) {
    const p = parseJson<Record<string, unknown>>(r.payload, {});
    const text = typeof p.prompt === "string" ? p.prompt : "";
    if (!isHumanPrompt(text, p)) continue;
    // The same prompt submitted twice within two minutes (a resubmit) is one prompt.
    const dup = out.findLast((x) => x.session === r.session && Number(r.ts_ms) - x.tsMs < 120_000 && x.text === text);
    if (dup) continue;
    out.push({ key: r.dedupe_key, session: r.session, tsMs: Number(r.ts_ms), text, checkId: r.check_id === null ? null : Number(r.check_id) });
  }
  return out;
}

export function loadTurns(reg: DB, sinceMs: number, untilMs = Number.MAX_SAFE_INTEGER): TurnRow[] {
  return (reg.prepare("SELECT session, ts_ms, text FROM session_turns WHERE ts_ms >= ? AND ts_ms <= ? ORDER BY ts_ms").all(sinceMs, untilMs) as Array<{ session: string; ts_ms: number; text: string }>).map(
    (r) => ({ session: r.session, tsMs: Number(r.ts_ms), text: r.text }),
  );
}

/** Sessions with their label ("repo · first prompt"); the first prompt falls back to the earliest one still stored. */
export function loadSessions(reg: DB, prompts: PromptRow[] = []): Map<string, SessionRow> {
  const rows = reg.prepare("SELECT session, profile, cwd, transcript_path, first_prompt, updated_ms, ended_ms FROM sessions").all() as Array<{
    session: string;
    profile: string | null;
    cwd: string | null;
    transcript_path: string | null;
    first_prompt: string | null;
    updated_ms: number;
    ended_ms: number | null;
  }>;
  // The label comes from the first prompt with readable text: a first prompt that is only a pasted block's markup
  // or a system reminder gives way to the next one.
  const readable = (t: string | null | undefined) => !!t && readableText(t).length > 0;
  const earliest = new Map<string, string>();
  for (const p of prompts) if (!earliest.has(p.session) && readable(p.text)) earliest.set(p.session, p.text);
  const missing = rows.filter((r) => !readable(r.first_prompt) && !earliest.has(r.session)).map((r) => r.session);
  for (const s of missing) {
    const hit = loadPromptsFor(reg, s, 10).find((p) => readable(p.text));
    if (hit) earliest.set(s, hit.text);
  }
  const out = new Map<string, SessionRow>();
  for (const r of rows) {
    const repo = repoNameFor(r.cwd);
    const first = (readable(r.first_prompt) ? r.first_prompt : null) ?? earliest.get(r.session) ?? null;
    out.set(r.session, {
      session: r.session,
      profile: r.profile,
      cwd: r.cwd,
      transcriptPath: r.transcript_path,
      firstPrompt: first,
      updatedMs: Number(r.updated_ms),
      endedMs: r.ended_ms === null ? null : Number(r.ended_ms),
      repo,
      label: sessionLabel(repo, first, r.session),
    });
  }
  return out;
}

function loadPromptsFor(reg: DB, session: string, limit: number): PromptRow[] {
  const rows = reg.prepare("SELECT dedupe_key, session, ts_ms, payload, check_id FROM session_prompts WHERE session = ? ORDER BY ts_ms LIMIT 50").all(session) as Array<{
    dedupe_key: string;
    session: string;
    ts_ms: number;
    payload: string;
    check_id: number | null;
  }>;
  const out: PromptRow[] = [];
  for (const r of rows) {
    const p = parseJson<Record<string, unknown>>(r.payload, {});
    const text = typeof p.prompt === "string" ? p.prompt : "";
    if (isHumanPrompt(text, p)) out.push({ key: r.dedupe_key, session: r.session, tsMs: Number(r.ts_ms), text, checkId: r.check_id });
    if (out.length >= limit) break;
  }
  return out;
}

const unknownSession = (session: string): SessionRow => ({
  session,
  profile: null,
  cwd: null,
  transcriptPath: null,
  firstPrompt: null,
  updatedMs: 0,
  endedMs: null,
  repo: null,
  label: sessionLabel(null, null, session),
});

export const turnBefore = (turns: TurnRow[], session: string, tsMs: number): TurnRow | null => turns.findLast((t) => t.session === session && t.tsMs < tsMs) ?? null;

// ---------------------------------------------------------------------------------------------------------------
// Rules and memory files

const MAX_FILE = 200 * 1024;

function readSmall(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return redact(fs.readFileSync(file, "utf8")).text;
  } catch {
    return null;
  }
}

/** The CLAUDE.md chain Claude Code loads for this cwd: the profile's, then every folder from the top down to cwd. */
export function ruleFiles(profile: string | null, cwd: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (f: string) => {
    let real = f;
    try {
      real = fs.realpathSync(f);
    } catch {
      return;
    }
    if (seen.has(real) || readSmall(real) === null) return;
    seen.add(real);
    out.push(f);
  };
  if (profile) add(path.join(profile, "CLAUDE.md"));
  if (cwd) {
    const dirs: string[] = [];
    for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
      dirs.unshift(d);
      if (path.dirname(d) === d) break;
    }
    for (const d of dirs) {
      if (d === path.parse(d).root) continue;
      for (const name of ["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md")]) add(path.join(d, name));
    }
  }
  return out;
}

/** The project memory folder of a session: next to its transcript, else <profile>/projects/<encoded cwd>/memory. */
export function memoryDir(s: Pick<SessionRow, "transcriptPath" | "profile" | "cwd">): string | null {
  const cands: string[] = [];
  if (s.transcriptPath) cands.push(path.join(path.dirname(s.transcriptPath), "memory"));
  if (s.profile && s.cwd) cands.push(path.join(s.profile, "projects", s.cwd.replace(/[^A-Za-z0-9]/g, "-"), "memory"));
  return cands.find((d) => fs.existsSync(path.join(d, "MEMORY.md"))) ?? null;
}

const STOP = new Set(
  "a an the and or of to in on for with without is are be by it this that as at from not no can may when if into its was were you your we our me my i do does did done have has had will would should could just now then than so but what how why which who all any some get got let lets make made use using please also only about after before there here them they their it's i'm don't can't ok okay yes go sure right".split(
    " ",
  ),
);

export function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

const overlap = (a: Set<string>, b: Set<string>): number => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
};

/** Crude stems, so "merge", "merging" and "merged" meet: words without a common ending, cut to 6 letters. */
export function stems(text: string): Set<string> {
  return new Set([...words(text)].map((w) => w.replace(/(ings|ing|ed|es|s|e)$/, "").slice(0, 6)).filter((w) => w.length >= 3));
}

/** A line about something hard to undo, and a line that reads like a rule. */
const RISKY_LINE = /\b(merg|prod|deploy|releas|delet|drop|remov|destroy|send|sent|publish|push|secret|token|credential|kubectl|terraform|apply|migrat|revok|rotat|money|pay|charg|refund|invite|force|reset)\w*/i;
const RULE_LINE = /\b(never|always|must|only|don'?t|do not|before|unless|requir\w*|explicit\w*|approv\w*|confirm\w*|ask|without|forbid\w*)\b/i;

/** How likely a written line applies to this prompt: shared stems, or a rule about something hard to undo. */
export function lineScore(line: string, about: Set<string>): number {
  if (!line.trim()) return 0;
  const rule = RULE_LINE.test(line);
  return overlap(about, stems(line)) * 3 + (rule && RISKY_LINE.test(line) ? 2 : 0) + (rule ? 0.5 : 0);
}

const LINK = /\[([^\]]+)\]\(([^)\s]+\.md)\)/g;

/** Up to `max` memory files linked from the index whose names or index lines share the most words with `text`. */
export function pickMemoryFiles(dir: string, index: string, text: string, max = 5, minScore = 1): string[] {
  const w = words(text);
  if (!w.size) return [];
  const scored: Array<{ file: string; score: number; order: number }> = [];
  const seen = new Set<string>();
  index.split("\n").forEach((line, order) => {
    for (const m of line.matchAll(LINK)) {
      const rel = m[2];
      if (rel.includes("..") || seen.has(rel)) continue;
      const lineScore = overlap(w, words(line));
      const nameScore = overlap(w, words(rel.replace(/\.md$/, "").replace(/[_-]/g, " ")));
      const score = lineScore + nameScore;
      if (score >= minScore) {
        seen.add(rel);
        scored.push({ file: path.join(dir, rel), score: score + (/^(feedback|user)_/.test(path.basename(rel)) ? 0.5 : 0), order });
      }
    }
  });
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((s) => s.file)
    .filter((f) => fs.existsSync(f))
    .slice(0, max);
}

// ---------------------------------------------------------------------------------------------------------------
// Formatting and caps

export const stamp = (ms: number): string => new Date(ms).toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z").replace("T", " ");
const isoSec = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export function ago(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const homeRel = (p: string): string => {
  const h = os.homedir();
  return p === h ? "~" : p.startsWith(`${h}/`) ? `~/${p.slice(h.length + 1)}` : p;
};

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s);
const tailCut = (s: string, max: number): string => (s.length > max ? `…${s.slice(-(max - 1))}` : s);
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Numbered lines ("12| text"), keeping only `keep` lines when given, within `cap` characters. */
function numbered(text: string, cap: number, keep?: Set<number>): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let used = 0;
  let gap = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep && !keep.has(i)) {
      gap = true;
      continue;
    }
    if (gap && out.length) out.push("   …");
    gap = false;
    const l = `${i + 1}| ${lines[i]}`;
    if (used + l.length + 1 > cap) {
      out.push(`   … (${lines.length - i} more lines not shown)`);
      break;
    }
    out.push(l);
    used += l.length + 1;
  }
  return out.join("\n");
}

/** Lines of a memory index worth showing first: standing preferences (feedback/user files), headings, shared words. */
function indexKeep(index: string, w: Set<string>, cap: number): Set<number> {
  const lines = index.split("\n");
  const score = lines.map((l, i) => {
    let s = 0;
    if (/^#/.test(l)) s += 2;
    if (/\]\((feedback|user)_[^)]*\.md\)/.test(l) || /\bfeedback\b/i.test(l)) s += 3;
    s += Math.min(5, overlap(w, words(l)));
    return { i, s, len: l.length + 8 };
  });
  const keep = new Set<number>();
  let used = 0;
  for (const x of [...score].sort((a, b) => b.s - a.s || a.i - b.i)) {
    if (used + x.len > cap) continue;
    keep.add(x.i);
    used += x.len;
  }
  return keep;
}

export interface Caps {
  total: number;
  prompt: number;
  rules: number;
  same: number;
  last: number;
  open: number;
  memoryIndex: number;
  memoryFiles: number;
  others: number;
}

/**
 * About 16k characters at most (typically 6-10k). The cost of a check is mostly these characters, written once to
 * the prompt cache: the full CLAUDE.md chain and memory index (28-33k on the owner's machine) cost about $0.06 a
 * check. Rules and memory are cut to the lines that may apply to the prompt (lineScore); other sessions' prompts to
 * the ones sharing words with it.
 */
export const CHECK_CAPS: Caps = { total: 16_000, prompt: 4_000, rules: 4_000, same: 2_500, last: 2_000, open: 1_200, memoryIndex: 1_500, memoryFiles: 1_200, others: 2_500 };

class Refs {
  readonly sources = new Map<string, Source>();
  private n: Record<string, number> = { P: 0, S: 0, R: 0, N: 0 };
  add(prefix: "P" | "S" | "R" | "N", s: Omit<Source, "ref">): string {
    const ref = `${prefix}${++this.n[prefix]}`;
    this.sources.set(ref, { ...s, ref });
    return ref;
  }
}

/** Keeps adding blocks (newest first) until the section cap; returns them in the order given. */
function fill(blocks: string[], cap: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const b of blocks) {
    if (used + b.length + 1 > cap) break;
    out.push(b);
    used += b.length + 1;
  }
  return out;
}

function rulesSection(refs: Refs, files: string[], cap: number): string {
  const blocks: string[] = [];
  let used = 0;
  for (const f of files) {
    const text = readSmall(f);
    if (text === null) continue;
    const room = cap - used;
    if (room < 300) break;
    const body = numbered(text, Math.min(room - 120, 6_000));
    const ref = refs.add("R", { kind: "rule", text, path: f });
    const b = `[${ref}] ${homeRel(f)} (written rules)\n${body}`;
    blocks.push(b);
    used += b.length + 2;
  }
  return blocks.join("\n\n");
}

/**
 * Prompt checks: only the written lines that may apply, ranked across the whole CLAUDE.md chain (the file nearest the
 * cwd breaks ties), each with its section heading, line-numbered, within `cap`.
 */
function relevantRulesSection(refs: Refs, files: string[], about: string, cap: number): string {
  const a = stems(about);
  const texts = files.map((f) => ({ f, text: readSmall(f) })).filter((x): x is { f: string; text: string } => x.text !== null);
  const cands: Array<{ fi: number; li: number; score: number; len: number }> = [];
  texts.forEach((x, fi) =>
    x.text.split("\n").forEach((l, li) => {
      const score = lineScore(l, a);
      if (score >= 2) cands.push({ fi, li, score: score + fi * 0.1, len: l.length + 8 });
    }),
  );
  const keep = texts.map(() => new Set<number>());
  let used = 0;
  for (const c of cands.sort((x, y) => y.score - x.score)) {
    if (used + c.len > cap - 200 * texts.length) continue;
    keep[c.fi].add(c.li);
    used += c.len;
  }
  const blocks: string[] = [];
  texts.forEach((x, fi) => {
    if (!keep[fi].size) return;
    const lines = x.text.split("\n");
    for (const li of [...keep[fi]]) {
      for (let h = li - 1; h >= 0; h--) {
        if (/^#{1,6} /.test(lines[h])) {
          if (!keep[fi].has(h) && used + lines[h].length + 8 <= cap) {
            keep[fi].add(h);
            used += lines[h].length + 8;
          }
          break;
        }
      }
    }
    const ref = refs.add("R", { kind: "rule", text: x.text, path: x.f });
    blocks.push(`[${ref}] ${homeRel(x.f)} (written rules; only lines that may apply to this prompt are shown)\n${numbered(x.text, cap, keep[fi])}`);
  });
  return blocks.join("\n\n");
}

/** Prompt checks: memory index lines and up to 2 memory files that share words with the prompt. */
function relevantMemorySections(refs: Refs, s: SessionRow, about: string, capIndex: number, capFiles: number): { index: string; files: string } {
  const dir = memoryDir(s);
  if (!dir) return { index: "", files: "" };
  const indexFile = path.join(dir, "MEMORY.md");
  const index = readSmall(indexFile);
  if (index === null) return { index: "", files: "" };
  const a = stems(about);
  const keep = new Set<number>();
  let used = 0;
  const cands = index
    .split("\n")
    .map((l, i) => {
      const ov = overlap(a, stems(l));
      const standing = /\]\((feedback|user)_[^)]*\.md\)/.test(l);
      return { i, len: l.length + 8, score: standing && ov >= 1 ? ov * 3 + 2 : ov >= 2 ? ov * 3 : 0 };
    })
    .filter((c) => c.score > 0)
    .sort((x, y) => y.score - x.score);
  for (const c of cands) {
    if (used + c.len > capIndex - 150) continue;
    keep.add(c.i);
    used += c.len;
  }
  let indexText = "";
  if (keep.size) {
    const ref = refs.add("R", { kind: "memory", text: index, path: indexFile });
    indexText = `[${ref}] ${homeRel(indexFile)} (memory index; only lines that may apply are shown)\n${numbered(index, capIndex, keep)}`;
  }
  const blocks: string[] = [];
  let usedFiles = 0;
  for (const f of pickMemoryFiles(dir, index, about, 2, 2)) {
    const text = readSmall(f);
    if (text === null) continue;
    const room = Math.min(capFiles - usedFiles, 600);
    if (room < 250) break;
    const ref = refs.add("R", { kind: "memory", text, path: f });
    const b = `[${ref}] ${homeRel(f)} (memory)\n${numbered(text, room - 100)}`;
    blocks.push(b);
    usedFiles += b.length + 2;
  }
  return { index: indexText, files: blocks.join("\n\n") };
}

function memorySections(refs: Refs, s: SessionRow, about: string, capIndex: number, capFiles: number): { index: string; files: string } {
  const dir = memoryDir(s);
  if (!dir) return { index: "", files: "" };
  const indexFile = path.join(dir, "MEMORY.md");
  const index = readSmall(indexFile);
  if (index === null) return { index: "", files: "" };
  let indexText = "";
  if (capIndex > 300) {
    const ref = refs.add("R", { kind: "memory", text: index, path: indexFile });
    const keep = index.length + index.split("\n").length * 6 <= capIndex - 120 ? undefined : indexKeep(index, words(about), capIndex - 160);
    indexText = `[${ref}] ${homeRel(indexFile)} (memory index; lines not relevant here are left out)\n${numbered(index, capIndex - 120, keep)}`;
  }
  const blocks: string[] = [];
  let used = 0;
  for (const f of pickMemoryFiles(dir, index, about)) {
    const text = readSmall(f);
    if (text === null) continue;
    const room = Math.min(capFiles - used, 1_500);
    if (room < 300) break;
    const ref = refs.add("R", { kind: "memory", text, path: f });
    const b = `[${ref}] ${homeRel(f)} (memory)\n${numbered(text, room - 100)}`;
    blocks.push(b);
    used += b.length + 2;
  }
  return { index: indexText, files: blocks.join("\n\n") };
}

interface OpenInputs {
  sessions: Map<string, SessionRow>;
  prompts: PromptRow[];
  turns: TurnRow[];
  nudges: ChatRow[];
  exclude: string | null;
  asOfMs: number;
  nowMs: number;
  /**
   * Which nudges count as waiting: a prompt check resurfaces only nudges the person never saw, once they are 30 min
   * old (a newer one is still right there in the chat); a question ("what's waiting on me?") lists every un-acted one.
   */
  nudgesWaiting: "unseen-30min" | "unacted";
}

export const NUDGE_RESURFACE_MS = 30 * 60_000;

/** Sessions that asked the person something and got no prompt since; nudges nobody acted on. */
export function openItems(o: OpenInputs): { questions: TurnRow[]; nudges: ChatRow[] } {
  const latest = new Map<string, TurnRow>();
  for (const t of o.turns) if (t.tsMs <= o.asOfMs && o.asOfMs - t.tsMs <= WINDOW_MS) latest.set(t.session, t);
  const questions = [...latest.values()]
    .filter((t) => t.session !== o.exclude && endsWithQuestion(t.text))
    .filter((t) => {
      const s = o.sessions.get(t.session);
      return !(s?.endedMs && s.endedMs >= t.tsMs && s.endedMs <= o.asOfMs);
    })
    .filter((t) => !o.prompts.some((p) => p.session === t.session && p.tsMs > t.tsMs && p.tsMs <= o.asOfMs))
    .sort((a, b) => b.tsMs - a.tsMs)
    .slice(0, 5);
  const nudges = o.nudges
    .filter((n) =>
      o.nudgesWaiting === "unacted"
        ? n.state === "new" || n.state === "seen"
        : n.state === "new" && n.seen_ms === null && o.asOfMs - n.at_ms >= NUDGE_RESURFACE_MS,
    )
    .filter((n) => n.kind === "nudge" && n.at_ms <= o.asOfMs && o.asOfMs - n.at_ms <= WINDOW_MS)
    .sort((a, b) => b.at_ms - a.at_ms)
    .slice(0, 5);
  return { questions, nudges };
}

function openSection(refs: Refs, items: ReturnType<typeof openItems>, sessions: Map<string, SessionRow>, nowMs: number, cap: number): string {
  const blocks: string[] = [];
  for (const t of items.questions) {
    const s = sessions.get(t.session) ?? unknownSession(t.session);
    const ref = refs.add("S", { kind: "session", text: t.text, label: s.label, atMs: t.tsMs, session: t.session });
    blocks.push(`[${ref}] ${s.label} · ${ago(t.tsMs, nowMs)} — the session asked the person and got no prompt since:\n${tailCut(t.text, 600)}`);
  }
  for (const n of items.nudges) {
    const ref = refs.add("N", { kind: "nudge", text: n.text, label: n.session_label ?? "no session", atMs: n.at_ms, session: n.session ?? undefined });
    blocks.push(`[${ref}] Pilot nudge (${n.nudge_kind ?? "?"}) · ${n.session_label ?? "no session"} · ${ago(n.at_ms, nowMs)} · not acted on:\n${cut(n.text, 400)}`);
  }
  return fill(blocks, cap).join("\n\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Context for one prompt check

export interface CheckTarget {
  session: string;
  prompts: PromptRow[];
}

export interface BuildOptions {
  nowMs: number;
  /** Pilot's own nudges (for open items); the dry run passes its in-memory list. */
  nudges: ChatRow[];
  caps?: Partial<Caps>;
}

export function buildCheckContext(reg: DB, target: CheckTarget, o: BuildOptions): BuiltContext {
  const caps = { ...CHECK_CAPS, ...o.caps };
  const firstTs = target.prompts[0].tsMs;
  const asOf = target.prompts.at(-1)!.tsMs;
  const targetKeys = new Set(target.prompts.map((p) => p.key));
  const prompts = loadPrompts(reg, asOf - WINDOW_MS, asOf);
  const sessions = loadSessions(reg, prompts);
  const turns = loadTurns(reg, asOf - WINDOW_MS - 7 * 86_400_000, asOf);
  const me = sessions.get(target.session) ?? unknownSession(target.session);
  const refs = new Refs();
  const sizes: Record<string, number> = {};
  let remaining = caps.total;
  const take = (name: string, want: number, build: (cap: number) => string): string => {
    const text = build(Math.max(0, Math.min(want, remaining)));
    sizes[name] = text.length;
    remaining -= text.length;
    return text;
  };
  const about = target.prompts.map((p) => p.text).join("\n");
  const newRefs = new Set<string>();

  // 1. The new prompt(s): full, up to the cap.
  const s1 = take("prompt", caps.prompt, (cap) => {
    const per = Math.floor(cap / target.prompts.length) - 80;
    return target.prompts
      .map((p) => {
        const ref = refs.add("P", { kind: "prompt", text: p.text, label: me.label, atMs: p.tsMs, session: p.session });
        newRefs.add(ref);
        return `[${ref}] ${stamp(p.tsMs)}\n${cut(p.text, per)}`;
      })
      .join("\n\n");
  });
  // 4a. Rules (the files the person wrote, highest priority after the prompt).
  const s4rules = take("rules", caps.rules, (cap) => relevantRulesSection(refs, ruleFiles(me.profile, me.cwd), about, cap));
  // 2. Same session: earlier prompts and the message the new prompt answers.
  const s2 = take("same", caps.same, (cap) => {
    const earlier = prompts.filter((p) => p.session === target.session && p.tsMs < firstTs && !targetKeys.has(p.key)).slice(-15).reverse();
    const blocks = earlier.map((p) => {
      const ref = refs.add("P", { kind: "prompt", text: p.text, label: me.label, atMs: p.tsMs, session: p.session });
      return `[${ref}] ${ago(p.tsMs, asOf)}: ${cut(flat(p.text), 400)}`;
    });
    return fill(blocks, cap).join("\n");
  });
  const s2last = take("last", caps.last, (cap) => {
    const t = turnBefore(turns, target.session, firstTs);
    if (!t || cap < 200) return "";
    const ref = refs.add("S", { kind: "session", text: t.text, label: me.label, atMs: t.tsMs, session: t.session });
    return `[${ref}] the session's last end-of-turn message, ${ago(t.tsMs, asOf)}:\n${tailCut(t.text, cap - 100)}`;
  });
  // 5. Open items.
  const s5 = take("open", caps.open, (cap) =>
    openSection(refs, openItems({ sessions, prompts, turns, nudges: o.nudges, exclude: target.session, asOfMs: asOf, nowMs: o.nowMs, nudgesWaiting: "unseen-30min" }), sessions, asOf, cap),
  );
  // 4b. Memory.
  let memFilesText = "";
  const s4mem = take("memoryIndex", caps.memoryIndex, (capIndex) => {
    const m = relevantMemorySections(refs, me, about, capIndex, Math.min(caps.memoryFiles, Math.max(0, remaining - capIndex)));
    memFilesText = m.files;
    return m.index;
  });
  sizes.memoryFiles = memFilesText.length;
  remaining -= memFilesText.length;
  // 3. Other sessions' prompts: of the latest 40, the 15 that share the most words with the new one, newest first.
  const s3 = take("others", caps.others, (cap) => {
    const a = stems(about);
    const others = prompts
      .filter((p) => p.session !== target.session)
      .slice(-40)
      .map((p) => ({ p, score: overlap(a, stems(p.text)) }))
      .sort((x, y) => y.score - x.score || y.p.tsMs - x.p.tsMs)
      .slice(0, 15)
      .map((x) => x.p)
      .sort((x, y) => y.tsMs - x.tsMs);
    const blocks = others.map((p) => {
      const s = sessions.get(p.session) ?? unknownSession(p.session);
      const ref = refs.add("P", { kind: "prompt", text: p.text, label: s.label, atMs: p.tsMs, session: p.session });
      return `[${ref}] ${s.label} · ${ago(p.tsMs, asOf)}: ${cut(flat(p.text), 220)}`;
    });
    return fill(blocks, cap).join("\n");
  });

  const text = [
    `Time of the new prompt: ${stamp(asOf)}`,
    `# 1. The new prompt (check this)\nSession: ${me.label} · repo ${me.repo ?? "none"} · cwd ${me.cwd ? homeRel(me.cwd) : "unknown"}\n${s1}`,
    `# 2. Earlier in the same session\n${s2 || "(no earlier prompts stored)"}${s2last ? `\n\n${s2last}` : ""}`,
    `# 3. The person's prompts in other sessions (last 48 h, the ones closest to the new prompt, newest first)\n${s3 || "(none)"}`,
    `# 4. The person's written rules and memory (only lines that may apply)\n${[s4rules, s4mem, memFilesText].filter(Boolean).join("\n\n") || "(none that apply)"}`,
    `# 5. Open items\n${s5 || "(none)"}`,
  ].join("\n\n");
  return { text, sources: refs.sources, sizes, newRefs };
}

// ---------------------------------------------------------------------------------------------------------------
// Context for a chat question

export const ASK_CAPS = { total: 40_000, question: 4_000, sessions: 8_000, open: 2_000, thread: 4_000, prompts: 12_000, rules: 8_000, memoryIndex: 4_000, memoryFiles: 3_000 };

export function buildAskContext(reg: DB, question: string, o: { nowMs: number; thread: ChatRow[]; nudges: ChatRow[] }): BuiltContext {
  const caps = ASK_CAPS;
  const now = o.nowMs;
  const prompts = loadPrompts(reg, now - WINDOW_MS, now);
  const sessions = loadSessions(reg, prompts);
  const turns = loadTurns(reg, now - WINDOW_MS, now);
  const refs = new Refs();
  const sizes: Record<string, number> = {};
  let remaining = caps.total;
  const take = (name: string, want: number, build: (cap: number) => string): string => {
    const text = build(Math.max(0, Math.min(want, remaining)));
    sizes[name] = text.length;
    remaining -= text.length;
    return text;
  };
  const lastActive = new Map<string, number>();
  for (const p of prompts) lastActive.set(p.session, Math.max(lastActive.get(p.session) ?? 0, p.tsMs));
  for (const t of turns) lastActive.set(t.session, Math.max(lastActive.get(t.session) ?? 0, t.tsMs));
  const active = [...lastActive.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => sessions.get(s) ?? unknownSession(s));

  const sQ = take("question", caps.question, (cap) => cut(question, cap));
  const sThread = take("thread", caps.thread, (cap) => {
    const lines = o.thread.slice(-20).map((m) => `${m.role === "you" ? "You" : `Pilot${m.kind === "nudge" ? ` (nudge: ${m.nudge_kind})` : ""}`} · ${ago(m.at_ms, now)}: ${cut(flat(m.text), 500)}`);
    return fill(lines.reverse(), cap).reverse().join("\n");
  });
  const sOpen = take("open", caps.open, (cap) => openSection(refs, openItems({ sessions, prompts, turns, nudges: o.nudges, exclude: null, asOfMs: now, nowMs: now, nudgesWaiting: "unacted" }), sessions, now, cap));
  const sSessions = take("sessions", caps.sessions, (cap) => {
    const blocks = active.map((s) => {
      const t = turns.findLast((x) => x.session === s.session);
      const head = `${s.label} · repo ${s.repo ?? "none"} · last active ${ago(lastActive.get(s.session) ?? 0, now)}${s.endedMs && s.endedMs >= s.updatedMs ? " · ended" : ""}`;
      if (!t) return `- ${head}`;
      const ref = refs.add("S", { kind: "session", text: t.text, label: s.label, atMs: t.tsMs, session: s.session });
      return `- ${head}\n  [${ref}] its last end-of-turn message, ${ago(t.tsMs, now)}: ${tailCut(flat(t.text), 500)}`;
    });
    return fill(blocks, cap).join("\n");
  });
  const sPrompts = take("prompts", caps.prompts, (cap) => {
    const w = words(question);
    const ranked = prompts
      .map((p) => ({ p, score: overlap(w, words(`${p.text} ${sessions.get(p.session)?.label ?? ""}`)) }))
      .sort((a, b) => b.score - a.score || b.p.tsMs - a.p.tsMs)
      .slice(0, 60);
    const blocks = ranked
      .sort((a, b) => b.p.tsMs - a.p.tsMs)
      .map(({ p }) => {
        const s = sessions.get(p.session) ?? unknownSession(p.session);
        const ref = refs.add("P", { kind: "prompt", text: p.text, label: s.label, atMs: p.tsMs, session: p.session });
        return `[${ref}] ${s.label} · ${stamp(p.tsMs)} (${ago(p.tsMs, now)}): ${cut(flat(p.text), 500)}`;
      });
    return fill(blocks, cap).join("\n");
  });
  const top = active[0] ?? null;
  const sRules = take("rules", caps.rules, (cap) => (top ? rulesSection(refs, ruleFiles(top.profile, top.cwd), cap) : ""));
  let memFiles = "";
  const sMem = take("memoryIndex", caps.memoryIndex, (capIndex) => {
    if (!top) return "";
    const m = memorySections(refs, top, question, capIndex, Math.min(caps.memoryFiles, Math.max(0, remaining - capIndex)));
    memFiles = m.files;
    return m.index;
  });
  sizes.memoryFiles = memFiles.length;

  const text = [
    `Now: ${stamp(now)}`,
    `# 1. The person's question\n${sQ}`,
    `# 2. The chat so far (oldest first)\n${sThread || "(empty)"}`,
    `# 3. Open items\n${sOpen || "(none)"}`,
    `# 4. Sessions active in the last 48 h (newest first)\n${sSessions || "(none)"}`,
    `# 5. The person's prompts (most relevant to the question, newest first)\n${sPrompts || "(none)"}`,
    `# 6. Written rules and memory (most recently active session)\n${[sRules, sMem, memFiles].filter(Boolean).join("\n\n") || "(none found)"}`,
  ].join("\n\n");
  return { text, sources: refs.sources, sizes, newRefs: new Set() };
}

// ---------------------------------------------------------------------------------------------------------------
// Quote checking

/** Exact text, compared loosely only in ways that do not change words: case, whitespace, quote marks, * and `. */
export function normQuote(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Normalised text plus where each original line starts in it. */
function normLines(text: string): { norm: string; starts: number[] } {
  const starts: number[] = [];
  let norm = "";
  for (const line of text.split("\n")) {
    starts.push(norm.length);
    const n = normQuote(line);
    if (n) norm += `${n} `;
  }
  return { norm, starts };
}

/**
 * Whether `quote` occurs in the source, and on which line. Leading/trailing ellipses are ignored; an ellipsis inside
 * splits the quote into parts that must each occur (at least 8 characters each), in order.
 */
export function locateQuote(text: string, quote: string): { found: boolean; line?: number } {
  const q = quote
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/^(\.\.\.|…)\s*/, "")
    .replace(/\s*(\.\.\.|…)$/, "");
  const parts = q
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map(normQuote)
    .filter(Boolean);
  if (!parts.length || (parts.length > 1 && parts.some((p) => p.length < 8))) return { found: false };
  const { norm, starts } = normLines(text);
  let from = 0;
  let first = -1;
  for (const p of parts) {
    const i = norm.indexOf(p, from);
    if (i < 0) return { found: false };
    if (first < 0) first = i;
    from = i + p.length;
  }
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1] <= first) line++;
  return { found: true, line: line + 1 };
}

/** Evidence as stored and shown: code decides `source`, `where` and `found`, never the model. */
export function resolveEvidence(sources: Map<string, Source>, items: Array<{ ref?: unknown; quote?: unknown }>): Evidence[] {
  return items
    .filter((e) => typeof e?.quote === "string" && (e.quote as string).trim())
    .map((e) => {
      const quote = (e.quote as string).trim();
      const src = typeof e.ref === "string" ? sources.get(e.ref.replace(/[[\]\s]/g, "")) : undefined;
      if (!src) return { source: "prompt" as SourceKind, where: `unknown source ${String(e.ref ?? "")}`.trim(), quote, found: false };
      const hit = locateQuote(src.text, quote);
      const where =
        src.kind === "rule" || src.kind === "memory"
          ? `${homeRel(src.path ?? "")}${hit.found ? `:${hit.line}` : ""}`
          : `${src.label ?? "no session"} · ${isoSec(src.atMs ?? 0)}`;
      return { source: src.kind, where, quote, found: hit.found };
    });
}
