import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseJson } from "./util.ts";

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  cc_session TEXT,
  ts TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  head TEXT,
  payload TEXT NOT NULL,
  job_id INTEGER,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_pending ON events(consumed, ts_ms);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  depth TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  parent_job_id INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  input TEXT,
  snapshot_id TEXT,
  revision TEXT,
  runtime TEXT,
  session_id TEXT,
  upload_ids TEXT,
  budget_cents INTEGER,
  reserved_cents INTEGER,
  list_cost_cents INTEGER,
  cost_source TEXT,
  usage TEXT,
  outcome TEXT,
  error TEXT,
  summary TEXT,
  ingested INTEGER NOT NULL DEFAULT 0,
  prior_cost_cents INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  head TEXT,
  dirty INTEGER NOT NULL,
  revision TEXT NOT NULL,
  file_hashes TEXT NOT NULL,
  manifest TEXT NOT NULL,
  bytes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  why_it_matters TEXT NOT NULL,
  evidence TEXT NOT NULL,
  grounding TEXT NOT NULL,
  confidence REAL,
  uncertainty TEXT,
  next_action TEXT,
  handoff_prompt TEXT,
  related_paths TEXT NOT NULL,
  path_hashes TEXT NOT NULL,
  revision TEXT NOT NULL,
  first_revision TEXT NOT NULL,
  first_job_id INTEGER,
  last_job_id INTEGER,
  seen_count INTEGER NOT NULL DEFAULT 1,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  prev_status TEXT,
  status_reason TEXT,
  decision_note TEXT,
  decided_at TEXT,
  decision_path_hashes TEXT,
  defer_until TEXT,
  runtime TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  delivered_session TEXT,
  severity TEXT,
  attribution TEXT,
  proof TEXT,
  awareness TEXT,
  risk_areas TEXT,
  failure_case TEXT,
  controls_checked TEXT,
  origin_session TEXT,
  speak TEXT
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  session TEXT,
  channel TEXT NOT NULL,
  finding_ids TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finding_history (
  id INTEGER PRIMARY KEY,
  finding_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  job_id INTEGER,
  action TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS notes_versions (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  job_id INTEGER,
  notes TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const opened = new Map<string, DB>();

export function openDb(stateDir: string): DB {
  const file = path.join(stateDir, "lookout.db");
  const cached = opened.get(file);
  if (cached) return cached;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
  db.exec(SCHEMA);
  for (const ddl of [
    "ALTER TABLE jobs ADD COLUMN prior_cost_cents INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE findings ADD COLUMN delivered_at TEXT",
    "ALTER TABLE findings ADD COLUMN delivered_session TEXT",
    ...["severity", "attribution", "proof", "awareness", "risk_areas", "failure_case", "controls_checked", "origin_session", "speak"].map((c) => `ALTER TABLE findings ADD COLUMN ${c} TEXT`),
  ]) {
    try {
      db.exec(ddl); // databases created before these columns
    } catch {
      /* already present */
    }
  }
  opened.set(file, db);
  return db;
}

export function kvGet<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? parseJson<T>(row.value, fallback) : fallback;
}

export function kvSet(db: DB, key: string, value: unknown): void {
  db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    JSON.stringify(value),
  );
}

export function kvDel(db: DB, key: string): void {
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
}

/** BEGIN IMMEDIATE so concurrent hook writers queue behind the watcher instead of failing mid-transaction. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export interface JobRow {
  id: number;
  kind: string;
  depth: string;
  trigger: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  parent_job_id: number | null;
  attempt: number;
  input: string | null;
  snapshot_id: string | null;
  revision: string | null;
  runtime: string | null;
  session_id: string | null;
  upload_ids: string | null;
  budget_cents: number | null;
  reserved_cents: number | null;
  list_cost_cents: number | null;
  cost_source: string | null;
  usage: string | null;
  outcome: string | null;
  error: string | null;
  summary: string | null;
  ingested: number;
  prior_cost_cents: number;
}

export interface EventRow {
  id: number;
  dedupe_key: string;
  kind: string;
  cc_session: string | null;
  ts: string;
  ts_ms: number;
  head: string | null;
  payload: string;
  job_id: number | null;
  consumed: number;
}

export const getJob = (db: DB, id: number): JobRow | undefined =>
  db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;

export function updateJob(db: DB, id: number, fields: Partial<JobRow>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE jobs SET ${set} WHERE id = ?`).run(
    ...keys.map((k) => (fields as Record<string, unknown>)[k] as never),
    id,
  );
}
