import test from "node:test";
import assert from "node:assert/strict";
import { BUDGET, capDiff, compactEvents } from "../src/context.ts";
import { planJobs, type PendingEvent } from "../src/scheduler.ts";

test("a turn with 50 subagents becomes a compact digest: one entry per file, counts, latest requests and claims", () => {
  const events: Array<Record<string, any> & { kind: string; id: string }> = [];
  let n = 0;
  const at = () => new Date(Date.parse("2026-11-05T10:00:00Z") + n * 1000).toISOString();
  for (let p = 0; p < 9; p++) events.push({ id: `ev${++n}`, kind: "prompt", at: at(), prompt: `request ${p} ${"x".repeat(9000)}`, claude_code_session: "s1" });
  for (let a = 0; a < 50; a++) {
    for (let e = 0; e < 10; e++) {
      events.push({ id: `ev${++n}`, kind: "edit", at: at(), path: `src/mod${a % 20}.ts`, new_preview: "y".repeat(600), agent_id: `agent-${a}`, agent_type: a % 2 ? "general-purpose" : "Explore", claude_code_session: "s1" });
    }
    events.push({ id: `ev${++n}`, kind: "test", at: at(), status: a === 7 ? "failed" : "passed", output_tail: "z".repeat(2000), agent_id: `agent-${a}`, claude_code_session: "s1" });
  }
  events.push({ id: `ev${++n}`, kind: "stop", at: at(), coding_agent_message: "All 50 subagents finished; tests pass.", claude_code_session: "s1" });

  const raw = JSON.stringify(events).length;
  const d = compactEvents(events);
  const size = JSON.stringify(d).length;
  assert.ok(raw > 400_000, `raw events are large (${raw})`);
  assert.ok(size < BUDGET.eventsChars + 5000, `digest stays within budget (${size})`);
  assert.equal(d.activity.edits, 500);
  assert.equal(d.activity.files_changed, 20);
  assert.equal(d.activity.subagents_seen, 50);
  assert.equal(d.activity.failed_test_runs, 1);
  assert.equal(d.events.filter((e) => e.kind === "file_edits").length, 20, "one entry per file");
  assert.equal(d.events.filter((e) => e.kind === "prompt").length, BUDGET.prompts, "latest requests only");
  assert.ok(d.events.some((e) => e.kind === "test" && e.status === "failed"), "the failing run is kept");
  assert.ok(d.events.some((e) => e.kind === "stop"), "the agent's claim is kept");
});

test("a huge diff is abridged, most recently edited files first, the rest listed", () => {
  const chunk = (p: string, lines: number) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${"+line\n".repeat(lines)}`;
  const diff = [chunk("src/old.ts", 30_000), chunk("src/recent.ts", 100), chunk("src/other.ts", 50)].join("");
  const out = capDiff(diff, ["src/recent.ts"], 20_000);
  assert.ok(out.length < 25_000);
  assert.match(out, /diff --git a\/src\/recent\.ts/);
  assert.match(out, /Not shown here[\s\S]*src\/old\.ts/);
  assert.equal(capDiff("small", [], 100), "small");
});

test("test runs inside one long turn (parallel subagents) do not cut a half-done review", () => {
  const P = { quietMs: 20_000, promptQuietMs: 8_000, maxBatchAgeMs: 300_000, promptReview: "merge" as const };
  const ev = (id: number, kind: string, ts: number): PendingEvent => ({ id, kind, ts_ms: ts, payload: {} });
  const busy = Array.from({ length: 60 }, (_, i) => ev(i + 1, i % 5 === 0 ? "test" : "edit", i * 10_000));
  assert.equal(planJobs(600_000, busy, P).jobs.length, 0, "still working, no Stop yet: wait");
  assert.equal(planJobs(620_001, busy, P).jobs[0]?.trigger, "test", "once the turn goes quiet it is reviewed once");
});
