/**
 * Machine-wide state: Pilot's home directory (~/.pilot), the user config file, which Claude Code profiles
 * are watched, project exclusions, and the registry that maps sessions to the repositories they work in.
 *
 * Layout of PILOT_HOME (default ~/.pilot, private 0700):
 *   config.json        user settings (see README "Configuration"); env vars PILOT_* (or the older LOOKOUT_*) override it
 *   registry.db        repos, sessions, which repos/files each session touched, daemon lock, global pause,
 *                      Agent Engine findings and which sessions were told about them (never the engine key),
 *                      the person's prompts (48 h+) and each session's end-of-turn messages, the Pilot chat
 *                      thread (nudges, questions, answers) and prompt-check runs
 *   repos/<key>/       per working tree: lookout.db (events, jobs, findings, notes), snapshots, job files
 *   daemon.log         background daemon output
 *   selftest.json      last local isolation self-test
 *   bin/pilot          stable launcher for the currently installed version
 *
 * Pilot was called Lookout: on the first start with the default home, ~/.lookout is copied to ~/.pilot (databases
 * through SQLite, never by copying live files) and left exactly as it was.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "./util.ts";

export type DB = DatabaseSync;

export const expandHome = (p: string): string => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Real path of a file that may not exist (any more): resolve its folder, keep the name. */
export function realPathish(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.join(real(path.dirname(p)), path.basename(p));
  }
}

/** PILOT_<name>, else the older LOOKOUT_<name> (empty counts as unset). */
export function envVar(name: string): string | undefined {
  for (const k of [`PILOT_${name}`, `LOOKOUT_${name}`]) {
    const v = process.env[k];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

const migrated = new Set<string>();

export function pilotHome(): string {
  const custom = envVar("HOME");
  const home = path.resolve(expandHome(custom || "~/.pilot"));
  if (!custom && !migrated.has(home)) {
    migrated.add(home);
    migrateFromLookout(home);
  }
  return home;
}

/**
 * A consistent copy of a SQLite database that may be live, without opening it (even a read-only connection writes
 * reader marks into its -shm): its WAL is copied first, then the database file, into a private folder; SQLite
 * recovers that pair (frames are checksummed; pages a checkpoint moved meanwhile are in both) and VACUUM INTO writes
 * a single clean file.
 */
function copyDatabase(src: string, dst: string): void {
  const stage = fs.mkdtempSync(path.join(path.dirname(dst), ".copy-"));
  try {
    const db0 = path.join(stage, "db");
    if (fs.existsSync(`${src}-wal`)) fs.copyFileSync(`${src}-wal`, `${db0}-wal`);
    fs.copyFileSync(src, db0);
    const db = new DatabaseSync(db0);
    try {
      db.prepare("VACUUM INTO ?").run(dst);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** Copies Lookout's home except what Pilot rebuilds: the old launcher, review snapshots and job files (hundreds of MB). */
function copyTree(src: string, dst: string, depth = 0): void {
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) {
      const skip = (depth === 0 && e.name === "bin") || (depth === 2 && (e.name === "snapshots" || e.name === "jobs"));
      if (!skip) copyTree(from, to, depth + 1);
    } else if (e.isFile()) {
      if (/\.db-(wal|shm)$/.test(e.name)) continue;
      if (e.name.endsWith(".db")) copyDatabase(from, to);
      else fs.copyFileSync(from, to);
      fs.chmodSync(to, 0o600);
    }
  }
}

/**
 * First start of Pilot with the default home: copy ~/.lookout to ~/.pilot (never move or delete it). Locks held by
 * the old install's processes are cleared in the copy. Best effort: on any error Pilot starts with an empty home.
 */
export function migrateFromLookout(target: string, from = path.join(os.homedir(), ".lookout")): boolean {
  if (fs.existsSync(target) || !fs.existsSync(from)) return false;
  const tmp = `${target}.migrating-${process.pid}`;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    copyTree(from, tmp);
    const clear = (file: string, keys: string) => {
      if (!fs.existsSync(file)) return;
      const db = new DatabaseSync(file);
      try {
        db.exec(`DELETE FROM kv WHERE key IN (${keys}) OR key LIKE 'rewake:%'`);
      } catch {
        /* no kv table */
      } finally {
        db.close();
      }
    };
    clear(path.join(tmp, "registry.db"), "'daemon','daemon_spawned_at','daemon_stop'");
    const repos = path.join(tmp, "repos");
    if (fs.existsSync(repos)) for (const k of fs.readdirSync(repos)) clear(path.join(repos, k, "lookout.db"), "'watcher','stop_requested'");
    fs.writeFileSync(path.join(tmp, "migrated-from-lookout.json"), `${JSON.stringify({ from, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target); // atomic: a second process that raced us loses here and keeps the winner's copy
    return true;
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true });
    return false;
  }
}

export function ensureHome(): string {
  const home = pilotHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

export interface UserConfig {
  profiles?: string[];
  exclude?: string[];
  [key: string]: unknown;
}

let cached: { file: string; mtime: number; value: UserConfig } | null = null;

/** ~/.pilot/config.json, or {} when absent. Invalid JSON is an error (silently ignoring it would surprise). */
export function userConfig(): UserConfig {
  const file = path.join(pilotHome(), "config.json");
  let mtime = -1;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return {};
  }
  if (cached && cached.file === file && cached.mtime === mtime) return cached.value;
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as UserConfig;
  cached = { file, mtime, value };
  return value;
}

/** Setting lookup: env PILOT_FOO_BAR (else LOOKOUT_FOO_BAR) wins, then config.json "foo_bar". Arrays are joined with commas. */
export function setting(envName: string): string | undefined {
  const name = envName.replace(/^(PILOT|LOOKOUT)_/, "");
  const env = envVar(name);
  if (env !== undefined) return env;
  const v = userConfig()[name.toLowerCase()];
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? v.join(",") : String(v);
}

/** The Claude Code profile a hook runs in: CLAUDE_CONFIG_DIR, or ~/.claude by default. */
export function currentProfile(env: NodeJS.ProcessEnv = process.env): string {
  return real(expandHome(env.CLAUDE_CONFIG_DIR || "~/.claude"));
}

/** Profiles Pilot watches: config "profiles" (default ["~/.claude"]); "*" watches every profile it is installed in. */
export function watchedProfiles(): string[] {
  const raw = setting("PILOT_PROFILES");
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : ["~/.claude"];
  return list.map((p) => (p === "*" ? "*" : real(expandHome(p))));
}

export function isWatchedProfile(profile: string): boolean {
  const list = watchedProfiles();
  return list.includes("*") || list.includes(profile);
}

/** Project exclusions: config "exclude" (paths; a repo inside one of them is never watched). */
export function isExcluded(repoRoot: string): boolean {
  const raw = setting("PILOT_EXCLUDE");
  if (!raw) return false;
  const root = real(repoRoot);
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((p) => {
      const ex = real(expandHome(p));
      return root === ex || root.startsWith(`${ex}${path.sep}`);
    });
}

/**
 * Nearest enclosing git working tree (a directory holding .git as a dir or a worktree file), without spawning
 * git: hooks must stay fast. The home directory itself is never treated as a project (dotfile repos).
 */
export function findRepoRoot(start: string): string | null {
  let dir = path.resolve(start);
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {
    dir = path.dirname(dir); // a file that no longer exists: look from its folder
  }
  const home = real(os.homedir());
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      const r = real(dir);
      return r === home ? null : r;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function repoKey(root: string): string {
  const r = real(root);
  const name = path.basename(r).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "repo";
  return `${name}-${sha256(r).slice(0, 10)}`;
}

export const repoStateDir = (root: string): string => path.join(pilotHome(), "repos", repoKey(root));

const REGISTRY = `
CREATE TABLE IF NOT EXISTS repos (
  key TEXT PRIMARY KEY, root TEXT NOT NULL, name TEXT NOT NULL, profile TEXT, first_seen_ms INTEGER NOT NULL, last_event_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  session TEXT PRIMARY KEY, profile TEXT, cwd TEXT, transcript_path TEXT, last_stop_ms INTEGER NOT NULL DEFAULT 0, updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_repos (
  session TEXT NOT NULL, repo_key TEXT NOT NULL, first_ms INTEGER NOT NULL, last_ms INTEGER NOT NULL, PRIMARY KEY (session, repo_key)
);
CREATE TABLE IF NOT EXISTS session_files (
  session TEXT NOT NULL, path TEXT NOT NULL, how TEXT NOT NULL, ts_ms INTEGER NOT NULL, PRIMARY KEY (session, path, how)
);
CREATE TABLE IF NOT EXISTS session_prompts (
  dedupe_key TEXT PRIMARY KEY, session TEXT NOT NULL, ts_ms INTEGER NOT NULL, head TEXT, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_prompts_by_session ON session_prompts(session, ts_ms);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS engine_findings (
  id TEXT PRIMARY KEY, level TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, services TEXT NOT NULL,
  repos TEXT NOT NULL, run_id TEXT, url TEXT, ack TEXT, at TEXT NOT NULL, opened_at TEXT NOT NULL, resolved_at TEXT,
  first_seen_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS engine_told (
  finding_id TEXT NOT NULL, session TEXT NOT NULL, repo_key TEXT NOT NULL, ts_ms INTEGER NOT NULL, channel TEXT NOT NULL, PRIMARY KEY (finding_id, session)
);
CREATE TABLE IF NOT EXISTS session_turns (
  session TEXT NOT NULL, ts_ms INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (session, ts_ms)
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, nudge_kind TEXT, text TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]', session TEXT, repo TEXT, confidence REAL, state TEXT NOT NULL DEFAULT 'new',
  delivered_at_ms INTEGER, session_label TEXT, fingerprint TEXT, for_session TEXT, queued_at_ms INTEGER, seen_ms INTEGER
);
CREATE INDEX IF NOT EXISTS chat_messages_by_session ON chat_messages(session, at_ms);
CREATE TABLE IF NOT EXISTS watch_runs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, session TEXT, repo TEXT, created_ms INTEGER NOT NULL, finished_ms INTEGER,
  status TEXT NOT NULL, summary TEXT, cost_cents INTEGER, reserved_cents INTEGER NOT NULL DEFAULT 0, message_id INTEGER
);
`;

/** Columns added after a table first shipped (additive: older hooks keep working against a newer registry). */
const REGISTRY_COLUMNS = [
  "ALTER TABLE sessions ADD COLUMN first_prompt TEXT",
  "ALTER TABLE sessions ADD COLUMN ended_ms INTEGER",
  "ALTER TABLE session_prompts ADD COLUMN check_id INTEGER",
  "ALTER TABLE chat_messages ADD COLUMN engine TEXT",
  "ALTER TABLE watch_runs ADD COLUMN engine TEXT",
];

const openedReg = new Map<string, DB>();

export function openRegistry(): DB {
  const file = path.join(ensureHome(), "registry.db");
  const hit = openedReg.get(file);
  if (hit) return hit;
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
  db.exec(REGISTRY);
  const cols = new Map<string, Set<string>>();
  const have = (table: string) => {
    if (!cols.has(table)) cols.set(table, new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)));
    return cols.get(table)!;
  };
  for (const ddl of REGISTRY_COLUMNS) {
    const [, table, col] = ddl.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/)!;
    if (have(table).has(col)) continue;
    try {
      db.exec(ddl);
    } catch {
      /* another process added it first */
    }
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  openedReg.set(file, db);
  return db;
}

export interface RepoRow {
  key: string;
  root: string;
  name: string;
  profile: string | null;
  first_seen_ms: number;
  last_event_ms: number;
}

export function registerRepo(reg: DB, root: string, profile: string | null, nowMs: number): string {
  const key = repoKey(root);
  reg
    .prepare(
      `INSERT INTO repos(key, root, name, profile, first_seen_ms, last_event_ms) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET last_event_ms = excluded.last_event_ms, profile = COALESCE(excluded.profile, repos.profile)`,
    )
    .run(key, real(root), path.basename(root), profile, nowMs, nowMs);
  return key;
}

export const listRepos = (reg: DB): RepoRow[] => reg.prepare("SELECT * FROM repos ORDER BY last_event_ms DESC").all() as unknown as RepoRow[];

/** Resolve "orders-service", "orders-service-1a2b3c4d5e" or a path to a registered repo. */
export function findRepo(reg: DB, ref: string): RepoRow | null {
  const repos = listRepos(reg);
  const abs = real(expandHome(ref));
  return (
    repos.find((r) => r.key === ref) ??
    repos.find((r) => r.root === abs) ??
    (repos.filter((r) => r.name === ref).length === 1 ? repos.find((r) => r.name === ref)! : null) ??
    (repos.filter((r) => r.key.startsWith(ref)).length === 1 ? repos.find((r) => r.key.startsWith(ref))! : null)
  );
}

export function kvGetReg<T>(reg: DB, key: string, fallback: T): T {
  const row = reg.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function kvSetReg(reg: DB, key: string, value: unknown): void {
  reg.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}
