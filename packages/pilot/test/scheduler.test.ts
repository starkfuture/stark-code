import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { applyPlan, planJobs, resolveProbe, type PendingEvent } from "../src/scheduler.ts";
import { tempRepo, testConfig } from "./helpers.ts";

const P = { quietMs: 20_000, promptQuietMs: 8_000, maxBatchAgeMs: 300_000, promptReview: "early" as const };
const ev = (id: number, kind: string, ts: number): PendingEvent => ({ id, kind, ts_ms: ts, payload: {} });

test("edits alone never trigger; a Stop triggers one checkpoint after the burst goes quiet", () => {
  const edits = [ev(1, "edit", 0), ev(2, "edit", 1000), ev(3, "edit", 2000)];
  assert.equal(planJobs(60_000, edits, P).jobs.length, 0, "edits wait for a checkpoint");
  const burst = [...edits, ev(4, "test", 2500), ev(5, "stop", 3000)];
  assert.equal(planJobs(10_000, burst, P).jobs.length, 0, "debouncing: last event 7s ago < 20s");
  const plan = planJobs(23_001, burst, P);
  assert.equal(plan.jobs.length, 1);
  assert.deepEqual(plan.jobs[0], { kind: "checkpoint", trigger: "stop", eventIds: [1, 2, 3, 4, 5] });
});

test("a continuing burst resets the debounce, but is cut at maxBatchAgeMs", () => {
  const evs = [ev(1, "stop", 0), ...Array.from({ length: 40 }, (_, i) => ev(i + 2, "edit", (i + 1) * 10_000))];
  assert.equal(planJobs(405_000, evs, P).jobs[0]?.trigger, "max-batch-age");
  assert.equal(planJobs(299_000, evs, P).jobs.length, 0);
});

test("prompts get an early intent review; if work is ready they merge into the checkpoint", () => {
  assert.deepEqual(planJobs(9_000, [ev(1, "prompt", 0)], P).jobs, [{ kind: "intent", trigger: "prompt", eventIds: [1] }]);
  assert.equal(planJobs(5_000, [ev(1, "prompt", 0)], P).jobs.length, 0);
  const merged = planJobs(60_000, [ev(1, "prompt", 0), ev(2, "edit", 1000), ev(3, "stop", 2000)], P);
  assert.deepEqual(merged.jobs, [{ kind: "checkpoint", trigger: "stop", eventIds: [1, 2, 3] }]);
  assert.equal(planJobs(60_000, [ev(1, "prompt", 0)], { ...P, promptReview: "off" }).jobs.length, 0);
  assert.deepEqual(planJobs(60_000, [ev(9, "session", 0)], P), { consumeOnly: [9], jobs: [], waiting: null, probe: [] });
});

test("a queued job absorbs newly planned events instead of spawning another run", () => {
  const repo = tempRepo({ "a.txt": "x" });
  const db = openDb(testConfig(repo).stateDir);
  const ins = db.prepare("INSERT INTO events(dedupe_key, kind, ts, ts_ms, payload) VALUES (?, ?, '', ?, '{}')");
  ins.run("a", "prompt", 0);
  ins.run("b", "stop", 0);
  const first = applyPlan(db, { consumeOnly: [], jobs: [{ kind: "intent", trigger: "prompt", eventIds: [1] }], waiting: null, probe: [] });
  const second = applyPlan(db, { consumeOnly: [], jobs: [{ kind: "checkpoint", trigger: "stop", eventIds: [2] }], waiting: null, probe: [] });
  assert.deepEqual(first, second);
  const jobs = db.prepare("SELECT kind, trigger FROM jobs").all();
  assert.deepEqual(jobs.map((j) => ({ ...j })), [{ kind: "checkpoint", trigger: "prompt+stop" }]);
});

test("a turn without edits costs nothing unless files changed some other way (git probe)", () => {
  const qa = planJobs(60_000, [ev(1, "prompt", 0), ev(2, "stop", 1000)], { ...P, promptReview: "merge" });
  assert.deepEqual([qa.jobs, qa.probe], [[], [2]], "a question-and-answer turn is only probed");
  assert.deepEqual(resolveProbe(qa, false, [1]).consumeOnly, [2], "nothing changed: consumed, no review");
  assert.deepEqual(resolveProbe(qa, true, [1]).jobs, [{ kind: "checkpoint", trigger: "changed-outside-edits", eventIds: [1, 2] }]);
  const old = planJobs(7 * 3600_000, [ev(1, "prompt", 0)], { ...P, promptReview: "merge" });
  assert.deepEqual(old.consumeOnly, [1], "prompts that never led to a change are dropped after 6 h");
});
