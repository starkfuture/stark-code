import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import {
  connectEngine,
  disconnectEngine,
  enginePollDue,
  getConn,
  getPoll,
  listEngineFindings,
  macKeychain,
  normalizeEngineUrl,
  pollEngine,
  upsertFindings,
  type EngineFinding,
  type FetchFn,
  type Keychain,
} from "../src/engine.ts";
import { claimEngine, engineDue, formatEngineMessage, remoteSlug } from "../src/engineSpeech.ts";
import { kvSetReg, openRegistry, registerRepo, repoKey, repoStateDir } from "../src/home.ts";
import { daemon } from "../src/watcher.ts";
import { tempRepo, testConfig } from "./helpers.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URL_ = "https://agent-engine.example.test";
// Obviously fake, but shaped like a real key so every check runs. It must never appear in any output, log or file.
const SECRET = "TESTONLYcanaryKEYvalue0123456789abcdefghijk";
const KEY = `ae_0a1b2c3d4e5f_${SECRET}`;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

class FakeKeychain implements Keychain {
  items = new Map<string, string>();
  reads = 0;
  get(a: string) {
    this.reads++;
    return this.items.get(a) ?? null;
  }
  set(a: string, s: string) {
    this.items.set(a, s);
  }
  delete(a: string) {
    return this.items.delete(a);
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type Wire = Record<string, unknown> & { id: string };
const wire = (id: string, over: Partial<EngineFinding> = {}): Wire => ({
  id,
  level: "major",
  status: "open",
  title: "Checkout API returns 502 for card payments",
  summary: "Upstream payments gateway times out after the 14:00 deploy",
  services: ["orders-api"],
  repos: [],
  runId: "run-41",
  url: "https://stark.slack.com/archives/C0TEST/p1700000000",
  ack: null,
  at: iso(Date.now() - 10 * MIN),
  openedAt: iso(Date.now() - 20 * MIN),
  resolvedAt: null,
  ...over,
});

/**
 * A fake engine that follows the feed contract: every issue changed after the cursor, once per page, current state,
 * ordered by its first change; `next` never skips a change; `since` only on the first call.
 */
class FakeEngine {
  key = KEY;
  pageSize = 200;
  state = new Map<string, Wire>();
  changes: Array<{ seq: number; ts: number; id: string }> = [];
  requests: Array<{ url: URL; headers: Record<string, string>; method: string }> = [];
  overrides: Array<(u: URL, headers: Record<string, string>) => Response | Promise<Response>> = [];

  change(f: Wire, ts = Date.now()): void {
    this.state.set(f.id, { ...(this.state.get(f.id) ?? {}), ...f });
    this.changes.push({ seq: this.changes.length + 1, ts, id: f.id });
  }

  fetch: FetchFn = async (url, init) => {
    const u = new URL(url);
    this.requests.push({ url: u, headers: init.headers, method: init.method });
    const o = this.overrides.shift();
    if (o) return o(u, init.headers);
    if (init.headers.authorization !== `Bearer ${this.key}`)
      return json(401, { error: "invalid or revoked key" }, { "www-authenticate": 'Bearer realm="agent-engine-api", error="invalid_token"' });
    const cursor = u.searchParams.get("cursor");
    const since = u.searchParams.get("since");
    if (cursor && since) return json(400, { error: "since together with cursor" });
    let after = 0;
    if (cursor) {
      if (!/^c\d+$/.test(cursor)) return json(400, { error: "unknown cursor" });
      after = Number(cursor.slice(1));
    } else if (since) after = Math.max(0, ...this.changes.filter((c) => c.ts <= Date.parse(since)).map((c) => c.seq));
    const limit = Math.min(Number(u.searchParams.get("limit") ?? 50), this.pageSize);
    const first = new Map<string, number>();
    for (const c of this.changes) if (c.seq > after && !first.has(c.id)) first.set(c.id, c.seq);
    const ids = [...first.keys()];
    const page = ids.slice(0, limit);
    const more = ids.length > limit;
    const next = more ? first.get(page[page.length - 1])! : Math.max(after, this.changes.length);
    return json(200, { findings: page.map((id) => this.state.get(id)), next: `c${next}`, more });
  };
}

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lookout-engine-home-"));
  process.env.PILOT_HOME = home;
  delete process.env.PILOT_ENGINE_REPOS;
  return home;
}

function repoWithRemote(remote: string): { root: string; key: string; name: string } {
  const root = tempRepo({ "src/index.js": "export const x = 1;\n" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: root });
  registerRepo(openRegistry(), root, null, Date.now());
  testConfig(root);
  return { root, key: repoKey(root), name: path.basename(root) };
}

const edited = (session: string, key: string, atMs: number) =>
  openRegistry().prepare("INSERT INTO session_repos(session, repo_key, first_ms, last_ms) VALUES (?, ?, ?, ?) ON CONFLICT(session, repo_key) DO UPDATE SET last_ms = excluded.last_ms").run(session, key, atMs, atMs);

const asFinding = (w: Wire): EngineFinding => w as unknown as EngineFinding;
const CFG = { speakSpacingMin: 30, speakMaxFindings: 2 };

function cli(args: string[], env: Record<string, string> = {}, stdin = ""): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(path.join(ROOT, "scripts", "pilot"), args, { env: { ...process.env, PILOT_AUTOSTART: "0", ...env } });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code, stdout, stderr }));
    c.stdin.end(stdin);
  });
}

async function connected(engine = new FakeEngine(), kc = new FakeKeychain()) {
  await connectEngine({ reg: openRegistry(), url: URL_, secret: KEY, keychain: kc, fetch: engine.fetch });
  return { engine, kc, reg: openRegistry() };
}

test("connect checks the key and keeps it only in the Keychain; bad keys and plain http are refused; disconnect removes it", async () => {
  freshHome();
  const reg = openRegistry();
  const engine = new FakeEngine();
  const kc = new FakeKeychain();

  await assert.rejects(connectEngine({ reg, url: URL_, secret: `not-a-key-${SECRET}`, keychain: kc, fetch: engine.fetch }), (e: Error) => {
    assert.match(e.message, /not an Agent Engine key/);
    assert.ok(!e.message.includes(SECRET), "the rejected input is never echoed");
    return true;
  });
  assert.throws(() => normalizeEngineUrl("http://agent-engine.example.test"), /https/);
  assert.equal(normalizeEngineUrl("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
  assert.equal(normalizeEngineUrl(`${URL_}/`), URL_);

  engine.key = "ae_ffffffffffff_someOtherKeyThatTheEngineAcceptsxxxxxxxxxxxxx";
  await assert.rejects(connectEngine({ reg, url: URL_, secret: KEY, keychain: kc, fetch: engine.fetch }), /rejected the key \(401.*Nothing was stored/);
  assert.equal(kc.items.size, 0);
  assert.equal(getConn(reg), null);

  engine.key = KEY;
  await connectEngine({ reg, url: `${URL_}/`, secret: `  ${KEY}\n`, keychain: kc, fetch: engine.fetch });
  assert.deepEqual([...kc.items], [[URL_, KEY]], "service lookout-agent-engine, account = the engine URL");
  assert.equal(getConn(reg)?.state, "connected");
  assert.equal(enginePollDue(reg), true, "the daemon polls right after connecting");
  const verify = engine.requests[engine.requests.length - 1];
  assert.equal(verify.method, "GET");
  assert.equal(verify.url.pathname, "/api/v1/findings");
  assert.equal(verify.headers.authorization, `Bearer ${KEY}`);
  assert.ok(!Object.keys(verify.headers).some((h) => h.toLowerCase() === "origin"), "no browser Origin header");

  const d = disconnectEngine({ reg, keychain: kc });
  assert.deepEqual(d, { url: URL_, removed: true, error: null });
  assert.equal(kc.items.size, 0);
  assert.equal(getConn(reg), null);
  assert.equal(enginePollDue(reg), false);
});

test("poll follows next/more, keeps one row per issue with its current state, resumes from the cursor, never replays more than 48 h", async () => {
  freshHome();
  const engine = new FakeEngine();
  engine.pageSize = 2;
  const now = Date.now();
  engine.change(wire("I-old1", { at: iso(now - 72 * 60 * MIN) }), now - 72 * 60 * MIN);
  engine.change(wire("I-a001"), now - 30 * MIN);
  engine.change(wire("I-b002", { level: "critical", title: "Payments double-charged on retry" }), now - 25 * MIN);
  engine.change(wire("I-c003"), now - 20 * MIN);
  engine.change(wire("I-a001", { status: "resolved", resolvedAt: iso(now - 5 * MIN) }), now - 5 * MIN);
  const { reg, kc } = await connected(engine);
  engine.requests = [];

  const r = await pollEngine({ reg, keychain: kc, fetch: engine.fetch });
  assert.equal(r.error, null);
  assert.ok(r.pages >= 2, `several pages (${r.pages})`);
  const since = Date.parse(engine.requests[0].url.searchParams.get("since") ?? "");
  assert.ok(Math.abs(since - (now - 48 * 60 * MIN)) < MIN, "the first call starts 48 h back");
  assert.equal(engine.requests[0].url.searchParams.get("min_level"), "major");
  assert.equal(engine.requests[0].url.searchParams.get("status"), "all");
  assert.ok(engine.requests.slice(1).every((q) => q.url.searchParams.has("cursor") && !q.url.searchParams.has("since")), "later pages use the cursor only");
  const rows = new Map(listEngineFindings(reg).map((f) => [f.id, f]));
  assert.deepEqual([...rows.keys()].sort(), ["I-a001", "I-b002", "I-c003"], "deduped by id; nothing older than 48 h");
  assert.equal(rows.get("I-a001")?.status, "resolved", "the current state wins");
  assert.equal(rows.get("I-b002")?.level, "critical");
  assert.ok(getPoll(reg)?.lastPollAt);
  assert.equal(enginePollDue(reg), false, "the next poll waits engine_poll_min");

  engine.change(wire("I-b002", { level: "critical", title: "Payments double-charged on retry", ack: "on_it" }));
  engine.requests = [];
  await pollEngine({ reg, keychain: kc, fetch: engine.fetch });
  assert.equal(engine.requests.length, 1);
  assert.ok(engine.requests[0].url.searchParams.has("cursor"), "a later poll resumes from the saved cursor");
  assert.equal(listEngineFindings(reg).length, 3);
  assert.equal(listEngineFindings(reg).find((f) => f.id === "I-b002")?.ack, "on_it");

  // A refused cursor (the engine lost it) restarts from 48 h ago; a poll more than 48 h after the last one does too.
  kvSetReg(reg, "engine_poll", { ...getPoll(reg)!, cursor: "zz-unknown", nextPollMs: 0 });
  engine.requests = [];
  assert.equal((await pollEngine({ reg, keychain: kc, fetch: engine.fetch })).error, null);
  assert.ok(engine.requests[0].url.searchParams.has("cursor") && engine.requests[1].url.searchParams.has("since"));
  kvSetReg(reg, "engine_poll", { ...getPoll(reg)!, lastPollAt: iso(now - 49 * 60 * MIN), nextPollMs: 0 });
  engine.requests = [];
  await pollEngine({ reg, keychain: kc, fetch: engine.fetch });
  assert.ok(engine.requests[0].url.searchParams.has("since"), "never replays from a cursor older than 48 h");

  // Malformed items are skipped, never guessed; a minor level is not a finding.
  engine.overrides.push(() => json(200, { findings: [wire("I-d004"), { ...wire("I-e005"), level: "minor" }, { id: "nope" }], next: "c99", more: false }));
  const m = await pollEngine({ reg, keychain: kc, fetch: engine.fetch });
  assert.equal(m.skipped, 2);
  assert.ok(listEngineFindings(reg).some((f) => f.id === "I-d004"));
  assert.ok(!listEngineFindings(reg).some((f) => f.id === "I-e005"));
});

test("mapping: repos[] against the git remotes of watched repositories, engine_repos for services", async () => {
  freshHome();
  assert.equal(remoteSlug("git@github.com:starkfuture/orders-service.git"), "starkfuture/orders-service");
  assert.equal(remoteSlug("https://github.com/StarkFuture/Payments.git/"), "starkfuture/payments");
  assert.equal(remoteSlug("ssh://git@github.com/starkfuture/web.git"), "starkfuture/web");
  assert.equal(remoteSlug("/local/path/repo"), null);
  const orders = repoWithRemote("git@github.com:starkfuture/orders-service.git");
  const pay = repoWithRemote("https://github.com/StarkFuture/payments.git");
  const reg = openRegistry();
  upsertFindings(reg, [asFinding(wire("I-r001", { repos: ["starkfuture/orders-service"], services: ["orders-api"] })), asFinding(wire("I-s002", { services: ["payments-api"] }))]);

  const r = await cli(["api", "production"]);
  const by = new Map(JSON.parse(r.stdout).findings.map((f: any) => [f.id, f]));
  assert.deepEqual((by.get("I-r001") as any).localRepos, [orders.root], "repos[] matched against the git remote");
  assert.deepEqual((by.get("I-s002") as any).localRepos, [], "no map, no repos[]: listed without a local repository");

  fs.writeFileSync(path.join(process.env.PILOT_HOME!, "config.json"), JSON.stringify({ engine_repos: { "Payments-API": path.join(pay.root, "src") } }));
  const r2 = await cli(["api", "production"]);
  const by2 = new Map(JSON.parse(r2.stdout).findings.map((f: any) => [f.id, f]));
  assert.deepEqual((by2.get("I-s002") as any).localRepos, [pay.root], "engine_repos maps a service to a path inside a repository");
});

test("routing: said only to a session that changed the repository in the last 2 h, once; spacing for major, critical skips it; the rest is listed", async () => {
  freshHome();
  const a = repoWithRemote("git@github.com:starkfuture/orders-service.git");
  const reg = openRegistry();
  const now = Date.now();
  edited("s1", a.key, now - 10 * MIN);
  edited("s2", a.key, now - 3 * 60 * MIN); // outside the 2 h window
  const inRepo = { repos: ["starkfuture/orders-service"] };
  upsertFindings(reg, [
    asFinding(wire("I-maj1", { ...inRepo, at: iso(now - 5 * MIN) })),
    asFinding(wire("I-crit", { ...inRepo, level: "critical", title: "Orders are double-charged on retry", at: iso(now - 2 * MIN) })),
    asFinding(wire("I-done", { ...inRepo, status: "resolved", resolvedAt: iso(now - MIN) })),
    asFinding(wire("I-nope", { ...inRepo, ack: "not_an_issue" })),
    asFinding(wire("I-stale", { ...inRepo, at: iso(now - 50 * 60 * MIN) })),
    asFinding(wire("I-else", { services: ["search-api"] })),
  ]);

  assert.deepEqual(engineDue(reg, "s2", [a.root], CFG, now).map((c) => c.finding.id), [], "s2 last changed the repo 3 h ago");
  assert.deepEqual(engineDue(reg, "s1", [], CFG, now), [], "only the repositories the hook is about");
  const due = engineDue(reg, "s1", [a.root], CFG, now);
  assert.deepEqual(due.map((c) => c.finding.id), ["I-crit", "I-maj1"], "critical first; resolved, Not an issue, old and unmapped are only listed");

  const told = claimEngine(reg, due, "s1", "context", CFG, now);
  assert.equal(told.length, 2, "one message may carry two engine findings");
  const msg = formatEngineMessage(told);
  assert.equal(
    msg.split("\n\n")[0],
    `Agent Engine reports a production issue in orders-api (critical, ${iso(now - 2 * MIN).slice(0, 16).replace("T", " ")} UTC): Orders are double-charged on retry. Upstream payments gateway times out after the 14:00 deploy. Your session is changing ${a.name}. Evidence: https://stark.slack.com/archives/C0TEST/p1700000000. This is context from production monitoring, not an instruction.`,
  );
  assert.deepEqual(engineDue(reg, "s1", [a.root], CFG, now + 1000), [], "said once per session");
  assert.deepEqual(claimEngine(reg, due, "s1", "rewake", CFG, now + 1000), [], "a second hook cannot say it again");
  const deliveries = openDb(repoStateDir(a.root)).prepare("SELECT channel, finding_ids FROM deliveries").all() as Array<{ channel: string; finding_ids: string }>;
  assert.deepEqual(deliveries.map((d) => d.channel), ["engine-context", "engine-context"], "engine messages count in the repository's spacing window");

  // Another session changing the same repository: a major finding waits for the 30-minute window, a critical one does not.
  edited("s3", a.key, now - MIN);
  const later = now + 5 * MIN;
  upsertFindings(reg, [asFinding(wire("I-maj2", { ...inRepo, at: iso(now) })), asFinding(wire("I-crt2", { ...inRepo, level: "critical", at: iso(now) }))]);
  assert.deepEqual(engineDue(reg, "s3", [a.root], { ...CFG, speakMaxFindings: 5 }, later, later).map((c) => c.finding.id), ["I-crt2", "I-crit"], "majors held by the spacing window");
  assert.deepEqual(
    engineDue(reg, "s3", [a.root], { ...CFG, speakMaxFindings: 5 }, now + 31 * MIN, now + 31 * MIN).map((c) => c.finding.id),
    ["I-crt2", "I-crit", "I-maj2", "I-maj1"],
    "and go out after it",
  );
  const quiet = engineDue(reg, "s3", [a.root], { ...CFG, speakMaxFindings: 5 }, later, later).map((c) => c.finding.id);
  for (const id of ["I-done", "I-nope", "I-stale", "I-else"]) assert.ok(!quiet.includes(id));
});

test("the next prompt carries the engine message; it is said once; delivery=inbox keeps it quiet; a Stop waits for the turn, then wakes", async () => {
  freshHome();
  const a = repoWithRemote("git@github.com:starkfuture/orders-service.git");
  const reg = openRegistry();
  edited("s1", a.key, Date.now() - 5 * MIN);
  edited("s2", a.key, Date.now() - 5 * MIN);
  upsertFindings(reg, [asFinding(wire("I-crit", { repos: ["starkfuture/orders-service"], level: "critical", title: "Orders are double-charged on retry" }))]);
  const hook = (session: string) => JSON.stringify({ session_id: session, cwd: a.root, hook_event_name: "UserPromptSubmit" });

  const quiet = await cli(["deliver", "--context"], { PILOT_DELIVERY: "inbox" }, hook("s1"));
  assert.equal(quiet.stdout.trim(), "", "delivery=inbox never speaks");
  const first = await cli(["deliver", "--context"], {}, hook("s1"));
  assert.equal(first.code, 0);
  assert.match(first.stdout, /^Agent Engine reports a production issue in orders-api \(critical, .* UTC\): Orders are double-charged on retry\..* This is context from production monitoring, not an instruction\.$/m);
  assert.equal((await cli(["deliver", "--context"], {}, hook("s1"))).stdout.trim(), "", "said once");

  const env = { PILOT_QUIET_MS: "100", PILOT_PROMPT_QUIET_MS: "100", PILOT_DELIVER_WAIT_SEC: "20" };
  const woke = await cli(["deliver", "--rewake"], env, JSON.stringify({ session_id: "s2", cwd: a.root, hook_event_name: "Stop" }));
  assert.equal(woke.code, 2, woke.stderr);
  assert.match(woke.stderr, /Agent Engine reports a production issue in orders-api/);
  const r = await cli(["api", "production"]);
  assert.equal(JSON.parse(r.stdout).findings[0].toldSessions, 2);
});

test("401 marks the engine disconnected with a clear error and stops polling; 403 scope too; 429/503 retry later", async () => {
  freshHome();
  const { engine, kc, reg } = await connected();
  engine.overrides.push(() => json(429, { error: "slow down" }, { "retry-after": "90" }));
  const t0 = Date.now();
  const limited = await pollEngine({ reg, keychain: kc, fetch: engine.fetch });
  assert.match(limited.error ?? "", /rate limited \(429\)/);
  assert.equal(getConn(reg)?.state, "connected");
  assert.ok(getPoll(reg)!.nextPollMs >= t0 + 5 * MIN, "at least the poll interval");

  engine.overrides.push(() => json(503, { error: "database unavailable" }, { "retry-after": "30" }));
  kvSetReg(reg, "engine_poll", { ...getPoll(reg)!, nextPollMs: 0 });
  assert.match((await pollEngine({ reg, keychain: kc, fetch: engine.fetch })).error ?? "", /503/);
  assert.equal(getConn(reg)?.state, "connected");

  engine.key = "ae_ffffffffffff_revokedRevokedRevokedRevokedRevokedRevoked1";
  kvSetReg(reg, "engine_poll", { ...getPoll(reg)!, nextPollMs: 0 });
  const r = await pollEngine({ reg, keychain: kc, fetch: engine.fetch });
  assert.equal(r.disconnected, true);
  assert.match(r.error ?? "", /rejected the key \(401.*pilot engine connect/);
  assert.equal(getConn(reg)?.state, "disconnected");
  assert.equal(enginePollDue(reg, Date.now() + 24 * 60 * MIN), false, "no more polls until connect");
  const before = engine.requests.length;
  await pollEngine({ reg, keychain: kc, fetch: engine.fetch });
  assert.equal(engine.requests.length, before, "a disconnected engine is not called");
  const api = JSON.parse((await cli(["api", "production"])).stdout);
  assert.equal(api.connected, false);
  assert.match(api.lastError, /rejected the key/);
  assert.match((await cli(["status"])).stdout, /engine\s+disconnected: the Agent Engine rejected the key/);

  freshHome();
  const s = await connected();
  s.engine.overrides.push(() => json(403, { error: "insufficient scope" }, { "www-authenticate": 'Bearer realm="agent-engine-api", error="insufficient_scope", scope="findings:read"' }));
  const f = await pollEngine({ reg: s.reg, keychain: s.kc, fetch: s.engine.fetch });
  assert.equal(f.disconnected, true);
  assert.match(f.error ?? "", /findings:read/);

  freshHome();
  const gone = await connected();
  gone.kc.items.clear();
  const g = await pollEngine({ reg: gone.reg, keychain: gone.kc, fetch: gone.engine.fetch });
  assert.equal(g.disconnected, true);
  assert.match(g.error ?? "", /no key .* in the macOS Keychain/);
});

test("the daemon polls while it runs and connected; never touches the Keychain when not connected", async () => {
  freshHome();
  const engine = new FakeEngine();
  engine.change(wire("I-dmn1", { level: "critical" }));
  const kc = new FakeKeychain();
  const noInvestigator = async () => {
    throw new Error("no repositories in this test");
  };
  const logs: string[] = [];
  await daemon({ log: (m) => logs.push(m), untilIdle: true, makeInvestigator: noInvestigator, engine: { keychain: kc, fetch: engine.fetch } });
  assert.equal(kc.reads, 0, "not connected: no Keychain access, no request");
  assert.equal(engine.requests.length, 0);

  await connectEngine({ reg: openRegistry(), url: URL_, secret: KEY, keychain: kc, fetch: engine.fetch });
  await daemon({ log: (m) => logs.push(m), untilIdle: true, makeInvestigator: noInvestigator, engine: { keychain: kc, fetch: engine.fetch } });
  assert.deepEqual(listEngineFindings(openRegistry()).map((f) => f.id), ["I-dmn1"]);
  assert.ok(logs.some((l) => /Agent Engine: 1 finding\(s\) changed \(1 new\)/.test(l)), logs.join("\n"));
});

test("api production: documented shape and --limit; status counts engine findings", async () => {
  freshHome();
  const a = repoWithRemote("git@github.com:starkfuture/orders-service.git");
  const { engine, kc, reg } = await connected();
  engine.change(wire("I-api1", { repos: ["starkfuture/orders-service"], level: "critical", at: iso(Date.now() - 2 * MIN) }));
  engine.change(wire("I-api2", { status: "resolved", resolvedAt: iso(Date.now() - MIN), url: null as never, at: iso(Date.now() - 9 * MIN) }));
  await pollEngine({ reg, keychain: kc, fetch: engine.fetch });

  const r = await cli(["api", "production"]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.stdout.trim().split("\n").length, 1);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j).sort(), ["api", "connected", "findings", "lastError", "lastPollAt"]);
  assert.equal(j.api, 1);
  assert.equal(j.connected, true);
  assert.equal(j.lastError, null);
  assert.ok(!Number.isNaN(Date.parse(j.lastPollAt)));
  assert.deepEqual(j.findings.map((f: any) => f.id), ["I-api1", "I-api2"], "newest report first");
  for (const f of j.findings)
    assert.deepEqual(Object.keys(f).sort(), ["at", "id", "level", "localRepos", "repos", "services", "status", "summary", "title", "toldSessions", "url"].sort());
  assert.deepEqual(j.findings[0].localRepos, [a.root]);
  assert.equal(j.findings[0].toldSessions, 0);
  assert.equal(j.findings[1].url, null);
  assert.equal(j.findings[1].status, "resolved");
  assert.equal(JSON.parse((await cli(["api", "production", "--limit", "1"])).stdout).findings.length, 1);
  const bad = await cli(["api", "production", "--limit", "0"]);
  assert.equal(bad.code, 1);
  assert.match(JSON.parse(bad.stdout).error, /--limit/);
  assert.match(JSON.parse((await cli(["api", "production", "--repo", "x"])).stdout).error, /does not take --repo/);

  const st = await cli(["status"]);
  assert.match(st.stdout, /engine\s+connected to https:\/\/agent-engine\.example\.test · 2 finding\(s\), 1 open \(1 critical, 0 major\)/);
});

test("the key never appears in any output, log, error or file Lookout writes", async () => {
  const home = freshHome();
  const a = repoWithRemote("git@github.com:starkfuture/orders-service.git");
  const engine = new FakeEngine();
  engine.change(wire("I-key1", { repos: ["starkfuture/orders-service"], level: "critical" }));
  const kc = new FakeKeychain();
  const logs: string[] = [];
  const reg = openRegistry();
  const seen: string[] = [];
  await assert.rejects(connectEngine({ reg, url: URL_, secret: `${KEY}x`, keychain: kc, fetch: engine.fetch }), (e: Error) => (seen.push(e.message), true));
  await connectEngine({ reg, url: URL_, secret: KEY, keychain: kc, fetch: engine.fetch });
  await daemon({ log: (m) => logs.push(m), untilIdle: true, makeInvestigator: async () => { throw new Error("none"); }, engine: { keychain: kc, fetch: engine.fetch } });
  // A transport error that quotes the request headers: scrubbed before it is stored or logged.
  engine.overrides.push((_u, h) => {
    throw new Error(`socket hang up while sending ${h.authorization}`);
  });
  kvSetReg(reg, "engine_poll", { ...getPoll(reg)!, nextPollMs: 0 });
  seen.push(String((await pollEngine({ reg, keychain: kc, fetch: engine.fetch, log: (m) => logs.push(m) })).error));
  assert.match(seen[seen.length - 1], /cannot reach .*ae_\[redacted\]/);
  edited("s1", a.key, Date.now() - MIN);
  for (const args of [["api", "production"], ["api", "status"], ["engine", "status"], ["status"], ["config"]]) {
    const r = await cli(args);
    seen.push(r.stdout, r.stderr);
  }
  const d = await cli(["deliver", "--context"], {}, JSON.stringify({ session_id: "s1", cwd: a.root }));
  assert.match(d.stdout, /Agent Engine reports/);
  seen.push(d.stdout, d.stderr, ...logs);
  for (const text of seen) assert.ok(!text.includes(SECRET), `key leaked into: ${text.slice(0, 300)}`);
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const f of files(home)) assert.ok(!fs.readFileSync(f).includes(SECRET), `key leaked into ${f}`);
  assert.ok(engine.requests.every((q) => q.headers.authorization === `Bearer ${KEY}`), "the engine itself receives the key");
});

test("a real HTTP round trip: the key goes only in the Authorization header and redirects are not followed", async (t) => {
  freshHome();
  const engine = new FakeEngine();
  engine.change(wire("I-net1"));
  const seenHeaders: http.IncomingHttpHeaders[] = [];
  const server = http.createServer(async (req, res) => {
    seenHeaders.push(req.headers);
    if (req.url?.includes("redirect-me")) {
      res.writeHead(302, { location: "https://elsewhere.example.test/steal" }).end();
      return;
    }
    const r = await engine.fetch(`http://x${req.url}`, { method: req.method ?? "GET", headers: { authorization: String(req.headers.authorization ?? "") }, redirect: "error", signal: AbortSignal.timeout(1000) });
    res.writeHead(r.status, Object.fromEntries(r.headers)).end(await r.text());
  });
  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => resolve(true));
  });
  if (!listening) {
    t.skip("local port binding is off here (sandbox); the injected-fetch tests cover the same paths");
    return;
  }
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const kc = new FakeKeychain();
    const reg = openRegistry();
    await connectEngine({ reg, url, secret: KEY, keychain: kc });
    const r = await pollEngine({ reg, keychain: kc });
    assert.equal(r.error, null);
    assert.deepEqual(listEngineFindings(reg).map((f) => f.id), ["I-net1"]);
    assert.ok(seenHeaders.every((h) => h.authorization === `Bearer ${KEY}` && !h.origin && !h.cookie));
    await assert.rejects(connectEngine({ reg, url: `${url}/redirect-me`, secret: KEY, keychain: kc }), /could not verify the key/);
  } finally {
    server.close();
  }
});

test("the macOS Keychain adapter passes the key to security on stdin, never on argv", () => {
  // A stand-in for /usr/bin/security that records its argv and stdin (fake key only, in a private temp folder).
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lookout-fake-security-"));
  const bin = path.join(dir, "security");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/argv.log"\ncase "$1" in\n  -i) cat >> "${dir}/stdin.log" ;;\n  find-generic-password) if [ -s "${dir}/stdin.log" ]; then echo "${KEY}"; else exit 44; fi ;;\n  delete-generic-password) : > "${dir}/stdin.log" ;;\nesac\n`,
    { mode: 0o755 },
  );
  const kc = macKeychain("lookout-agent-engine", bin);
  assert.equal(kc.get(URL_), null, "exit 44 = not found");
  kc.set(URL_, KEY);
  assert.equal(kc.get(URL_), KEY);
  assert.equal(kc.delete(URL_), true);
  const argv = fs.readFileSync(path.join(dir, "argv.log"), "utf8");
  const stdin = fs.readFileSync(path.join(dir, "stdin.log"), "utf8");
  assert.ok(!argv.includes(SECRET), "the key is never an argument");
  assert.match(argv, /^-i$/m);
  assert.match(argv, /^find-generic-password -s lookout-agent-engine -a https:\/\/agent-engine\.example\.test -w$/m);
  assert.equal(stdin, "", "deleted");
  assert.throws(() => kc.set(URL_, "not-a-key"), /not an Agent Engine key/);
  assert.throws(() => kc.get('https://x.test/"; rm -rf ~'), /characters/);
  fs.rmSync(dir, { recursive: true, force: true });
});
