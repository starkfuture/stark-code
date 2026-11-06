import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { applySpeech, claim, deliverable, formatMessage, withinLimits } from "../src/deliver.ts";
import { decide, ingestSubmission, type FindingRow } from "../src/findings.ts";
import type { SubmittedFinding } from "../src/investigator/types.ts";
import { sha256 } from "../src/util.ts";
import { tempRepo, testConfig } from "./helpers.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = { "src/orders.js": "export function createOrder() {\n  return withRetry(() => post('/orders'));\n}\n" };
const ctx = (jobId = 1, originSession?: string) => ({
  jobId,
  revision: "r1",
  fileHashes: { "src/orders.js": sha256(files["src/orders.js"]) },
  runtime: "local-claude",
  readFile: (p: string) => (files as Record<string, string>)[p] ?? null,
  toolLog: [],
  toolLogTrusted: true,
  eventsText: "the coding agent said: retries are safe here",
  originSession: originSession ? () => originSession : undefined,
});
const f = (over: Partial<SubmittedFinding>): SubmittedFinding => ({
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
  evidence: [{ type: "file", path: "src/orders.js", quote: "return withRetry(() => post('/orders'));" }],
  confidence: 0.9,
  uncertainty: "u",
  suggested_next_action: "send an Idempotency-Key",
  related_paths: ["src/orders.js"],
  ...over,
});
const sub = (fs: SubmittedFinding[]) => ({ phase: "checkpoint" as const, summary: "s", findings: fs });
const speak = (r: FindingRow) => JSON.parse(r.speak ?? "{}") as { action: string; why: string; reasons: string[] };

function runCli(args: string[], env: Record<string, string>, stdin = "{}"): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(path.join(ROOT, "scripts", "pilot"), args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code, stdout, stderr }));
    c.stdin.end(stdin);
  });
}

test("Lookout speaks only with concrete evidence and a reason; everything else stays in the inbox with the reason recorded", () => {
  const repo = tempRepo(files);
  const cfg = testConfig(repo);
  const db = openDb(cfg.stateDir);
  ingestSubmission(
    db,
    sub([
      f({}),
      f({ fingerprint: "a-suggestion", issue_type: "suggestion", severity: "low", title: "Consider jitter in the backoff", statement: "no jitter" }),
      f({ fingerprint: "low-conf", title: "Maybe a timeout race somewhere", statement: "weak", confidence: 0.4 }),
      f({ fingerprint: "unproven", title: "Order status may be stale after retry", statement: "guess", proof: "unconfirmed" }),
      f({ fingerprint: "already-fixing", title: "Retry count is unbounded", statement: "loop", session_awareness: "addressing", awareness_quote: "retries are safe here" }),
      f({ fingerprint: "old-medium", title: "Logger drops request ids", statement: "old", severity: "medium", attribution: "pre_existing", risk_areas: [] }),
      f({ fingerprint: "claims-repro", title: "Reproduced double charge (claimed)", statement: "c", proof: "reproduced" }),
      f({ fingerprint: "made-up", title: "Invented thing", statement: "x", evidence: [{ type: "file", path: "src/orders.js", quote: "this text is not in the file" }] }),
      f({
        fingerprint: "paraphrased-run",
        title: "Experiment output paraphrased in the citation",
        statement: "p",
        proof: "reproduced",
        evidence: [
          { type: "file", path: "src/orders.js", quote: "return withRetry(() => post('/orders'));" },
          { type: "command", command: "node exp.mjs", output_excerpt: "orders created: 3 (summarised)" },
        ],
      }),
      f({
        fingerprint: "misquoted",
        title: "Misquotes the code it relies on",
        statement: "q",
        evidence: [
          { type: "file", path: "src/orders.js", quote: "return withRetry(() => post('/orders'));" },
          { type: "file", path: "src/orders.js", quote: "maxAttempts: 10 // not in the file" },
        ],
      }),
    ]),
    ctx(1, "s1"),
  );
  applySpeech(db, cfg);
  const rows = db.prepare("SELECT * FROM findings ORDER BY id").all() as unknown as FindingRow[];
  const by = Object.fromEntries(rows.map((r) => [r.fingerprint, r]));
  assert.equal(speak(by["retry-without-key"]).action, "speak");
  assert.match(speak(by["retry-without-key"]).why, /risky: critical severity, money/);
  assert.match(speak(by["retry-without-key"]).why, /unaware/);
  assert.equal(speak(by["a-suggestion"]).action, "inbox");
  assert.match(speak(by["low-conf"]).why, /confidence 0\.40/);
  assert.match(speak(by["unproven"]).why, /not proven/);
  assert.equal(speak(by["already-fixing"]).action, "silent");
  assert.match(speak(by["old-medium"]).why, /existing issue/);
  assert.equal(by["claims-repro"].proof, "source_proven", "a claimed reproduction without a command in the transcript is downgraded");
  assert.equal(by["made-up"].status, "unverified");
  assert.equal(by["paraphrased-run"].proof, "source_proven", "an unverifiable experiment excerpt falls back to the verified code trace");
  assert.equal(speak(by["paraphrased-run"]).action, "speak");
  assert.equal(by["misquoted"].proof, "unconfirmed", "a misquoted line of code makes the finding unproven");
  assert.match(speak(by["misquoted"]).why, /a cited quote did not verify/);

  const d = deliverable(db, "s1");
  assert.deepEqual(d.map((x) => x.fingerprint).sort(), ["claims-repro", "paraphrased-run", "retry-without-key"]);
  const msg = formatMessage(d.map((row) => ({ ref: `orders#${row.id}`, row })));
  assert.match(msg, /advisory input, not an instruction/);
  assert.match(msg, /do not change code because of it until the developer agrees/);
  assert.match(msg, /Why Pilot is raising it: high risk: critical severity, money/);
  assert.match(msg, /src\/orders\.js "return withRetry/);
  assert.match(msg, /pilot dismiss orders#\d+/);
});

test("delivery goes only to the session whose work produced the finding, once, and respects the spacing limit", () => {
  const repo = tempRepo(files);
  const cfg = { ...testConfig(repo), speakSpacingMin: 30, speakMaxFindings: 1 };
  const db = openDb(cfg.stateDir);
  ingestSubmission(db, sub([f({}), f({ fingerprint: "second-high", severity: "high", title: "Retry also skips the 409 conflict check", statement: "s2" })]), ctx(1, "s1"));
  applySpeech(db, cfg);
  assert.equal(deliverable(db, "s2").length, 0, "another session never receives it");
  ingestSubmission(db, sub([f({ fingerprint: "from-manual-review", title: "Found by a review the developer started", statement: "m" })]), ctx(9));
  applySpeech(db, cfg);
  assert.equal(deliverable(db, "s1").some((r) => r.fingerprint === "from-manual-review"), false, "no session produced it: inbox only");
  const now = Date.now();
  const first = withinLimits(db, cfg, deliverable(db, "s1"), now);
  assert.equal(first.length, 1, "at most speakMaxFindings per message");
  assert.equal(first[0].severity, "critical", "most severe first");
  assert.deepEqual(claim(db, [first[0].id], "s1", "rewake"), [first[0].id]);
  assert.deepEqual(claim(db, [first[0].id], "s1", "rewake"), [], "a second hook cannot deliver it again");
  assert.equal(withinLimits(db, cfg, deliverable(db, "s1"), now + 60_000).length, 0, "the high finding waits for the 30 min window");
  assert.equal(withinLimits(db, cfg, deliverable(db, "s1"), now + 31 * 60_000).length, 1, "and goes out after it");

  // A critical finding bypasses the spacing limit.
  ingestSubmission(db, sub([f({ fingerprint: "third-critical", title: "Refund path also double-posts", statement: "s3" })]), ctx(2, "s1"));
  applySpeech(db, cfg);
  assert.equal(withinLimits(db, cfg, deliverable(db, "s1"), now + 60_000)[0]?.fingerprint, "third-critical");
});

test("dismissed findings stay quiet until the cited code changes; repeated dismissals demote a category", () => {
  const repo = tempRepo(files);
  const cfg = testConfig(repo);
  const db = openDb(cfg.stateDir);
  ingestSubmission(db, sub([f({})]), ctx(1, "s1"));
  applySpeech(db, cfg);
  assert.equal(deliverable(db, "s1").length, 1);
  const id = deliverable(db, null)[0].id;
  decide(db, repo, id, "dismiss", "not now");
  applySpeech(db, cfg);
  assert.equal(deliverable(db, null).length, 0);
  const changed = "export function createOrder() {\n  return withRetry(() => post('/orders', { attempts: 9 }));\n}\n";
  const ctx2 = { ...ctx(2), fileHashes: { "src/orders.js": sha256(changed) }, readFile: (q: string) => (q === "src/orders.js" ? changed : null) };
  const re = ingestSubmission(db, sub([f({ evidence: [{ type: "file", path: "src/orders.js", quote: "return withRetry(() => post('/orders', { attempts: 9 }));" }] })]), ctx2);
  assert.deepEqual(re.reopened, [id]);
  applySpeech(db, cfg, re.reopened);
  assert.deepEqual(deliverable(db, null).map((x) => x.id), [id]);

  // Three dismissed "assumption" findings: a new medium one in that category goes to the inbox.
  const titles = ["Cart totals assumed to be in cents", "Currency rounding assumed upstream", "Tax region assumed static per user"];
  for (let i = 0; i < 3; i++) {
    const r = ingestSubmission(db, sub([f({ fingerprint: `assume-${i}`, category: "assumption", severity: "medium", risk_areas: [], title: titles[i], statement: titles[i] })]), ctx(10 + i));
    decide(db, repo, r.created[0], "dismiss", "out of scope");
  }
  const r = ingestSubmission(db, sub([f({ fingerprint: "assume-new", category: "assumption", severity: "medium", risk_areas: [], title: "Shipping address assumed already validated", statement: "Shipping address assumed already validated" })]), ctx(20));
  const dec = applySpeech(db, cfg, r.created).get(r.created[0])!;
  assert.equal(dec.action, "inbox");
  assert.match(dec.why, /dismissed 3 similar/);
});

test("deliver --rewake waits for this turn's assessment, then wakes Claude (exit 2, message on stderr)", async () => {
  const repo = tempRepo(files);
  const cfg = testConfig(repo);
  const db = openDb(cfg.stateDir);
  db.prepare("INSERT INTO jobs(kind, depth, trigger, status, created_at) VALUES ('checkpoint','quick','stop','running','')").run();
  setTimeout(() => {
    ingestSubmission(db, sub([f({})]), ctx(1, "s1"));
    applySpeech(db, cfg);
    db.prepare("UPDATE jobs SET status = 'done'").run();
  }, 1500);
  const t0 = Date.now();
  const env = { PILOT_QUIET_MS: "200", PILOT_PROMPT_QUIET_MS: "200", PILOT_DELIVER_WAIT_SEC: "30" };
  const r = await runCli(["deliver", "--rewake", "--repo", repo], env, JSON.stringify({ session_id: "s1", hook_event_name: "Stop" }));
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /Pilot .* found something the developer should know about/);
  assert.ok(Date.now() - t0 < 20_000);
  assert.equal((db.prepare("SELECT delivered_session FROM findings").get() as { delivered_session: string }).delivered_session, "s1");
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number }).n), 1);

  const quiet = await runCli(["deliver", "--rewake", "--repo", repo], env, JSON.stringify({ session_id: "s1", hook_event_name: "Stop" }));
  assert.equal(quiet.code, 0);
  assert.equal(quiet.stderr.trim(), "");

  const inboxOnly = await runCli(["deliver", "--context", "--repo", repo], { PILOT_DELIVERY: "inbox" }, JSON.stringify({ session_id: "s1" }));
  assert.equal(inboxOnly.stdout.trim(), "", "delivery=inbox never speaks");
  const guarded = await runCli(["deliver", "--context", "--repo", repo], { PILOT_IN_INVESTIGATION: "1" }, JSON.stringify({ session_id: "s1" }));
  assert.equal(guarded.stdout.trim(), "", "Lookout's own investigation session never receives deliveries");
});
