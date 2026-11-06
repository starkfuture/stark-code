import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { decide, ingestSubmission, markStale, verifyGrounding, type IngestContext } from "../src/findings.ts";
import type { Submission, SubmittedFinding } from "../src/investigator/types.ts";
import { sha256 } from "../src/util.ts";
import { tempRepo, testConfig, write } from "./helpers.ts";

const files: Record<string, string> = {
  "src/orders.js": "export function createOrder() {\n  return withRetry(() => post('/orders'));\n}\n",
  "docs/api.md": "POST /orders is not idempotent.\n",
};

function ctx(over: Partial<IngestContext> = {}, content = files): IngestContext {
  return {
    jobId: 1,
    revision: "r1",
    fileHashes: Object.fromEntries(Object.entries(content).map(([k, v]) => [k, sha256(v)])),
    runtime: "test",
    readFile: (p) => content[p] ?? null,
    toolLog: [{ command: "cd /workspace/review/repo && node exp.mjs", output: "orders created: 3\n", isError: false }],
    toolLogTrusted: true,
    eventsText: "Retries are safe because failures don't create orders.",
    ...over,
  };
}

const finding = (over: Partial<SubmittedFinding> = {}): SubmittedFinding => ({
  fingerprint: "retry-without-idempotency",
  issue_type: "defect", severity: "high", attribution: "introduced", proof: "source_proven", session_awareness: "unaware", risk_areas: ["money"], failure_case: "f", controls_checked: "c",
  category: "omission",
  title: "Create retries without idempotency key duplicate orders",
  statement: "createOrder retries a non-idempotent POST.",
  why_it_matters: "One order per checkout.",
  evidence: [
    { type: "file", path: "/workspace/review/repo/src/orders.js", line_start: 2, quote: "return withRetry(() => post('/orders'));" },
    { type: "file", path: "docs/api.md", quote: "POST /orders is not idempotent." },
    { type: "command", command: "node exp.mjs", output_excerpt: "orders created: 3" },
    { type: "event", quote: "failures don't create orders" },
  ],
  confidence: 0.9,
  uncertainty: "none",
  suggested_next_action: "add key",
  related_paths: ["src/orders.js"],
  ...over,
});
const sub = (fs: SubmittedFinding[], extra: Partial<Submission> = {}): Submission => ({ phase: "checkpoint", summary: "s", findings: fs, ...extra });

test("grounding: verbatim quotes and the session's own transcript verify; invented evidence fails", () => {
  const g = verifyGrounding(finding(), ctx());
  assert.equal(g.status, "grounded");
  assert.equal(g.verified, 4);
  const bad = verifyGrounding(
    finding({ evidence: [{ type: "file", path: "src/orders.js", quote: "maxRetries: 10" }, { type: "command", command: "node never-ran.mjs", output_excerpt: "boom" }] }),
    ctx(),
  );
  assert.equal(bad.status, "ungrounded");
  const offline = verifyGrounding(finding({ evidence: [{ type: "command", command: "node exp.mjs", output_excerpt: "orders created: 3" }] }), ctx({ toolLogTrusted: false }));
  assert.equal(offline.checks[0].result, "unverifiable", "fixture transcripts are not trusted evidence");
});

test("ungrounded findings are stored as unverified (hidden); exact and fuzzy duplicates merge", () => {
  const repo = tempRepo(files);
  const db = openDb(testConfig(repo).stateDir);
  const r1 = ingestSubmission(db, sub([finding(), finding({ fingerprint: "made-up", title: "Something plausible", statement: "x", evidence: [{ type: "file", path: "src/orders.js", quote: "nope" }] })]), ctx());
  assert.equal(r1.created.length, 1);
  assert.equal(r1.unverified.length, 1);
  const r2 = ingestSubmission(db, sub([finding()]), ctx({ jobId: 2 }));
  assert.deepEqual(r2.updated, r1.created);
  const r3 = ingestSubmission(db, sub([finding({ fingerprint: "dup-orders-on-retry", title: "Create retries without an idempotency key duplicate orders" })]), ctx({ jobId: 3 }));
  assert.deepEqual(r3.updated, r1.created, "fuzzy match on wording + files");
  const row = db.prepare("SELECT seen_count FROM findings WHERE id = ?").get(r1.created[0]) as { seen_count: number };
  assert.equal(row.seen_count, 3);
});

test("dismissed findings stay dismissed until the evidence they were decided on changes; then they reopen", () => {
  const repo = tempRepo(files);
  const db = openDb(testConfig(repo).stateDir);
  const [id] = ingestSubmission(db, sub([finding()]), ctx()).created;
  decide(db, repo, id, "dismiss", "server dedupes by cart id");
  const again = ingestSubmission(db, sub([finding({ new_evidence_since_dismissal: "I insist" })]), ctx({ jobId: 2 }));
  assert.deepEqual(again.suppressed, [id], "assertion alone is not new evidence");
  assert.throws(() => decide(db, repo, id, "accept", ""), /reason is required/);

  // Irrelevant change: a comment added to the file; the quoted code is unchanged -> still suppressed.
  const commented = { ...files, "src/orders.js": `${files["src/orders.js"]}// unrelated comment\n` };
  const irrelevant = ingestSubmission(db, sub([finding()]), ctx({ jobId: 3 }, commented));
  assert.deepEqual(irrelevant.suppressed, [id], "a file change that leaves the cited code intact is not relevant");

  // Relevant change: the quoted code itself changed, and the new report cites the new code.
  const changed = { ...files, "src/orders.js": "export function createOrder() {\n  return withRetry(() => post('/orders', { attempts: 5 }));\n}\n" };
  write(repo, "src/orders.js", changed["src/orders.js"]);
  const re = ingestSubmission(db, sub([finding({ evidence: [{ type: "file", path: "src/orders.js", quote: "return withRetry(() => post('/orders', { attempts: 5 }));" }] })]), ctx({ jobId: 4 }, changed));
  assert.deepEqual(re.reopened, [id]);
  const row = db.prepare("SELECT status, status_reason FROM findings WHERE id = ?").get(id) as { status: string; status_reason: string };
  assert.equal(row.status, "open");
  assert.match(row.status_reason, /evidence changed since dismissed \(src\/orders.js\)/);
});

test("grounding cannot be fabricated: substring commands, empty excerpts and tiny quotes do not verify", () => {
  const c = ctx({ toolLog: [{ command: "echo ok", output: "anything at all here", isError: false }] });
  const fake = (e: SubmittedFinding["evidence"]) => verifyGrounding(finding({ evidence: e }), c);
  assert.equal(fake([{ type: "command", command: "npm test && echo ok", output_excerpt: "..." }]).status, "ungrounded");
  assert.equal(fake([{ type: "command", command: "echo ok", output_excerpt: "..." }]).status, "ungrounded", "empty excerpt proves nothing");
  assert.equal(fake([{ type: "command", command: "cd /workspace/review/repo && echo ok", output_excerpt: "anything at all" }]).status, "grounded", "a leading cd hop is fine");
  assert.equal(fake([{ type: "file", path: "src/orders.js", quote: "post" }]).checks[0].result, "unverifiable", "a 4-char quote identifies nothing");
});

test("still_valid is accepted only if the stored evidence still verifies at the new revision", () => {
  const repo = tempRepo(files);
  const db = openDb(testConfig(repo).stateDir);
  const [id] = ingestSubmission(db, sub([finding({ evidence: [{ type: "file", path: "src/orders.js", quote: "return withRetry(() => post('/orders'));" }] })]), ctx()).created;
  const rewritten = { ...files, "src/orders.js": "export const createOrder = () => idempotentPost('/orders');\n" };
  const ctx2 = ctx({ jobId: 2 }, rewritten);
  markStale(db, ctx2.fileHashes, "r2", 2);
  const r = ingestSubmission(db, sub([], { still_valid: ["retry-without-idempotency"] }), ctx2);
  assert.deepEqual(r.reconfirmed, []);
  const row = db.prepare("SELECT status, status_reason FROM findings WHERE id = ?").get(id) as { status: string; status_reason: string };
  assert.equal(row.status, "stale");
  assert.match(row.status_reason, /no longer matches/);
});

test("stale: changed evidence files mark findings stale; agent re-confirms or resolves", () => {
  const repo = tempRepo(files);
  const db = openDb(testConfig(repo).stateDir);
  const [id] = ingestSubmission(db, sub([finding()]), ctx()).created;
  decide(db, repo, id, "accept", "will fix");
  const newHashes = { ...ctx().fileHashes, "src/orders.js": "different" };
  assert.deepEqual(markStale(db, newHashes, "r2", 2), [id]);
  assert.deepEqual(markStale(db, newHashes, "r2", 2), [], "already stale");
  const re = ingestSubmission(db, sub([], { still_valid: ["retry-without-idempotency"] }), ctx({ jobId: 3, fileHashes: newHashes }));
  assert.deepEqual(re.reconfirmed, [id]);
  assert.equal((db.prepare("SELECT status FROM findings WHERE id = ?").get(id) as { status: string }).status, "accepted", "prior decision restored");
  markStale(db, { ...newHashes, "src/orders.js": "third" }, "r3", 4);
  const res = ingestSubmission(db, sub([], { resolved: [{ fingerprint: "retry-without-idempotency", reason: "key added" }] }), ctx({ jobId: 5 }));
  assert.deepEqual(res.resolved, [id]);
});
