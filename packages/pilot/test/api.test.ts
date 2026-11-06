import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { kvGet, openDb, updateJob, type DB } from "../src/db.ts";
import { applySpeech } from "../src/deliver.ts";
import { enqueueEvent, normalizeHook } from "../src/events.ts";
import { decide, ingestSubmission } from "../src/findings.ts";
import { kvGetReg, openRegistry, registerRepo, repoKey } from "../src/home.ts";
import type { SubmittedFinding } from "../src/investigator/types.ts";
import { enqueueJob } from "../src/scheduler.ts";
import { sha256 } from "../src/util.ts";
import { tempRepo, testConfig } from "./helpers.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = { "src/orders.js": "export function createOrder() {\n  return withRetry(() => post('/orders'));\n}\n", "src/log.js": "export const log = (m) => console.log(m);\n" };
const QUOTE = "return withRetry(() => post('/orders'));";

const STATUS_KEYS = ["api", "generatedAt", "daemon", "paused", "profiles", "home", "mode", "claudeBin", "delivery", "selftest", "budget", "unread", "sessions", "reviewWork", "engine", "repos"];
const REPO_KEYS = ["key", "name", "root", "lastEventAt", "paused", "excluded", "pendingEvents", "openFindings", "toldSession", "activeJob", "lastRun"];
const FINDING_KEYS = [
  "ref", "repo", "repoKey", "id", "title", "severity", "issueType", "attribution", "proof", "awareness", "riskAreas", "status", "statement", "failureCase",
  "whyItMatters", "nextAction", "handoffPrompt", "evidence", "speech", "deliveredAt", "revision", "createdAt", "updatedAt", "decisionNote",
];
const sorted = (o: object) => Object.keys(o).sort();

interface ApiResult {
  code: number | null;
  json: Record<string, any>;
  stdout: string;
}

/** Runs `pilot api ...` like an app would (no shell) and checks stdout is exactly one plain JSON object. */
function api(args: string[], env: Record<string, string> = {}): Promise<ApiResult> {
  return new Promise((resolve, reject) => {
    const c = spawn(path.join(ROOT, "scripts", "pilot"), ["api", ...args], { env: { ...process.env, PILOT_MODE: "offline", PILOT_AUTOSTART: "0", ...env } });
    let stdout = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.resume();
    c.on("error", reject);
    c.on("close", (code) => {
      try {
        assert.equal(stdout.trim().split("\n").length, 1, `one line of JSON on stdout, got: ${stdout}`);
        assert.doesNotMatch(stdout, /\x1b\[/, "no colour codes");
        const json = JSON.parse(stdout);
        assert.equal(json.api, 1);
        resolve({ code, json, stdout });
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Each test gets its own Pilot home (the CLI children inherit it). */
function freshHome(): string {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lookout-api-home-"));
  process.env.PILOT_HOME = home;
  return home;
}

function watchedRepo(): { root: string; name: string; db: DB; cfg: ReturnType<typeof testConfig> } {
  const root = tempRepo(FILES);
  registerRepo(openRegistry(), root, null, Date.now());
  const cfg = testConfig(root);
  return { root, name: path.basename(root), db: openDb(cfg.stateDir), cfg };
}

const finding = (over: Partial<SubmittedFinding>): SubmittedFinding => ({
  fingerprint: "retry-without-key",
  issue_type: "defect",
  severity: "critical",
  attribution: "introduced",
  proof: "source_proven",
  session_awareness: "unaware",
  risk_areas: ["money"],
  category: "omission",
  title: "Retried POST /orders can charge a customer twice",
  statement: "createOrder retries a non-idempotent POST.",
  failure_case: "The first POST commits but times out; the retry creates a second order.",
  controls_checked: "No Idempotency-Key, no server-side dedupe.",
  why_it_matters: "One order per checkout.",
  evidence: [{ type: "file", path: "src/orders.js", line_start: 2, quote: QUOTE }],
  confidence: 0.9,
  uncertainty: "u",
  suggested_next_action: "send an Idempotency-Key",
  handoff_prompt: "Add an Idempotency-Key to POST /orders.",
  related_paths: ["src/orders.js"],
  ...over,
});

function ingest(db: DB, findings: SubmittedFinding[], jobId = 1): void {
  ingestSubmission(db, { phase: "checkpoint", summary: "s", findings }, {
    jobId,
    revision: "r1",
    fileHashes: Object.fromEntries(Object.entries(FILES).map(([p, c]) => [p, sha256(c)])),
    runtime: "local-claude",
    readFile: (p: string) => (FILES as Record<string, string>)[p] ?? null,
    toolLog: [],
    toolLogTrusted: true,
    eventsText: "",
    originSession: () => "session-aaaaaaaa-1111",
  });
}

const idOf = (db: DB, fingerprint: string) => Number((db.prepare("SELECT id FROM findings WHERE fingerprint = ?").get(fingerprint) as { id: number }).id);

// Text that must never leave `api activity`: prompt text, agent messages, edit contents, commands, test output.
const CANARIES = ["PROMPT-CANARY-7f3e", "AGENT-CANARY-55cd", "CONTENT-CANARY-91ab", "COMMAND-CANARY-0c2d", "OUTPUT-CANARY-e4a8", "WRITE-CANARY-3b6f"];

function captureSession(db: DB, root: string, t0: number): void {
  const base = { session_id: "session-aaaaaaaa-1111", cwd: root };
  const evs: Array<Record<string, unknown>> = [
    { ...base, hook_event_name: "SessionStart", source: "startup" },
    { ...base, hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: `${CANARIES[0]} make createOrder retry` },
    { ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "e1", tool_input: { file_path: path.join(root, "src/orders.js"), old_string: "post", new_string: `${CANARIES[2]} withRetry` } },
    { ...base, hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "w1", agent_id: "sub-1", agent_type: "Explore", tool_input: { file_path: path.join(root, "src/log.js"), content: CANARIES[5] } },
    { ...base, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: `npm test -- ${CANARIES[3]}` }, tool_response: { stdout: `1 failed ${CANARIES[4]}` } },
    { ...base, hook_event_name: "Stop", prompt_id: "p1", last_assistant_message: `${CANARIES[1]} done, retries are safe` },
  ];
  evs.forEach((input, i) => {
    const ne = normalizeHook(input, root, t0 + i * 1000);
    assert.ok(ne, `event ${i} normalizes`);
    enqueueEvent(db, ne, "abc123", t0 + i * 1000);
  });
}

test("status: zero repositories, then two, with the documented shape", async () => {
  freshHome();
  const empty = await api(["status"]);
  assert.equal(empty.code, 0);
  assert.deepEqual(sorted(empty.json), [...STATUS_KEYS].sort());
  assert.deepEqual(empty.json.repos, []);
  assert.equal(empty.json.mode, "offline");
  assert.equal(empty.json.paused, false);
  assert.equal(empty.json.home, process.env.PILOT_HOME);
  assert.deepEqual(sorted(empty.json.daemon), ["heartbeatAt", "pid", "running"]);
  assert.equal(empty.json.daemon.running, false);
  assert.equal(empty.json.daemon.pid, null);
  assert.ok(["session", "inbox"].includes(empty.json.delivery));
  assert.deepEqual(sorted(empty.json.selftest), ["ok", "reason"]);
  assert.deepEqual(sorted(empty.json.budget), ["availableCents", "capCents", "spentCents", "windowHours"]);
  assert.equal(empty.json.budget.spentCents, 0);
  assert.equal(empty.json.budget.availableCents, empty.json.budget.capCents);
  assert.ok(Array.isArray(empty.json.profiles));
  assert.ok(!Number.isNaN(Date.parse(empty.json.generatedAt)));

  const a = watchedRepo();
  const b = watchedRepo();
  ingest(a.db, [finding({}), finding({ fingerprint: "log-drops-ids", severity: "medium", risk_areas: [], title: "Logger drops request identifiers", statement: "log ignores the id field", evidence: [{ type: "file", path: "src/log.js", quote: "export const log = (m) => console.log(m);" }], related_paths: ["src/log.js"] })]);
  a.db.prepare("UPDATE findings SET delivered_at = ?, delivered_session = 'session-aaaaaaaa-1111' WHERE fingerprint = 'retry-without-key'").run(new Date().toISOString());
  captureSession(a.db, a.root, Date.now() - 60_000);
  const done = enqueueJob(a.db, "checkpoint", "quick", "stop", {});
  const finishedAt = new Date(Date.now() - 3600_000).toISOString(); // inside the rolling 24 h budget window
  updateJob(a.db, done, { status: "done", started_at: new Date(Date.now() - 3660_000).toISOString(), finished_at: finishedAt, list_cost_cents: 12, prior_cost_cents: 3, summary: "checked the retry change" });
  const queued = enqueueJob(a.db, "checkpoint", "quick", "stop", {});
  enqueueJob(b.db, "manual", "quick", "manual", {});
  await api(["pause", "--repo", b.name]);

  const st = await api(["status"]);
  assert.equal(st.code, 0);
  assert.equal(st.json.repos.length, 2);
  for (const r of st.json.repos) assert.deepEqual(sorted(r), [...REPO_KEYS].sort());
  const ra = st.json.repos.find((r: any) => r.name === a.name);
  const rb = st.json.repos.find((r: any) => r.name === b.name);
  assert.equal(ra.key, repoKey(a.root));
  assert.equal(ra.root, a.root);
  assert.equal(ra.paused, false);
  assert.equal(ra.excluded, false);
  assert.equal(ra.openFindings, 2);
  assert.equal(ra.toldSession, 1);
  assert.equal(ra.pendingEvents, 6);
  assert.deepEqual(ra.activeJob, { id: queued, kind: "checkpoint", status: "queued", startedAt: null });
  assert.deepEqual(ra.lastRun, { id: done, kind: "checkpoint", status: "done", finishedAt, costCents: 15, summary: "checked the retry change" });
  assert.ok(!Number.isNaN(Date.parse(ra.lastEventAt)));
  assert.equal(rb.paused, true);
  assert.equal(rb.openFindings, 0);
  assert.equal(rb.lastRun, null);
  assert.equal(rb.activeJob.status, "queued");
  assert.equal(st.json.budget.spentCents, 15, "the budget counts every repository");
});

test("findings: documented shape, open/stale by default sorted by severity then newest, --all and --repo", async () => {
  freshHome();
  const a = watchedRepo();
  const b = watchedRepo();
  ingest(a.db, [
    finding({}),
    finding({ fingerprint: "stock-race", severity: "medium", risk_areas: [], title: "Inventory reservation races with checkout", statement: "two buyers reserve one unit" }),
    finding({ fingerprint: "invoice-rounding", severity: "medium", risk_areas: [], title: "Invoice totals round per line", statement: "cents drift across many lines" }),
    finding({ fingerprint: "slow-banner", severity: "low", risk_areas: [], title: "Marketing banner loads synchronously", statement: "blocking script tag" }),
    finding({ fingerprint: "tax-skip", severity: "high", risk_areas: [], title: "Tax lookup skipped for gift cards", statement: "gift card branch returns early" }),
    finding({ fingerprint: "invented", title: "Fabricated webhook problem", statement: "made up", evidence: [{ type: "file", path: "src/orders.js", quote: "this text does not appear anywhere in that file" }] }),
  ]);
  ingest(b.db, [finding({ fingerprint: "auth-bypass", severity: "high", risk_areas: ["security"], title: "Admin route skips the role check", statement: "guard missing on /admin" })]);
  applySpeech(a.db, a.cfg);
  const at = (db: DB, fp: string, ts: string) => db.prepare("UPDATE findings SET created_at = ? WHERE fingerprint = ?").run(ts, fp);
  at(a.db, "stock-race", "2026-11-01T00:00:01.000Z");
  at(a.db, "invoice-rounding", "2026-11-01T00:00:05.000Z");
  a.db.prepare("UPDATE findings SET status = 'stale', prev_status = 'open' WHERE fingerprint = 'slow-banner'").run();
  decide(a.db, a.root, idOf(a.db, "tax-skip"), "dismiss", "gift cards are tax exempt here");
  a.db.prepare("UPDATE findings SET delivered_at = '2026-11-05T09:00:00.000Z' WHERE fingerprint = 'retry-without-key'").run();

  const r = await api(["findings"]);
  assert.equal(r.code, 0);
  assert.deepEqual(sorted(r.json), ["api", "findings"]);
  assert.deepEqual(
    r.json.findings.map((f: any) => f.title),
    [
      "Retried POST /orders can charge a customer twice",
      "Admin route skips the role check",
      "Invoice totals round per line",
      "Inventory reservation races with checkout",
      "Marketing banner loads synchronously",
    ],
    "critical first, then high, then medium newest first; stale included; dismissed and unverified excluded",
  );
  for (const f of r.json.findings) assert.deepEqual(sorted(f), [...FINDING_KEYS].sort());

  const crit = r.json.findings[0];
  assert.equal(crit.ref, `${a.name}#${idOf(a.db, "retry-without-key")}`);
  assert.equal(crit.repo, a.name);
  assert.equal(crit.repoKey, repoKey(a.root));
  assert.equal(crit.severity, "critical");
  assert.equal(crit.issueType, "defect");
  assert.equal(crit.attribution, "introduced");
  assert.equal(crit.proof, "source_proven");
  assert.equal(crit.awareness, "unaware");
  assert.deepEqual(crit.riskAreas, ["money"]);
  assert.equal(crit.status, "open");
  assert.equal(crit.failureCase, "The first POST commits but times out; the retry creates a second order.");
  assert.equal(crit.whyItMatters, "One order per checkout.");
  assert.equal(crit.nextAction, "send an Idempotency-Key");
  assert.equal(crit.handoffPrompt, "Add an Idempotency-Key to POST /orders.");
  assert.deepEqual(crit.evidence, [{ type: "file", path: "src/orders.js", lineStart: 2, quote: QUOTE, check: "verified" }]);
  assert.equal(crit.speech.action, "speak");
  assert.equal(crit.speech.toldSession, true);
  assert.match(crit.speech.why, /risky/);
  assert.equal(crit.deliveredAt, "2026-11-05T09:00:00.000Z");
  assert.equal(crit.revision, "r1");
  assert.equal(crit.decisionNote, null);
  assert.equal(r.json.findings[1].speech, null, "speech not assessed yet");
  assert.equal(r.json.findings[4].status, "stale");

  const all = await api(["findings", "--all"]);
  const titles = all.json.findings.map((f: any) => f.title);
  assert.ok(titles.includes("Tax lookup skipped for gift cards"), "--all includes decided findings");
  assert.ok(!titles.includes("Fabricated webhook problem"), "--all still hides unverified findings");
  const dismissed = all.json.findings.find((f: any) => f.title === "Tax lookup skipped for gift cards");
  assert.equal(dismissed.status, "dismissed");
  assert.equal(dismissed.decisionNote, "gift cards are tax exempt here");
  const ranks = all.json.findings.map((f: any) => ["critical", "high", "medium", "low"].indexOf(f.severity));
  assert.deepEqual(ranks, [...ranks].sort((x: number, y: number) => x - y));

  const onlyB = await api(["findings", "--repo", b.name]);
  assert.deepEqual(onlyB.json.findings.map((f: any) => f.repo), [b.name]);
  const byPath = await api(["findings", "--repo", path.join(b.root, "src")]);
  assert.deepEqual(byPath.json.findings.map((f: any) => f.ref), onlyB.json.findings.map((f: any) => f.ref));
  const missing = await api(["findings", "--repo", "no-such-repo"]);
  assert.equal(missing.code, 1);
  assert.match(missing.json.error, /no watched repository/);
});

test("activity: kinds, paths and statuses only, newest first; never prompt text, agent messages or file contents", async () => {
  freshHome();
  const a = watchedRepo();
  ingest(a.db, [finding({})]);
  captureSession(a.db, a.root, Date.parse("2026-11-05T10:00:00.000Z"));
  const job = enqueueJob(a.db, "checkpoint", "quick", "stop", { reason: CANARIES[0] });
  updateJob(a.db, job, { status: "done", started_at: "2026-11-05T10:00:10.000Z", finished_at: "2026-11-05T10:00:40.000Z", list_cost_cents: 20, summary: "reviewed the retry change" });

  const r = await api(["activity"]);
  assert.equal(r.code, 0);
  assert.deepEqual(sorted(r.json), ["api", "events", "runs"]);
  for (const c of CANARIES) assert.ok(!r.stdout.includes(c), `activity must not contain ${c}`);
  assert.deepEqual(
    r.json.events.map((e: any) => e.kind),
    ["stop", "test", "edit", "edit", "prompt"],
    "newest first; session-start events are not activity",
  );
  for (const e of r.json.events) {
    assert.equal(e.repo, a.name);
    assert.equal(e.session, "session-");
    assert.ok(!Number.isNaN(Date.parse(e.at)));
    assert.ok(sorted(e).every((k) => ["at", "repo", "kind", "session", "agentType", "path", "testStatus"].includes(k)), `unexpected keys ${sorted(e)}`);
  }
  const [stop, testRun, write, edit, prompt] = r.json.events;
  assert.equal(stop.at, "2026-11-05T10:00:05.000Z");
  assert.equal(testRun.testStatus, "failed");
  assert.equal(write.path, "src/log.js");
  assert.equal(write.agentType, "Explore");
  assert.equal(edit.path, "src/orders.js");
  assert.equal(edit.agentType, null);
  assert.deepEqual(sorted(prompt), ["agentType", "at", "kind", "repo", "session"]);
  assert.deepEqual(r.json.runs, [
    { repo: a.name, id: job, kind: "checkpoint", status: "done", trigger: "stop", startedAt: "2026-11-05T10:00:10.000Z", finishedAt: "2026-11-05T10:00:40.000Z", costCents: 20, summary: "reviewed the retry change" },
  ]);

  const two = await api(["activity", "--limit", "2", "--repo", a.name]);
  assert.deepEqual(two.json.events.map((e: any) => e.kind), ["stop", "test"]);
  const bad = await api(["activity", "--limit", "lots"]);
  assert.equal(bad.code, 1);
  assert.match(bad.json.error, /--limit/);
});

test("decide: dismiss with a note, then reopen; the note is required", async () => {
  freshHome();
  const a = watchedRepo();
  ingest(a.db, [finding({})]);
  const ref = `${a.name}#${idOf(a.db, "retry-without-key")}`;

  const noNote = await api(["decide", "--ref", ref, "--action", "dismiss"]);
  assert.equal(noNote.code, 1);
  assert.match(noNote.json.error, /--note is required/);

  const dismissed = await api(["decide", "--ref", ref, "--action", "dismiss", "--note", "the API is idempotent server-side"]);
  assert.equal(dismissed.code, 0);
  assert.equal(dismissed.json.ok, true);
  assert.deepEqual(sorted(dismissed.json.finding), [...FINDING_KEYS].sort());
  assert.equal(dismissed.json.finding.ref, ref);
  assert.equal(dismissed.json.finding.status, "dismissed");
  assert.equal(dismissed.json.finding.decisionNote, "the API is idempotent server-side");
  assert.equal((await api(["findings"])).json.findings.length, 0, "a dismissed finding leaves the default list");

  const reopened = await api(["decide", "--ref", ref, "--action", "reopen"]);
  assert.equal(reopened.code, 0);
  assert.equal(reopened.json.finding.status, "open");
  assert.deepEqual((await api(["findings"])).json.findings.map((f: any) => f.ref), [ref]);

  const deferred = await api(["decide", "--ref", ref, "--action", "defer", "--note", "after the release", "--until", "2099-01-01T00:00:00Z"]);
  assert.equal(deferred.json.finding.status, "deferred");

  for (const [args, re] of [
    [["--ref", `${a.name}#999`, "--action", "accept", "--note", "x"], /no finding/],
    [["--ref", ref, "--action", "delete", "--note", "x"], /--action must be one of/],
    [["--ref", "no-hash", "--action", "accept", "--note", "x"], /--ref must look like/],
    [["--ref", ref, "--action", "defer", "--note", "x", "--until", "soon"], /--until/],
  ] as Array<[string[], RegExp]>) {
    const r = await api(["decide", ...args]);
    assert.equal(r.code, 1);
    assert.match(r.json.error, re);
  }
});

test("pause and resume: globally and for one repository", async () => {
  freshHome();
  const a = watchedRepo();

  const p = await api(["pause"]);
  assert.deepEqual(p.json, { api: 1, ok: true, paused: true, scope: "all" });
  assert.equal(kvGetReg(openRegistry(), "paused", false), true);
  assert.equal((await api(["status"])).json.paused, true);
  const r = await api(["resume"]);
  assert.deepEqual(r.json, { api: 1, ok: true, paused: false, scope: "all" });
  assert.equal((await api(["status"])).json.paused, false);

  const pr = await api(["pause", "--repo", a.name]);
  assert.deepEqual(pr.json, { api: 1, ok: true, paused: true, scope: a.name });
  assert.equal(kvGet(a.db, "paused", false), true);
  const st = await api(["status"]);
  assert.equal(st.json.paused, false, "pausing one repository leaves the global switch alone");
  assert.equal(st.json.repos[0].paused, true);
  const rr = await api(["resume", "--repo", a.root]);
  assert.deepEqual(rr.json, { api: 1, ok: true, paused: false, scope: a.name });
  assert.equal(kvGet(a.db, "paused", true), false);
});

test("errors are one JSON object with exit 1: unknown method, bad flags, missing method", async () => {
  freshHome();
  for (const args of [["frobnicate"], ["status", "--all"], ["findings", "--nope"], [], ["status", "extra"], ["activity", "--limit"]]) {
    const r = await api(args);
    assert.equal(r.code, 1, `exit 1 for ${args.join(" ")}`);
    assert.deepEqual(sorted(r.json), ["api", "error"]);
    assert.equal(typeof r.json.error, "string");
    assert.ok(r.json.error.length > 0);
  }
  assert.match((await api(["frobnicate"])).json.error, /unknown method "frobnicate"/);
});

test("on Node below 22.18, an api call still answers with one JSON error and exit 1", async () => {
  freshHome();
  // Preloaded before boot.mjs, so this Node reports an older version.
  const oldNode = `Object.defineProperty(process.versions, "node", { value: "22.17.0" }); Object.defineProperty(process, "version", { value: "v22.17.0" });`;
  const r = await api(["status"], { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(oldNode)}` });
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { api: 1, error: "Pilot needs Node >= 22.18, found v22.17.0" });
});
