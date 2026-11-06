import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getJob, openDb } from "../src/db.ts";
import { OfflineFixtureInvestigator } from "../src/investigator/offline.ts";
import { runJob } from "../src/runner.ts";
import { enqueueJob } from "../src/scheduler.ts";
import { tempRepo, testConfig, write } from "./helpers.ts";

const quiet = { shouldStop: () => false, log: () => {} };

function fixturesDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-fx-"));
  const finding = {
    fingerprint: "needs-deeper-look",
    issue_type: "decision", severity: "high", attribution: "introduced", proof: "source_proven", session_awareness: "unaware", risk_areas: ["money"], failure_case: "f", controls_checked: "c",
    category: "risk",
    title: "Concurrency of createOrder unclear",
    statement: "s",
    why_it_matters: "w",
    evidence: [{ type: "file", path: "src/a.js", quote: "export const a = 1;" }],
    confidence: 0.4,
    uncertainty: "u",
    suggested_next_action: "n",
    related_paths: ["src/a.js"],
  };
  const sub = (escalate: boolean) => ({ phase: "checkpoint", summary: "s", findings: [finding], escalate: { needed: escalate, reason: "need an experiment" } });
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ _label: "test", name: "quick", match: { kinds: ["manual", "checkpoint"] }, turns: [{ costCents: 9, submission: sub(true) }] }));
  fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify({ _label: "test", name: "deep", match: { kinds: ["deep"] }, turns: [{ costCents: 90, submission: sub(true) }] }));
  return dir;
}

test("a quick pass can escalate once to a deep, separately budgeted run; repeated escalation is not chained", async () => {
  const repo = tempRepo({ "src/a.js": "export const a = 1;\n" });
  const cfg = testConfig(repo, { fixturesDir: fixturesDir(), runBudgetCents: 50, deepRunBudgetCents: 200, dailyBudgetCents: 1000, autoDeep: true });
  const db = openDb(cfg.stateDir);
  const inv = new OfflineFixtureInvestigator(cfg);
  const quick = enqueueJob(db, "manual", "quick", "manual", undefined);
  const r = await runJob(cfg, db, inv, quick, quiet);
  assert.equal(r.state, "finished");
  const deep = db.prepare("SELECT * FROM jobs WHERE parent_job_id = ?").get(quick) as { id: number; depth: string; kind: string };
  assert.deepEqual([deep.kind, deep.depth], ["deep", "deep"]);
  const r2 = await runJob(cfg, db, inv, deep.id, quiet);
  assert.equal(r2.state, "finished");
  const dj = getJob(db, deep.id)!;
  assert.equal(dj.budget_cents, 200, "deep runs get the deep per-run budget");
  assert.equal(dj.list_cost_cents, 90);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE parent_job_id = ?").get(deep.id)?.n, 0, "deep runs do not escalate again");
  const f = db.prepare("SELECT seen_count FROM findings WHERE fingerprint = 'needs-deeper-look'").get() as { seen_count: number };
  assert.equal(f.seen_count, 2, "deep run re-reports the same issue: deduped");
});

test("checkpoint on an unchanged tree with no new prompt is skipped without a hosted run", async () => {
  const repo = tempRepo({ "src/a.js": "export const a = 1;\n" });
  const cfg = testConfig(repo, { fixturesDir: fixturesDir(), autoDeep: false });
  const db = openDb(cfg.stateDir);
  const inv = new OfflineFixtureInvestigator(cfg);
  const clean = await runJob(cfg, db, inv, enqueueJob(db, "checkpoint", "quick", "stop", undefined), quiet);
  assert.equal(clean.state, "skipped", "a clean tree with no work has nothing to review");
  write(repo, "src/a.js", "export const a = 1;\nexport const b = 0;\n");
  const first = await runJob(cfg, db, inv, enqueueJob(db, "checkpoint", "quick", "stop", undefined), quiet);
  assert.equal(first.state, "finished");
  const second = await runJob(cfg, db, inv, enqueueJob(db, "checkpoint", "quick", "stop", undefined), quiet);
  assert.equal(second.state, "skipped");
  write(repo, "src/a.js", "export const a = 2;\n");
  const third = await runJob(cfg, db, inv, enqueueJob(db, "checkpoint", "quick", "stop", undefined), quiet);
  assert.equal(third.state, "finished", "a real change runs again");
  const f = db.prepare("SELECT status, grounding FROM findings").get() as { status: string; grounding: string };
  // The cited file changed, so the finding went stale; the fixture's re-report quotes the old line, which no
  // longer verifies. A weak re-report must not overwrite the grounded record or silently re-confirm it.
  assert.equal(f.status, "stale");
  assert.equal(JSON.parse(f.grounding).status, "grounded");
  const h = db.prepare("SELECT action FROM finding_history ORDER BY id DESC LIMIT 1").get() as { action: string };
  assert.equal(h.action, "seen-ungrounded");
});

test("validation rejects nested nulls that would crash ingestion; developer requirements are never truncated", async () => {
  const { validateSubmission } = await import("../src/investigator/types.ts");
  const base = { phase: "checkpoint", summary: "s", findings: [] };
  assert.equal(validateSubmission({ ...base, resolved: [null] }).ok, false);
  assert.equal(validateSubmission({ ...base, still_valid: [null] }).ok, false);
  assert.equal(validateSubmission({ ...base, escalate: { needed: "yes" } }).ok, false);
  const { mergeNotes, emptyNotes } = await import("../src/notes.ts");
  const notes = { ...emptyNotes(), requirements: Array.from({ length: 41 }, (_, i) => ({ text: `R${i}`, source: "developer" as const })) };
  assert.equal(mergeNotes(notes, { requirements: [] }, "t").requirements.length, 41);
});
