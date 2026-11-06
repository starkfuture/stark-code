import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getJob, openDb, updateJob } from "../src/db.ts";
import { enqueueEvent, normalizeHook } from "../src/events.ts";
import { OfflineFixtureInvestigator } from "../src/investigator/offline.ts";
import { runJob } from "../src/runner.ts";
import { enqueueJob } from "../src/scheduler.ts";
import { RepoWatcher } from "../src/watcher.ts";
import { tempRepo, testConfig, write } from "./helpers.ts";

const quiet = { shouldStop: () => false, log: () => {} };

function fixtures(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-fx-"));
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ _label: "test", name: "any", match: { kinds: ["manual", "checkpoint"] }, turns: [{ costCents: 5, submission: { phase: "checkpoint", summary: "nothing", findings: [] } }] }));
  return dir;
}

test("review_work off (the default): edits, tests and stops are recorded but no review is planned or paid for; assess still gets them", async () => {
  const repo = tempRepo({ "src/a.js": "a\n" });
  const cfg = testConfig(repo, { reviewWork: false, quietMs: 0, promptQuietMs: 0, minRunIntervalMin: 0, fixturesDir: fixtures() });
  const db = openDb(cfg.stateDir);
  const t0 = Date.now() - 5_000;
  const base = { session_id: "s1", cwd: repo };
  for (const [i, input] of [
    { ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "e1", tool_input: { file_path: path.join(repo, "src/a.js"), old_string: "a", new_string: "b" } },
    { ...base, hook_event_name: "Stop", last_assistant_message: "done" },
  ].entries()) {
    enqueueEvent(db, normalizeHook(input, repo, t0 + i)!, null, t0 + i);
  }
  write(repo, "src/a.js", "b\n");
  const w = new RepoWatcher(cfg, new OfflineFixtureInvestigator(cfg), () => {});
  assert.equal(w.tick({ slots: 1, paused: false, shouldStop: () => false }), 0);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n), 0, "no review job");
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM events WHERE consumed = 0").get() as { n: number }).n), 2, "events are kept, unconsumed, as context");
  assert.equal(w.idle(false), true);

  // A review the developer asks for still runs, and gets the recorded work as its context (as `assess` does).
  const manual = enqueueJob(db, "manual", "quick", "manual", undefined);
  assert.equal(Number(db.prepare("UPDATE events SET consumed = 1, job_id = ? WHERE consumed = 0").run(manual).changes), 2);
  assert.equal(w.idle(false), false);
  assert.equal(w.tick({ slots: 1, paused: false, shouldStop: () => false }), 1);
  await Promise.all(w.active.values());
  assert.equal(getJob(db, manual)?.status, "done");
});

test("a batch whose review timed out is not retried automatically; `lookout assess` still can", async () => {
  const repo = tempRepo({ "src/a.js": "export const a = 1;\n" });
  const cfg = testConfig(repo, { fixturesDir: fixtures() });
  const db = openDb(cfg.stateDir);
  const inv = new OfflineFixtureInvestigator(cfg);
  write(repo, "src/a.js", "export const a = 2;\n");
  const first = enqueueJob(db, "checkpoint", "quick", "stop", undefined);
  assert.equal((await runJob(cfg, db, inv, first, quiet)).state, "finished");
  updateJob(db, first, { status: "timed_out", outcome: "timed_out" }); // as if its claude run hit the deadline

  const again = await runJob(cfg, db, inv, enqueueJob(db, "checkpoint", "quick", "stop", undefined), quiet);
  assert.equal(again.state, "skipped");
  assert.match((again as { reason: string }).reason, /timed out; not retried automatically/);

  const manual = await runJob(cfg, db, inv, enqueueJob(db, "manual", "quick", "manual", undefined), quiet);
  assert.equal(manual.state, "finished", "an explicit review of the same tree runs");

  write(repo, "src/a.js", "export const a = 3;\n");
  const changed = await runJob(cfg, db, inv, enqueueJob(db, "checkpoint", "quick", "stop", undefined), quiet);
  assert.equal(changed.state, "finished", "new work is reviewed as usual");
});
