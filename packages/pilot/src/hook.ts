/**
 * Claude Code hook entry point, installed once per profile (plugin or user settings), so it sees every session.
 * Registered as `async: true` (Stop runs sync, see hooks.json), it never blocks the coding agent and returns in
 * tens of milliseconds: parse stdin, route the event to the repositories it belongs to, INSERT OR IGNORE, exit 0.
 * No model calls, no git subprocesses, no network. Errors go to ~/.pilot/hook-errors.log, never to Claude.
 *
 * Routing (sessions often start outside any repo and edit files in several):
 *  - Edits go to the git working tree that contains the edited file.
 *  - Prompts go to the repos this session has edited in the last 6 hours (and are kept, so a repo the session
 *    edits later receives the request that led to it). With promptReview=early they also go to the cwd repo.
 *  - Stop goes to the repos this session edited during the turn that just ended, and to the cwd repo (a turn
 *    without Edit/Write calls may still have changed files through Bash; the daemon checks cheaply with git).
 *  - Test runs go to the cwd repo.
 *  - Reads are recorded per session (which files the session has seen), never queued as events.
 *  - Every prompt is kept in the registry (72 h), with each session's end-of-turn message (Stop payload
 *    `last_assistant_message`, else the transcript's tail) and its first prompt, for prompt watching.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig, loadEnv, TOOL_ROOT } from "./config.ts";
import { openDb } from "./db.ts";
import { enqueueEvent, normalizeHook, readHeadCheap, type NormalizedEvent } from "./events.ts";
import {
  currentProfile,
  ensureHome,
  findRepoRoot,
  isExcluded,
  envVar,
  isWatchedProfile,
  kvGetReg,
  kvSetReg,
  pilotHome,
  openRegistry,
  realPathish,
  registerRepo,
  repoKey,
  setting,
  type DB,
} from "./home.ts";
import { redact } from "./secrets.ts";
import { capTurn, isHumanPrompt, transcriptLastMessage } from "./sessionInfo.ts";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PROMPT_ROUTE_MS = 6 * 3600_000;
const PROMPT_BACKFILL_MS = 2 * 3600_000;
/** Prompts are kept 72 h: prompt watching looks back 48 h across sessions. */
const PROMPT_KEEP_MS = 72 * 3600_000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const absFrom = (cwd: string, p: unknown): string | null => (typeof p === "string" && p ? path.resolve(cwd, p) : null);

function sessionRepos(reg: DB, session: string, sinceMs: number): string[] {
  const rows = reg
    .prepare("SELECT r.root FROM session_repos s JOIN repos r ON r.key = s.repo_key WHERE s.session = ? AND s.last_ms >= ? ORDER BY s.last_ms DESC")
    .all(session, sinceMs) as Array<{ root: string }>;
  return rows.map((r) => r.root);
}

/** Repositories an event belongs to (see header). */
export function routeEvent(reg: DB, input: Record<string, any>, nowMs: number, explicitRepo?: string): string[] {
  if (explicitRepo) return [path.resolve(explicitRepo)];
  const ev = String(input.hook_event_name ?? "");
  const session = typeof input.session_id === "string" ? input.session_id : null;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const tool = String(input.tool_name ?? "");
  if ((ev === "PostToolUse" || ev === "PostToolUseFailure") && EDIT_TOOLS.has(tool)) {
    const abs = absFrom(cwd, input.tool_input?.file_path ?? input.tool_input?.notebook_path);
    const root = abs ? findRepoRoot(abs) : null;
    return root ? [root] : [];
  }
  if (!session) return [];
  if (ev === "UserPromptSubmit") {
    const roots = new Set(sessionRepos(reg, session, nowMs - PROMPT_ROUTE_MS));
    if ((setting("PILOT_PROMPT_REVIEW") ?? "merge") === "early") {
      const r = findRepoRoot(cwd);
      if (r) roots.add(r);
    }
    return [...roots];
  }
  if (ev === "Stop") {
    const lastStop = (reg.prepare("SELECT last_stop_ms FROM sessions WHERE session = ?").get(session) as { last_stop_ms: number } | undefined)?.last_stop_ms ?? 0;
    const roots = new Set(sessionRepos(reg, session, lastStop));
    const r = findRepoRoot(cwd);
    if (r) roots.add(r);
    return [...roots];
  }
  if ((ev === "PostToolUse" || ev === "PostToolUseFailure") && tool === "Bash") {
    const r = findRepoRoot(cwd);
    return r ? [r] : [];
  }
  return [];
}

function backfillPrompts(reg: DB, db: ReturnType<typeof openDb>, session: string, nowMs: number): void {
  const rows = reg
    .prepare("SELECT dedupe_key, ts_ms, head, payload FROM session_prompts WHERE session = ? AND ts_ms >= ? ORDER BY ts_ms")
    .all(session, nowMs - PROMPT_BACKFILL_MS) as Array<{ dedupe_key: string; ts_ms: number; head: string | null; payload: string }>;
  for (const r of rows) {
    enqueueEvent(db, { kind: "prompt", dedupeKey: r.dedupe_key, ccSession: session, payload: JSON.parse(r.payload) }, r.head, r.ts_ms);
  }
}

export async function runHook(repoArg?: string): Promise<void> {
  // Pilot's own investigation sessions must never feed events back into the queue.
  if (envVar("IN_INVESTIGATION")) return;
  const started = performance.now();
  try {
    loadEnv();
    const raw = await readStdin();
    const input = JSON.parse(raw) as Record<string, any>;
    // Relative tool paths are relative to the session's cwd, not to whichever repo they land in.
    for (const k of ["file_path", "notebook_path"]) {
      const v = input.tool_input?.[k];
      if (typeof v === "string" && v && !path.isAbsolute(v)) input.tool_input[k] = path.resolve(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd(), v);
    }
    const profile = currentProfile();
    if (!repoArg && !isWatchedProfile(profile)) return; // a profile the user did not ask Pilot to watch
    const now = Date.now();
    const reg = openRegistry();
    const ev = String(input.hook_event_name ?? "");
    const session = typeof input.session_id === "string" ? input.session_id : null;
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    if (session) {
      reg
        .prepare(
          `INSERT INTO sessions(session, profile, cwd, transcript_path, updated_ms) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session) DO UPDATE SET cwd = excluded.cwd, transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path), updated_ms = excluded.updated_ms`,
        )
        .run(session, profile, cwd, typeof input.transcript_path === "string" ? input.transcript_path : null, now);
    }

    const tool = String(input.tool_name ?? "");
    // Files the session has seen (read or edited): used to tell whether a finding is outside its context.
    if (session && (ev === "PostToolUse" || ev === "PostToolUseFailure") && (tool === "Read" || EDIT_TOOLS.has(tool))) {
      const abs = absFrom(cwd, input.tool_input?.file_path ?? input.tool_input?.notebook_path);
      if (abs) reg.prepare("INSERT OR IGNORE INTO session_files(session, path, how, ts_ms) VALUES (?, ?, ?, ?)").run(session, realPathish(abs), tool === "Read" ? "read" : "edit", now);
    }

    let queued = 0;
    for (const root of routeEvent(reg, input, now, repoArg)) {
      if (isExcluded(root)) continue;
      const ne: NormalizedEvent | null = normalizeHook(input, root, now);
      if (!ne) continue;
      const cfg = loadConfig(root, { cheap: true });
      const key = registerRepo(reg, root, profile, now);
      const db = openDb(cfg.stateDir);
      if (session && ne.kind === "edit") {
        const prev = (reg.prepare("SELECT last_ms FROM session_repos WHERE session = ? AND repo_key = ?").get(session, key) as { last_ms: number } | undefined)?.last_ms;
        reg
          .prepare("INSERT INTO session_repos(session, repo_key, first_ms, last_ms) VALUES (?, ?, ?, ?) ON CONFLICT(session, repo_key) DO UPDATE SET last_ms = excluded.last_ms")
          .run(session, key, now, now);
        // The request behind this work: on first contact, and again when the session comes back after a pause
        // (prompts typed meanwhile were not routed here). Idempotent by dedupe key.
        if (prev === undefined || now - prev > 30 * 60_000) backfillPrompts(reg, db, session, now);
      }
      if (enqueueEvent(db, ne, readHeadCheap(root), now)) queued++;
    }

    // The person's prompts and each session's end-of-turn messages: what prompt watching checks and quotes
    // (promptWatch.ts runs in the daemon, never here).
    if (session && ev === "UserPromptSubmit" && typeof input.prompt === "string" && input.prompt.trim()) {
      const ne = normalizeHook(input, cwd, now);
      if (ne) reg.prepare("INSERT OR IGNORE INTO session_prompts(dedupe_key, session, ts_ms, head, payload) VALUES (?, ?, ?, ?, ?)").run(ne.dedupeKey, session, now, null, JSON.stringify(ne.payload));
      if (isHumanPrompt(input.prompt, input)) reg.prepare("UPDATE sessions SET first_prompt = ? WHERE session = ? AND first_prompt IS NULL").run(redact(input.prompt.trim().slice(0, 300)).text, session);
      reg.prepare("DELETE FROM session_prompts WHERE ts_ms < ?").run(now - PROMPT_KEEP_MS);
    }
    if (session && ev === "Stop") {
      reg.prepare("UPDATE sessions SET last_stop_ms = ? WHERE session = ?").run(now, session);
      const said = typeof input.last_assistant_message === "string" && input.last_assistant_message.trim() ? input.last_assistant_message : transcriptLastMessage(input.transcript_path);
      if (said) {
        reg.prepare("INSERT OR REPLACE INTO session_turns(session, ts_ms, text) VALUES (?, ?, ?)").run(session, now, capTurn(said));
        reg.prepare("DELETE FROM session_turns WHERE session = ? AND ts_ms NOT IN (SELECT ts_ms FROM session_turns WHERE session = ? ORDER BY ts_ms DESC LIMIT 5)").run(session, session);
      }
    }
    if (session && ev === "SessionEnd") reg.prepare("UPDATE sessions SET ended_ms = ? WHERE session = ?").run(now, session);
    if (ev === "SessionStart") {
      // Bounded registry: forget per-session details after a week.
      const weekAgo = now - 7 * 86_400_000;
      reg.prepare("DELETE FROM session_turns WHERE ts_ms < ?").run(weekAgo);
      reg.prepare("DELETE FROM session_files WHERE ts_ms < ?").run(weekAgo);
      reg.prepare("DELETE FROM session_repos WHERE last_ms < ?").run(weekAgo);
      reg.prepare("DELETE FROM sessions WHERE updated_ms < ?").run(weekAgo);
      reg.prepare("DELETE FROM kv WHERE key LIKE 'rewake:%' AND key NOT IN (SELECT 'rewake:' || session FROM sessions)").run();
    }
    if (ev === "SessionStart" || ev === "UserPromptSubmit") {
      writeLauncher();
      if (!repoArg) maybeStartDaemon(reg);
    }
    if (envVar("HOOK_VERBOSE")) process.stderr.write(`[pilot hook] ${ev} -> ${queued} queued in ${(performance.now() - started).toFixed(1)}ms\n`);
  } catch (err) {
    try {
      const dir = ensureHome();
      fs.appendFileSync(path.join(dir, "hook-errors.log"), `${new Date().toISOString()} ${String((err as Error)?.stack ?? err)}\n`);
    } catch {
      /* never fail the coding agent */
    }
  }
}

/**
 * A stable `~/.pilot/bin/pilot` that runs whichever version is installed (plugin roots move on update), with
 * the exact Node binary Claude Code's hooks use. Apps launched with another PATH (Stark Code puts Homebrew first)
 * would otherwise run a different Node and disagree with the daemon (e.g. on the self-test fingerprint).
 * Rewritten by the next session if that Node goes away.
 */
export function writeLauncher(): void {
  const file = path.join(pilotHome(), "bin", "pilot");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const body = `#!/bin/sh\n# Written by Pilot; points at the installed version and the Node its hooks run on.\nexec ${q(process.execPath)} ${q(path.join(TOOL_ROOT, "src", "boot.mjs"))} "$@"\n`;
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === body) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, body, { mode: 0o755 });
  } catch {
    /* best effort */
  }
}

interface Lock {
  pid: number;
  host: string;
  heartbeat: number;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, but we may not signal it
  }
}

/** Start the background daemon if it is not running (config "autostart", default on). Never blocks. */
export function maybeStartDaemon(reg: DB): boolean {
  if (!/^(1|true|yes|on)$/i.test(setting("PILOT_AUTOSTART") ?? "true")) return false;
  const lock = kvGetReg<Lock | null>(reg, "daemon", null);
  if (lock && pidAlive(lock.pid) && Date.now() - lock.heartbeat < 10 * 60_000) return false;
  const last = kvGetReg<number>(reg, "daemon_spawned_at", 0);
  if (Date.now() - last < 15_000) return false; // another hook just started one
  kvSetReg(reg, "daemon_spawned_at", Date.now());
  const log = fs.openSync(path.join(ensureHome(), "daemon.log"), "a", 0o600);
  // Clean environment: the daemon must not inherit the triggering session's profile or project.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TMPDIR|TERM)$/.test(k) || k.startsWith("PILOT_")) env[k] = v;
  }
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(TOOL_ROOT, "src", "cli.ts"), "daemon"], {
    detached: true,
    stdio: ["ignore", log, log],
    env,
    cwd: pilotHome(),
  });
  child.unref();
  fs.closeSync(log);
  return true;
}

export { repoKey };
