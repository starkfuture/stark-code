/**
 * Agent Engine findings feed: production monitoring issues (critical and major) that Pilot lists, and says into a
 * session only when that session is changing an affected repository (rules in engineSpeech.ts).
 *
 *  - Key: an engine API key with findings:read (`create_api_key` over the engine's MCP). It lives only in the macOS
 *    Keychain (service "pilot-agent-engine", account = the engine URL; the older "lookout-agent-engine" item is read when it is missing). It is written through the `security` CLI's
 *    stdin, so it never appears on a command line, and it is never stored in config.json, registry.db, logs or output.
 *  - Polling: the daemon calls GET <url>/api/v1/findings every engine_poll_min while it runs. It keeps `next` as the
 *    cursor, calls again at once while `more` is true, and never replays more than 48 h back. Each issue is one row in
 *    registry.db (engine_findings), updated in place when it changes.
 *  - A 401, or a 403 for a missing scope, marks the connection disconnected with a clear error; polling stops until
 *    `pilot engine connect` runs again. Other errors (network, 429, 503) are recorded and retried later.
 */
import { spawnSync } from "node:child_process";
import type { DB } from "./home.ts";
import { envVar, kvGetReg, kvSetReg, setting, userConfig } from "./home.ts";
import { errMessage } from "./util.ts";

export const KEYCHAIN_SERVICE = "pilot-agent-engine";
/** Pilot was called Lookout: its key is read from the old item until a new one is stored. */
export const LEGACY_KEYCHAIN_SERVICE = "lookout-agent-engine";
export const DEFAULT_ENGINE_URL = "https://agent-engine.starkfuture.com";
export const FEED_PATH = "/api/v1/findings";
export const REPLAY_MS = 48 * 3600_000;
const KEY_RE = /^ae_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/;
const KEY_ANYWHERE = /ae_[0-9a-f]{12}_[A-Za-z0-9_-]{20,}/g;
const PAGE_LIMIT = 200;
const MAX_PAGES = 25;
const TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export const LEVELS = ["critical", "major"] as const;
export type EngineLevel = (typeof LEVELS)[number];
const STATUSES = ["open", "resolved"] as const;
const ACKS = ["on_it", "not_an_issue"] as const;

/** One issue as the feed returns it, after validation. */
export interface EngineFinding {
  id: string;
  level: EngineLevel;
  status: "open" | "resolved";
  title: string;
  summary: string;
  services: string[];
  repos: string[];
  runId: string | null;
  url: string | null;
  ack: "on_it" | "not_an_issue" | null;
  at: string;
  openedAt: string;
  resolvedAt: string | null;
}

export interface EngineFindingRow {
  id: string;
  level: string;
  status: string;
  title: string;
  summary: string;
  services: string;
  repos: string;
  run_id: string | null;
  url: string | null;
  ack: string | null;
  at: string;
  opened_at: string;
  resolved_at: string | null;
  first_seen_ms: number;
  updated_ms: number;
}

/** Removes anything shaped like an engine key from text that may be shown or logged. */
export const scrubKeys = (s: string): string => s.replace(KEY_ANYWHERE, "ae_[redacted]");
export const isEngineKey = (s: string): boolean => KEY_RE.test(s);

// ---------------------------------------------------------------------------------------------------------------
// Settings

export interface EngineSettings {
  url: string;
  pollMin: number;
  repos: Record<string, string>;
  reposError: string | null;
}

/** engine_url, engine_poll_min, engine_repos (env PILOT_ENGINE_* wins; PILOT_ENGINE_REPOS is a JSON object). */
export function engineSettings(): EngineSettings {
  const poll = Number(setting("PILOT_ENGINE_POLL_MIN") ?? 5);
  let repos: Record<string, string> = {};
  let reposError: string | null = null;
  try {
    const env = envVar("ENGINE_REPOS");
    const raw: unknown = env ? JSON.parse(env) : userConfig().engine_repos;
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("must be an object");
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string" && k.trim() && v.trim()) repos[k.trim()] = v.trim();
    }
  } catch (err) {
    repos = {};
    reposError = `engine_repos ${errMessage(err)}: expected {"<service or owner/name>": "<local repository path>"}`;
  }
  return { url: setting("PILOT_ENGINE_URL") || DEFAULT_ENGINE_URL, pollMin: Number.isFinite(poll) && poll >= 1 ? poll : 5, repos, reposError };
}

/** https only (plain http for localhost, for development); no credentials, query or fragment; no trailing slash. */
export function normalizeEngineUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`the engine URL is not a URL: "${scrubKeys(raw).slice(0, 200)}"`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("the engine URL must use https (plain http only for localhost)");
  if (u.username || u.password || u.search || u.hash) throw new Error("the engine URL must not contain credentials, a query or a fragment");
  const out = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  if (!/^[\x21-\x7e]+$/.test(out) || /["\\]/.test(out)) throw new Error("the engine URL contains characters Pilot does not accept");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Keychain

export interface Keychain {
  get(account: string): string | null;
  set(account: string, secret: string): void;
  delete(account: string): boolean;
}

const SAFE_ARG = /^[\x21-\x7e]+$/;

/**
 * The macOS Keychain through /usr/bin/security. The secret goes in on stdin (`security -i` reads commands from it),
 * never on argv, so it does not show up in `ps` or shell history. Error messages never carry security's output.
 */
export function macKeychain(service = KEYCHAIN_SERVICE, bin = "security"): Keychain {
  const check = (name: string, v: string) => {
    if (!SAFE_ARG.test(v) || /["\\]/.test(v)) throw new Error(`keychain ${name} contains characters Pilot does not pass to security`);
  };
  check("service", service);
  return {
    get(account) {
      check("account", account);
      for (const svc of service === KEYCHAIN_SERVICE ? [service, LEGACY_KEYCHAIN_SERVICE] : [service]) {
        const r = spawnSync(bin, ["find-generic-password", "-s", svc, "-a", account, "-w"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
        if (r.status === 0) return r.stdout.replace(/\r?\n$/, "") || null;
        if (r.status !== 44) throw new Error(`could not read the key from the macOS Keychain (security exit ${r.status ?? r.signal ?? "?"})`);
      }
      return null; // not found
    },
    set(account, secret) {
      check("account", account);
      if (!isEngineKey(secret)) throw new Error("refusing to store something that is not an Agent Engine key");
      const r = spawnSync(bin, ["-i"], {
        input: `add-generic-password -U -s "${service}" -a "${account}" -l "Pilot: Agent Engine key" -w "${secret}"\n`,
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["pipe", "ignore", "ignore"],
      });
      if (r.status !== 0) throw new Error(`could not store the key in the macOS Keychain (security exit ${r.status ?? r.signal ?? "?"})`);
    },
    delete(account) {
      check("account", account);
      let removed = false;
      for (const svc of service === KEYCHAIN_SERVICE ? [service, LEGACY_KEYCHAIN_SERVICE] : [service]) {
        const r = spawnSync(bin, ["delete-generic-password", "-s", svc, "-a", account], { timeout: 10_000, stdio: ["ignore", "ignore", "ignore"] });
        if (r.status === 0) removed = true;
        else if (r.status !== 44) throw new Error(`could not remove the key from the macOS Keychain (security exit ${r.status ?? r.signal ?? "?"})`);
      }
      return removed;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Connection and poll state (registry kv; never the key)

export interface EngineConn {
  url: string;
  connectedAt: string;
  state: "connected" | "disconnected";
}

export interface EnginePoll {
  url: string;
  cursor: string | null;
  lastPollAt: string | null; // last successful poll
  lastError: string | null; // the latest attempt's error; null when it succeeded
  nextPollMs: number;
}

export const getConn = (reg: DB): EngineConn | null => kvGetReg<EngineConn | null>(reg, "engine_conn", null);
export const getPoll = (reg: DB): EnginePoll | null => kvGetReg<EnginePoll | null>(reg, "engine_poll", null);
const setPoll = (reg: DB, p: EnginePoll) => kvSetReg(reg, "engine_poll", p);
export const isConnected = (reg: DB): boolean => getConn(reg)?.state === "connected";

function markDisconnected(reg: DB, conn: EngineConn, poll: EnginePoll, error: string): void {
  kvSetReg(reg, "engine_conn", { ...conn, state: "disconnected" });
  setPoll(reg, { ...poll, lastError: error, nextPollMs: Number.MAX_SAFE_INTEGER });
}

/** True when the daemon should poll now: connected and the poll interval (or a server's Retry-After) has passed. */
export function enginePollDue(reg: DB, nowMs = Date.now()): boolean {
  if (!isConnected(reg)) return false;
  return nowMs >= (getPoll(reg)?.nextPollMs ?? 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Feed client

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; redirect: "error"; signal: AbortSignal }) => Promise<Response>;

interface FeedPage {
  findings: EngineFinding[];
  skipped: number;
  next: string;
  more: boolean;
}

type FeedAnswer = { ok: true; page: FeedPage } | { ok: false; status: number; error: string; retryAfterMs: number | null; challenge: string };

const oneLine = (v: unknown, max: number): string =>
  String(v ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const isoOk = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const strList = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => oneLine(x, maxLen)).filter(Boolean))].slice(0, maxItems) : [];

/** One feed item, validated and bounded; null when it does not follow the contract (it is skipped, not guessed). */
export function parseFinding(v: unknown): EngineFinding | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !/^I-[A-Za-z0-9_-]{1,40}$/.test(o.id)) return null;
  if (!LEVELS.includes(o.level as EngineLevel) || !STATUSES.includes(o.status as never)) return null;
  if (!isoOk(o.at) || !isoOk(o.openedAt)) return null;
  const title = oneLine(o.title, 300);
  if (!title) return null;
  let url: string | null = null;
  if (typeof o.url === "string") {
    try {
      const u = new URL(o.url);
      if (u.protocol === "https:" && !/\s/.test(o.url) && o.url.length <= 500) url = u.href;
    } catch {
      /* not a link: dropped */
    }
  }
  return {
    id: o.id,
    level: o.level as EngineLevel,
    status: o.status as EngineFinding["status"],
    title,
    summary: oneLine(o.summary, 240),
    services: strList(o.services, 20, 100),
    repos: strList(o.repos, 20, 200),
    runId: typeof o.runId === "string" && o.runId ? oneLine(o.runId, 100) : null,
    url,
    ack: ACKS.includes(o.ack as never) ? (o.ack as EngineFinding["ack"]) : null,
    at: o.at,
    openedAt: o.openedAt,
    resolvedAt: isoOk(o.resolvedAt) ? o.resolvedAt : null,
  };
}

function retryAfter(h: string | null): number | null {
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s) && s >= 0) return Math.min(s, 3600) * 1000;
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, Math.min(t - Date.now(), 3600_000));
}

async function getFeed(fetchFn: FetchFn, url: string, key: string, params: Record<string, string>): Promise<FeedAnswer> {
  const q = new URLSearchParams(params).toString();
  let res: Response;
  try {
    // No Origin header (the engine refuses browser origins it does not know); no redirects (the key stays on this host).
    res = await fetchFn(`${url}${FEED_PATH}?${q}`, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json", "user-agent": "pilot-engine-feed/1" },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const cause = (err as { cause?: unknown })?.cause;
    const why = errMessage(err) + (cause ? ` (${errMessage(cause)})` : "");
    return { ok: false, status: 0, error: `cannot reach ${url}: ${oneLine(scrubKeys(why), 200)}`, retryAfterMs: null, challenge: "" };
  }
  const text = await res.text().catch(() => "");
  const challenge = res.headers.get("www-authenticate") ?? "";
  if (text.length > MAX_BODY_BYTES) return { ok: false, status: res.status, error: `the engine answered ${res.status} with an oversized body`, retryAfterMs: null, challenge };
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* handled below */
  }
  if (res.status !== 200) {
    const msg = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? oneLine(scrubKeys((body as { error: string }).error), 200) : "";
    return { ok: false, status: res.status, error: msg, retryAfterMs: retryAfter(res.headers.get("retry-after")), challenge };
  }
  const b = body as { findings?: unknown; next?: unknown; more?: unknown } | null;
  if (!b || !Array.isArray(b.findings) || typeof b.next !== "string" || !b.next || b.next.length > 2000 || typeof b.more !== "boolean") {
    return { ok: false, status: 200, error: "the engine's answer does not follow the findings feed contract", retryAfterMs: null, challenge };
  }
  const findings: EngineFinding[] = [];
  let skipped = 0;
  for (const f of b.findings) {
    const p = parseFinding(f);
    if (p) findings.push(p);
    else skipped++;
  }
  return { ok: true, page: { findings, skipped, next: b.next, more: b.more } };
}

// ---------------------------------------------------------------------------------------------------------------
// Storage

/** Insert new issues, update known ones in place (current state wins). Returns how many were new and changed. */
export function upsertFindings(reg: DB, findings: EngineFinding[], nowMs = Date.now()): { added: number; changed: number } {
  let added = 0;
  const exists = reg.prepare("SELECT 1 FROM engine_findings WHERE id = ?");
  const up = reg.prepare(
    `INSERT INTO engine_findings(id, level, status, title, summary, services, repos, run_id, url, ack, at, opened_at, resolved_at, first_seen_ms, updated_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET level = excluded.level, status = excluded.status, title = excluded.title, summary = excluded.summary,
       services = excluded.services, repos = excluded.repos, run_id = excluded.run_id, url = excluded.url, ack = excluded.ack, at = excluded.at,
       opened_at = excluded.opened_at, resolved_at = excluded.resolved_at, updated_ms = excluded.updated_ms`,
  );
  reg.exec("BEGIN IMMEDIATE");
  try {
    for (const f of findings) {
      if (!exists.get(f.id)) added++;
      up.run(f.id, f.level, f.status, f.title, f.summary, JSON.stringify(f.services), JSON.stringify(f.repos), f.runId, f.url, f.ack, f.at, f.openedAt, f.resolvedAt, nowMs, nowMs);
    }
    reg.exec("COMMIT");
  } catch (e) {
    reg.exec("ROLLBACK");
    throw e;
  }
  return { added, changed: findings.length };
}

export const listEngineFindings = (reg: DB, limit = 1000): EngineFindingRow[] =>
  reg.prepare("SELECT * FROM engine_findings ORDER BY at DESC, id DESC LIMIT ?").all(limit) as unknown as EngineFindingRow[];

export const toldCount = (reg: DB, id: string): number => Number((reg.prepare("SELECT COUNT(DISTINCT session) AS n FROM engine_told WHERE finding_id = ?").get(id) as { n: number }).n);

// ---------------------------------------------------------------------------------------------------------------
// Poll

export interface PollDeps {
  reg: DB;
  keychain: Keychain;
  fetch?: FetchFn;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface PollResult {
  polled: boolean;
  pages: number;
  added: number;
  changed: number;
  skipped: number;
  error: string | null;
  disconnected: boolean;
}

const RECONNECT = "Create a new key (create_api_key on the engine's MCP, as an admin) and run `pilot engine connect`.";

/** One poll: every page the feed has after our cursor (or the last 48 h). Never throws; never logs the key. */
export async function pollEngine(d: PollDeps): Promise<PollResult> {
  const now = d.now ?? Date.now;
  const fetchFn: FetchFn = d.fetch ?? ((u, i) => fetch(u, i));
  const result: PollResult = { polled: false, pages: 0, added: 0, changed: 0, skipped: 0, error: null, disconnected: false };
  const conn = getConn(d.reg);
  if (!conn || conn.state !== "connected") return { ...result, error: "not connected" };
  const pollMin = engineSettings().pollMin;
  const prev = getPoll(d.reg);
  let st: EnginePoll = prev && prev.url === conn.url ? prev : { url: conn.url, cursor: null, lastPollAt: null, lastError: null, nextPollMs: 0 };
  const fail = (error: string, retryMs: number | null = null): PollResult => {
    const lastError = scrubKeys(error);
    if (lastError !== prev?.lastError) d.log?.(`poll failed: ${lastError}`);
    setPoll(d.reg, { ...st, lastError, nextPollMs: now() + Math.max(retryMs ?? 0, pollMin * 60_000) });
    return { ...result, error: lastError };
  };

  let key: string | null;
  try {
    key = d.keychain.get(conn.url);
  } catch (err) {
    return fail(errMessage(err));
  }
  if (!key) {
    const error = `no key for ${conn.url} in the macOS Keychain. ${RECONNECT}`;
    markDisconnected(d.reg, conn, st, error);
    d.log?.(`disconnected: ${error}`);
    return { ...result, error, disconnected: true };
  }

  // Never replay more than 48 h: without a cursor, or after 48 h without a successful poll, start at now - 48 h.
  const fresh = st.lastPollAt !== null && now() - Date.parse(st.lastPollAt) <= REPLAY_MS;
  let cursor = fresh ? st.cursor : null;
  let retriedCursor = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = cursor ? { cursor } : { since: new Date(now() - REPLAY_MS).toISOString() };
    const a = await getFeed(fetchFn, conn.url, key, { ...params, min_level: "major", status: "all", limit: String(PAGE_LIMIT) });
    result.polled = true;
    if (!a.ok) {
      if (a.status === 400 && cursor && !retriedCursor) {
        // The engine does not know our cursor (e.g. its database was rebuilt): start again from 48 h ago.
        retriedCursor = true;
        cursor = null;
        st = { ...st, cursor: null };
        d.log?.("the engine refused the saved cursor; restarting from 48 h ago");
        page--;
        continue;
      }
      if (a.status === 401 || (a.status === 403 && /insufficient_scope/.test(a.challenge))) {
        const error =
          a.status === 401
            ? `the Agent Engine rejected the key (401: missing, unknown, revoked or expired, or its maker lost access). ${RECONNECT}`
            : `the key lacks the findings:read scope (403). ${RECONNECT}`;
        markDisconnected(d.reg, conn, st, error);
        d.log?.(`disconnected: ${error}`);
        return { ...result, error, disconnected: true };
      }
      if (a.status === 0) return fail(a.error);
      const what =
        a.status === 429 ? "rate limited (429)" : a.status === 503 ? "the engine cannot read its database (503)" : a.status === 403 ? "forbidden (403)" : `HTTP ${a.status}`;
      return fail(`${what}${a.error ? `: ${a.error}` : ""}`, a.retryAfterMs);
    }
    result.pages++;
    result.skipped += a.page.skipped;
    const up = upsertFindings(d.reg, a.page.findings, now());
    result.added += up.added;
    result.changed += up.changed;
    cursor = a.page.next;
    st = { ...st, cursor };
    setPoll(d.reg, { ...st, lastError: prev?.lastError ?? null }); // progress survives a crash mid-poll
    if (!a.page.more) break;
  }
  const more = result.pages >= MAX_PAGES; // a large backlog: continue soon, without hammering the engine
  setPoll(d.reg, { ...st, lastPollAt: new Date(now()).toISOString(), lastError: null, nextPollMs: now() + (more ? 30_000 : pollMin * 60_000) });
  // Bounded registry: forget issues untouched for 30 days, and who was told about them.
  const old = now() - 30 * 86_400_000;
  d.reg.prepare("DELETE FROM engine_findings WHERE updated_ms < ?").run(old);
  d.reg.prepare("DELETE FROM engine_told WHERE ts_ms < ?").run(old);
  if (result.changed) d.log?.(`${result.changed} finding(s) changed (${result.added} new)${result.skipped ? `; ${result.skipped} malformed item(s) skipped` : ""}`);
  if (prev?.lastError) d.log?.("poll recovered");
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Connect / disconnect / status

/** Checks the key against the feed, then stores it in the Keychain and marks the engine connected. */
export async function connectEngine(o: { reg: DB; url: string; secret: string; keychain: Keychain; fetch?: FetchFn }): Promise<{ url: string }> {
  const url = normalizeEngineUrl(o.url);
  const secret = o.secret.trim();
  if (!isEngineKey(secret)) throw new Error("that is not an Agent Engine key (expected ae_<12 hex>_<43 characters>, from create_api_key). Nothing was stored.");
  const a = await getFeed(o.fetch ?? ((u, i) => fetch(u, i)), url, secret, { since: new Date().toISOString(), limit: "1" });
  if (!a.ok) {
    const why =
      a.status === 401
        ? "the engine rejected the key (401: unknown, revoked or expired, or its maker lost access)"
        : a.status === 403
          ? `the engine refused the key (403${/insufficient_scope/.test(a.challenge) ? ": it lacks findings:read" : ""})`
          : a.status === 0
            ? a.error
            : `the engine answered HTTP ${a.status}${a.error ? `: ${a.error}` : ""}`;
    throw new Error(`could not verify the key: ${why}. Nothing was stored.`);
  }
  o.keychain.set(url, secret);
  const prev = getConn(o.reg);
  if (prev && prev.url !== url) {
    try {
      o.keychain.delete(prev.url); // one engine at a time: the old key goes
    } catch {
      /* best effort */
    }
  }
  kvSetReg(o.reg, "engine_conn", { url, connectedAt: new Date().toISOString(), state: "connected" } satisfies EngineConn);
  const poll = getPoll(o.reg);
  setPoll(o.reg, poll && poll.url === url ? { ...poll, lastError: null, nextPollMs: 0 } : { url, cursor: null, lastPollAt: null, lastError: null, nextPollMs: 0 });
  return { url };
}

/** Removes the key from the Keychain and forgets the connection and cursor. Stored findings stay listed. */
export function disconnectEngine(o: { reg: DB; keychain: Keychain }): { url: string | null; removed: boolean; error: string | null } {
  const conn = getConn(o.reg);
  const url = conn?.url ?? null;
  let removed = false;
  let error: string | null = null;
  try {
    removed = url ? o.keychain.delete(url) : false;
  } catch (err) {
    error = errMessage(err); // polling stops anyway; the person is told the key may still be in the Keychain
  }
  kvSetReg(o.reg, "engine_conn", null);
  kvSetReg(o.reg, "engine_poll", null);
  return { url, removed, error };
}

export interface EngineSummary {
  connected: boolean;
  url: string | null;
  lastPollAt: string | null;
  lastError: string | null;
  findings: number;
  open: { critical: number; major: number };
}

/** Connection, poll state and counts from the registry only (never the Keychain, so it is fast and never prompts). */
export function engineSummary(reg: DB): EngineSummary {
  const conn = getConn(reg);
  const poll = getPoll(reg);
  const sameUrl = poll && conn && poll.url === conn.url ? poll : null;
  const n = (sql: string) => Number((reg.prepare(sql).get() as { n: number }).n);
  return {
    connected: conn?.state === "connected",
    url: conn?.url ?? null,
    lastPollAt: sameUrl?.lastPollAt ?? null,
    lastError: sameUrl?.lastError ?? null,
    findings: n("SELECT COUNT(*) AS n FROM engine_findings"),
    open: {
      critical: n("SELECT COUNT(*) AS n FROM engine_findings WHERE status = 'open' AND level = 'critical'"),
      major: n("SELECT COUNT(*) AS n FROM engine_findings WHERE status = 'open' AND level = 'major'"),
    },
  };
}

/** One line for `pilot status`. */
export function engineStatusLine(reg: DB): string {
  const s = engineSummary(reg);
  const counts = `${s.findings} finding(s), ${s.open.critical + s.open.major} open (${s.open.critical} critical, ${s.open.major} major)`;
  if (s.connected) return `connected to ${s.url} · ${counts} · last poll ${s.lastPollAt ? s.lastPollAt.slice(0, 16).replace("T", " ") + " UTC" : "not yet"}${s.lastError ? ` · last error: ${s.lastError}` : ""}`;
  if (s.url) return `disconnected: ${s.lastError ?? "run `pilot engine connect`"} · ${counts}`;
  return s.findings ? `not connected · ${counts} (stored earlier)` : "not connected (`pilot engine connect`)";
}

/**
 * Reads the key without echoing it: a hidden prompt on a terminal, or the first line of stdin when piped.
 * It is never taken from argv.
 */
export async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(c as Buffer);
    return (Buffer.concat(chunks).toString("utf8").split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  }
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = (err?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(buf.trim());
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
