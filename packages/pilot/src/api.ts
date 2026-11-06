/**
 * `pilot api <method> [flags]`: the JSON interface for apps (api version 1, see README "JSON API (for apps)").
 *
 * Contract:
 *  - stdout carries exactly one JSON object and nothing else: no colours, banners or warnings. Anything a module
 *    prints by accident is sent to stderr instead.
 *  - Every response has "api": 1. Exit 0 on success; on error exit 1 with {"api":1,"error":"<message>"}.
 *  - Privacy: `activity` reports event kinds, file paths, test statuses and run summaries only. It never returns
 *    prompt text, agent messages, commands or file contents. `production` never returns the engine key, and reads
 *    only the registry (never the Keychain). `chat` returns quotes of the person's own prompts and rules: it is a
 *    local interface for the person's own apps, and every text and quote was redacted before it was stored.
 */
import fs from "node:fs";
import path from "node:path";
import { format, parseArgs } from "node:util";
import type { Config } from "./config.ts";
import type { DB, JobRow } from "./db.ts";
import type { Decision, FindingRow, Grounding } from "./findings.ts";
import type { RepoRow } from "./home.ts";
import { ISSUE_TYPES, SEVERITIES, type EvidenceItem, type IssueType, type Severity } from "./investigator/types.ts";
import { errMessage, parseJson } from "./util.ts";

export const API_VERSION = 1;

type Json = Record<string, unknown>;

const OPTIONS = {
  repo: { type: "string" },
  all: { type: "boolean" },
  limit: { type: "string" },
  ref: { type: "string" },
  action: { type: "string" },
  note: { type: "string" },
  until: { type: "string" },
  since: { type: "string" },
  text: { type: "string" },
  id: { type: "string" },
  engine: { type: "string" },
} as const;

/** Flags each method accepts; anything else is an error. */
const METHODS: Record<string, Array<keyof typeof OPTIONS>> = {
  status: [],
  chat: ["since", "limit"],
  ask: ["text", "engine"],
  settings: ["engine"],
  nudge: ["id", "all", "action"],
  findings: ["repo", "all"],
  activity: ["repo", "limit"],
  production: ["limit"],
  decide: ["ref", "action", "note", "until"],
  pause: ["repo"],
  resume: ["repo"],
};

const ACTIVE_JOB = "('running','starting','queued')";
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const EVENT_KINDS = ["prompt", "edit", "test", "stop"] as const;
const DECISIONS: Decision[] = ["accept", "dismiss", "defer", "reopen"];

const iso = (ms: number | null | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const count = (db: DB, sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);

interface Home {
  home: typeof import("./home.ts");
  db: typeof import("./db.ts");
  reg: DB;
}

async function openHome(): Promise<Home> {
  const home = await import("./home.ts");
  const db = await import("./db.ts");
  return { home, db, reg: home.openRegistry() };
}

const repoDb = (h: Home, r: RepoRow): DB => h.db.openDb(path.join(h.home.pilotHome(), "repos", r.key));

/** --repo as a name, key or path (a path inside a watched working tree also works). */
function resolveRepo(h: Home, ref: string): RepoRow {
  const hit = h.home.findRepo(h.reg, ref);
  if (hit) return hit;
  const abs = path.resolve(h.home.expandHome(ref));
  if (fs.existsSync(abs)) {
    const root = h.home.findRepoRoot(abs);
    const inner = root ? h.home.findRepo(h.reg, root) : null;
    if (inner) return inner;
  }
  throw new Error(`no watched repository "${ref}"`);
}

/** Display reference for a repository: its name when unique among watched repos, else its key (same as the CLI). */
function refsFor(repos: RepoRow[]): Map<string, string> {
  return new Map(repos.map((r) => [r.key, repos.filter((x) => x.name === r.name).length > 1 ? r.key : r.name]));
}

/** A run's one-line summary. Raw error text (it can carry tool stderr) never leaves Pilot: only that it failed. */
function runSummary(j: { summary: string | null; error: string | null; status: string }): string {
  if (j.summary) return j.summary;
  return j.error ? `${j.status === "queued" ? "waiting" : "failed"} (details: pilot runs)` : "";
}

function costCents(j: Pick<JobRow, "list_cost_cents" | "prior_cost_cents">): number | null {
  const prior = Number(j.prior_cost_cents ?? 0);
  if (j.list_cost_cents === null || j.list_cost_cents === undefined) return prior > 0 ? prior : null;
  return Number(j.list_cost_cents) + prior;
}

function apiRun(j: JobRow): Json {
  return {
    id: Number(j.id),
    kind: j.kind,
    status: j.status,
    finishedAt: j.finished_at ?? null,
    costCents: costCents(j),
    summary: runSummary(j),
  };
}

function apiEvidence(e: EvidenceItem, check: Grounding["checks"][number] | undefined): Json {
  const out: Json = { type: e.type === "file" || e.type === "command" ? e.type : "event" };
  if (e.path) out.path = e.path;
  if (typeof e.line_start === "number") out.lineStart = e.line_start;
  if (typeof e.quote === "string") out.quote = e.quote;
  if (typeof e.command === "string") out.command = e.command;
  if (typeof e.output_excerpt === "string") out.outputExcerpt = e.output_excerpt;
  out.check = check && ["verified", "failed", "unverifiable"].includes(check.result) ? check.result : null;
  return out;
}

export function apiFinding(r: FindingRow, repo: RepoRow, ref: string): Json {
  const g = parseJson<Grounding | null>(r.grounding, null);
  const ev = parseJson<EvidenceItem[]>(r.evidence, []);
  const sp = parseJson<{ action?: string; why?: string } | null>(r.speak, null);
  const action = sp && ["speak", "inbox", "silent"].includes(sp.action ?? "") ? sp.action : null;
  const risk = parseJson<unknown>(r.risk_areas, []);
  return {
    ref: `${ref}#${r.id}`,
    repo: repo.name,
    repoKey: repo.key,
    id: Number(r.id),
    title: r.title,
    severity: SEVERITIES.includes(r.severity as Severity) ? (r.severity as Severity) : null,
    // Findings recorded before issue types existed were all failures.
    issueType: ISSUE_TYPES.includes(r.kind as IssueType) ? (r.kind as IssueType) : "defect",
    attribution: r.attribution ?? null,
    proof: r.proof ?? null,
    awareness: r.awareness ?? null,
    riskAreas: Array.isArray(risk) ? risk.filter((x): x is string => typeof x === "string") : [],
    status: r.status,
    statement: r.statement,
    failureCase: r.failure_case || null,
    whyItMatters: r.why_it_matters,
    nextAction: r.next_action || null,
    handoffPrompt: r.handoff_prompt || null,
    evidence: (Array.isArray(ev) ? ev : []).map((e, i) => apiEvidence(e, g?.checks?.find((c) => c.index === i))),
    speech: action ? { action, why: sp?.why ?? "", toldSession: !!r.delivered_at } : null,
    deliveredAt: r.delivered_at ?? null,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    decisionNote: r.decision_note ?? null,
  };
}

async function status(h: Home): Promise<Json> {
  const { loadConfig } = await import("./config.ts");
  const { daemonStatus } = await import("./watcher.ts");
  const { getCap, repoSpend, watchSpend } = await import("./budget.ts");
  const repos = h.home.listRepos(h.reg);
  // Settings do not depend on the repository; `cheap` with an explicit path avoids a git subprocess.
  const base: Config = loadConfig(repos[0]?.root ?? h.home.pilotHome(), { cheap: true });
  let selftest = { ok: true, reason: `not needed in ${base.mode} mode` };
  if (base.mode === "local") {
    const { selfTestStatus } = await import("./selftest.ts");
    selftest = selfTestStatus(base);
  }
  // Machine-wide window: spend in every repository; in-flight reservations count against what is available, not as spent.
  const cap = getCap(h.reg, base);
  const totals = repos.map((r) => repoSpend(repoDb(h, r), base)).reduce((a, s) => ({ spent: a.spent + s.spent, reserved: a.reserved + s.reserved }), { spent: 0, reserved: 0 });
  const w = watchSpend(h.reg, base); // prompt checks and chat answers
  const b = { capCents: cap, spentCents: totals.spent + w.spent, availableCents: cap - totals.spent - totals.reserved - w.spent - w.reserved };
  const ds = daemonStatus();
  const { unreadCount } = await import("./chat.ts");
  const sessions = count(h.reg, `SELECT COUNT(*) AS n FROM sessions WHERE updated_ms >= ${Date.now() - 6 * 3600_000}`);
  return {
    generatedAt: new Date().toISOString(),
    daemon: { running: ds.running, pid: ds.running && ds.lock ? ds.lock.pid : null, heartbeatAt: iso(ds.lock?.heartbeat) },
    paused: h.home.kvGetReg<boolean>(h.reg, "paused", false) === true,
    profiles: h.home.watchedProfiles(),
    home: h.home.pilotHome(),
    mode: base.mode,
    claudeBin: base.claudeBin,
    delivery: base.delivery,
    selftest: { ok: selftest.ok, reason: selftest.reason },
    budget: { windowHours: base.budgetWindowHours, capCents: b.capCents, spentCents: b.spentCents, availableCents: b.availableCents },
    unread: unreadCount(h.reg),
    sessions,
    reviewWork: base.reviewWork,
    engine: base.engine,
    repos: repos.map((r) => {
      const db = repoDb(h, r);
      const active = db.prepare(`SELECT * FROM jobs WHERE status IN ${ACTIVE_JOB} ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'starting' THEN 1 ELSE 2 END, id LIMIT 1`).get() as JobRow | undefined;
      const last = db.prepare(`SELECT * FROM jobs WHERE status NOT IN ${ACTIVE_JOB} ORDER BY id DESC LIMIT 1`).get() as JobRow | undefined;
      return {
        key: r.key,
        name: r.name,
        root: r.root,
        lastEventAt: iso(r.last_event_ms) ?? new Date(0).toISOString(),
        paused: h.db.kvGet<boolean>(db, "paused", false) === true,
        excluded: h.home.isExcluded(r.root),
        pendingEvents: count(db, "SELECT COUNT(*) AS n FROM events WHERE consumed = 0"),
        openFindings: count(db, "SELECT COUNT(*) AS n FROM findings WHERE status IN ('open','stale')"),
        toldSession: count(db, "SELECT COUNT(*) AS n FROM findings WHERE status IN ('open','stale') AND delivered_at IS NOT NULL"),
        activeJob: active ? { id: Number(active.id), kind: active.kind, status: active.status, startedAt: active.started_at ?? null } : null,
        lastRun: last ? apiRun(last) : null,
      };
    }),
  };
}

function findings(h: Home, o: { repo?: string; all?: boolean }): Json {
  const all = h.home.listRepos(h.reg);
  const refs = refsFor(all);
  const repos = o.repo ? [resolveRepo(h, o.repo)] : all;
  const where = o.all ? "status != 'unverified'" : "status IN ('open','stale')";
  const out: Array<{ row: FindingRow; json: Json }> = [];
  for (const r of repos) {
    for (const row of repoDb(h, r).prepare(`SELECT * FROM findings WHERE ${where}`).all() as unknown as FindingRow[]) {
      out.push({ row, json: apiFinding(row, r, refs.get(r.key) ?? r.name) });
    }
  }
  // Severity first (unrated last), then newest.
  out.sort(
    (a, b) =>
      (SEV_RANK[a.row.severity ?? ""] ?? 9) - (SEV_RANK[b.row.severity ?? ""] ?? 9) ||
      (b.row.created_at ?? "").localeCompare(a.row.created_at ?? "") ||
      b.row.id - a.row.id,
  );
  return { findings: out.map((x) => x.json) };
}

function activity(h: Home, o: { repo?: string; limit?: string }): Json {
  const limit = o.limit === undefined ? 50 : Number(o.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error(`--limit must be an integer from 1 to 1000, got "${o.limit}"`);
  const repos = o.repo ? [resolveRepo(h, o.repo)] : h.home.listRepos(h.reg);
  const events: Array<{ ms: number; json: Json }> = [];
  const runs: Array<{ at: string; id: number; json: Json }> = [];
  for (const r of repos) {
    const db = repoDb(h, r);
    const rows = db
      .prepare(`SELECT kind, cc_session, ts, ts_ms, payload FROM events WHERE kind IN (${EVENT_KINDS.map(() => "?").join(",")}) ORDER BY ts_ms DESC, id DESC LIMIT ?`)
      .all(...EVENT_KINDS, limit) as Array<{ kind: string; cc_session: string | null; ts: string; ts_ms: number; payload: string }>;
    for (const e of rows) {
      // The payload holds prompt text, agent messages and edit previews: only these named fields leave it.
      const p = parseJson<Record<string, unknown>>(e.payload, {});
      const json: Json = {
        at: iso(Number(e.ts_ms)) ?? e.ts,
        repo: r.name,
        kind: e.kind,
        session: e.cc_session ? e.cc_session.slice(0, 8) : null,
        agentType: typeof p.agent_type === "string" ? p.agent_type : null,
      };
      if (e.kind === "edit" && typeof p.path === "string") json.path = p.path;
      if (e.kind === "test" && typeof p.status === "string") json.testStatus = p.status;
      events.push({ ms: Number(e.ts_ms), json });
    }
    for (const j of db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit) as unknown as JobRow[]) {
      runs.push({
        at: j.created_at ?? "",
        id: Number(j.id),
        json: { repo: r.name, id: Number(j.id), kind: j.kind, status: j.status, trigger: j.trigger, startedAt: j.started_at ?? null, finishedAt: j.finished_at ?? null, costCents: costCents(j), summary: runSummary(j) },
      });
    }
  }
  // Prompt checks and chat answers: what Pilot decided and why, never the prompt text or quotes.
  const only = o.repo ? repos[0].name : null;
  const wr = h.reg
    .prepare(`SELECT * FROM watch_runs${only ? " WHERE repo = ?" : ""} ORDER BY id DESC LIMIT ?`)
    .all(...(only ? [only, limit] : [limit])) as Array<{ id: number; kind: string; repo: string | null; created_ms: number; finished_ms: number | null; status: string; summary: string | null; cost_cents: number | null }>;
  for (const r of wr) {
    const startedAt = iso(Number(r.created_ms)) ?? "";
    runs.push({
      at: startedAt,
      id: Number(r.id),
      json: { repo: r.repo ?? "", id: Number(r.id), kind: r.kind === "ask" ? "chat-answer" : "prompt-check", status: r.status, trigger: r.kind === "ask" ? "question" : "prompt", startedAt, finishedAt: iso(r.finished_ms), costCents: r.cost_cents === null ? null : Number(r.cost_cents), summary: r.summary ?? "" },
    });
  }
  events.sort((a, b) => b.ms - a.ms);
  runs.sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
  return { events: events.slice(0, limit).map((e) => e.json), runs: runs.slice(0, limit).map((r) => r.json) };
}

/** Agent Engine findings stored by the daemon's poll, newest report first, with the local repositories they map to. */
async function production(h: Home, o: { limit?: string }): Promise<Json> {
  const limit = o.limit === undefined ? 50 : Number(o.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error(`--limit must be an integer from 1 to 1000, got "${o.limit}"`);
  const eng = await import("./engine.ts");
  const { RepoMapper } = await import("./engineSpeech.ts");
  const s = eng.engineSummary(h.reg);
  const mapper = new RepoMapper(h.reg);
  const list = (v: string) => parseJson<unknown>(v, []);
  const strings = (v: string) => {
    const a = list(v);
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  };
  return {
    connected: s.connected,
    lastPollAt: s.lastPollAt,
    lastError: s.lastError,
    findings: eng.listEngineFindings(h.reg, limit).map((f) => ({
      id: f.id,
      at: f.at,
      level: f.level,
      title: f.title,
      summary: f.summary,
      services: strings(f.services),
      repos: strings(f.repos),
      localRepos: mapper.localRepos(f),
      url: f.url ?? null,
      status: f.status,
      toldSessions: eng.toldCount(h.reg, f.id),
    })),
  };
}

async function chatApi(h: Home, o: { since?: string; limit?: string }): Promise<Json> {
  const { apiMessage, listMessages, unreadCount } = await import("./chat.ts");
  let since: number | undefined;
  if (o.since !== undefined) {
    since = Number(o.since);
    if (!Number.isInteger(since) || since < 0) throw new Error(`--since must be a message id (an integer >= 0), got "${o.since}"`);
  }
  const limit = o.limit === undefined ? (since === undefined ? 50 : 200) : Number(o.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error(`--limit must be an integer from 1 to 1000, got "${o.limit}"`);
  return { messages: listMessages(h.reg, { since, limit }).map(apiMessage), unread: unreadCount(h.reg) };
}

/** Waits for the answer (ask_timeout_sec, 60 s). SIGTERM/SIGINT cancel it: the model run is stopped, a note says so. */
const engineFlag = async (v: string | undefined) => {
  if (v === undefined) return undefined;
  const { THINK_ENGINES } = await import("./config.ts");
  if (!THINK_ENGINES.includes(v as never)) throw new Error(`--engine must be claude or codex, got "${v}"`);
  return v as import("./config.ts").ThinkEngine;
};

/** The default engine (written to config.json with --engine) and whether each one can run now. */
async function settingsApi(h: Home, o: { engine?: string }): Promise<Json> {
  const engine = await engineFlag(o.engine);
  const { loadConfig } = await import("./config.ts");
  if (engine) {
    const file = path.join(h.home.pilotHome(), "config.json");
    const conf = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : {};
    conf.engine = engine;
    fs.writeFileSync(file, `${JSON.stringify(conf, null, 2)}\n`, { mode: 0o600 });
  }
  const cfg = loadConfig(h.home.pilotHome(), { cheap: true });
  if (engine && cfg.engine !== engine) throw new Error(`saved, but the PILOT_ENGINE environment variable keeps the engine at ${cfg.engine}`);
  const { engineStates } = await import("./engines.ts");
  return { engine: cfg.engine, engines: engineStates(h.reg, cfg) };
}

async function askApi(h: Home, o: { text?: string; engine?: string }): Promise<Json> {
  if (o.text === undefined) throw new Error("--text is required");
  const engine = await engineFlag(o.engine);
  const { apiMessage } = await import("./chat.ts");
  const { askPilot } = await import("./promptWatch.ts");
  const { killGroup } = await import("./oneshot.ts");
  const { loadConfig } = await import("./config.ts");
  let child: import("node:child_process").ChildProcess | null = null;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    killGroup(child);
  };
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  try {
    const r = await askPilot(h.reg, loadConfig(h.home.pilotHome(), { cheap: true }), o.text, { onSpawn: (c) => (child = c), shouldStop: () => cancelled, engine });
    return { question: apiMessage(r.question), answer: apiMessage(r.answer) };
  } finally {
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
  }
}

async function nudgeApi(h: Home, o: { id?: string; all?: boolean; action?: string }): Promise<Json> {
  const { NUDGE_ACTIONS, actOnNudge, apiMessage, markAllSeen } = await import("./chat.ts");
  if (!o.action) throw new Error(`--action is required (${NUDGE_ACTIONS.join("|")})`);
  if (o.all) {
    if (o.id !== undefined) throw new Error("use --id <id> or --all, not both");
    if (o.action !== "seen") throw new Error(`--all only takes --action seen, got "${o.action}"`);
    return { ok: true, message: null, updated: markAllSeen(h.reg, Date.now()) };
  }
  if (o.id === undefined) throw new Error("--id <id> or --all is required");
  const id = Number(o.id);
  if (!Number.isInteger(id) || id < 1) throw new Error(`--id must be a message id, got "${o.id}"`);
  const action = o.action as (typeof NUDGE_ACTIONS)[number];
  if (!NUDGE_ACTIONS.includes(action)) throw new Error(`--action must be one of ${NUDGE_ACTIONS.join("|")}, got "${o.action}"`);
  return { ok: true, message: apiMessage(actOnNudge(h.reg, id, action, Date.now())) };
}

async function decideApi(h: Home, o: { ref?: string; action?: string; note?: string; until?: string }): Promise<Json> {
  if (!o.ref) throw new Error("--ref <repo#id> is required");
  if (!o.action) throw new Error(`--action is required (${DECISIONS.join("|")})`);
  const action = o.action as Decision;
  if (!DECISIONS.includes(action)) throw new Error(`--action must be one of ${DECISIONS.join("|")}, got "${o.action}"`);
  const note = (o.note ?? "").trim();
  if (action !== "reopen" && !note) throw new Error(`--note is required for ${action}: it is shown to the reviewer on later runs`);
  if (o.until !== undefined && Number.isNaN(Date.parse(o.until))) throw new Error(`--until must be an ISO date, got "${o.until}"`);
  const m = o.ref.match(/^(.+)#(\d+)$/);
  if (!m) throw new Error(`--ref must look like <repo>#<id>, got "${o.ref}"`);
  const repo = resolveRepo(h, m[1]);
  const db = repoDb(h, repo);
  const id = Number(m[2]);
  if (!db.prepare("SELECT id FROM findings WHERE id = ?").get(id)) throw new Error(`no finding ${o.ref}`);
  const { decide } = await import("./findings.ts");
  const row = decide(db, repo.root, id, action, note, o.until);
  return { ok: true, finding: apiFinding(row, repo, refsFor(h.home.listRepos(h.reg)).get(repo.key) ?? repo.name) };
}

function pause(h: Home, paused: boolean, o: { repo?: string }): Json {
  if (o.repo) {
    const repo = resolveRepo(h, o.repo);
    h.db.kvSet(repoDb(h, repo), "paused", paused);
    return { ok: true, paused, scope: repo.name };
  }
  h.home.kvSetReg(h.reg, "paused", paused);
  return { ok: true, paused, scope: "all" };
}

function parse(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true });
  } catch (err) {
    throw new Error(`bad flags: ${errMessage(err)}`);
  }
}

async function dispatch(argv: string[]): Promise<Json> {
  const { values, positionals } = parse(argv);
  const method = positionals[0];
  if (!method) throw new Error(`usage: pilot api <${Object.keys(METHODS).join("|")}> [flags]`);
  const allowed = METHODS[method];
  if (!allowed) throw new Error(`unknown method "${method}" (expected ${Object.keys(METHODS).join("|")})`);
  if (positionals.length > 1) throw new Error(`unexpected argument "${positionals[1]}" for ${method}`);
  for (const k of Object.keys(values)) {
    if (!allowed.includes(k as keyof typeof OPTIONS)) throw new Error(`bad flags: ${method} does not take --${k}`);
  }
  const { loadEnv } = await import("./config.ts");
  loadEnv();
  const h = await openHome();
  switch (method) {
    case "status":
      return status(h);
    case "chat":
      return chatApi(h, values);
    case "ask":
      return askApi(h, values);
    case "settings":
      return settingsApi(h, values);
    case "nudge":
      return nudgeApi(h, values);
    case "findings":
      return findings(h, values);
    case "activity":
      return activity(h, values);
    case "production":
      return production(h, values);
    case "decide":
      return decideApi(h, values);
    case "pause":
    case "resume":
      return pause(h, method === "pause", values);
  }
  throw new Error(`unknown method "${method}"`);
}

/** Runs one API call and writes its single JSON object to stdout. Returns the exit code. */
export async function runApi(argv: string[]): Promise<number> {
  const write = (body: Json) => process.stdout.write(`${JSON.stringify({ api: API_VERSION, ...body })}\n`);
  // stdout belongs to the JSON object: route stray console output from any module to stderr.
  const toStderr = (...a: unknown[]) => void process.stderr.write(`${format(...a)}\n`);
  console.log = console.info = console.debug = toStderr;
  try {
    write(await dispatch(argv));
    return 0;
  } catch (err) {
    write({ error: errMessage(err) || "unknown error" });
    return 1;
  }
}

