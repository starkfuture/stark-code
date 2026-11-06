import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { budgetState, planRunBudget, setCap } from "../src/budget.ts";
import { tempRepo, testConfig } from "./helpers.ts";

test("rolling budget: spent + reserved + overshoot allowance gate new runs; old spend drops out of the window", () => {
  const repo = tempRepo({ "a.txt": "x" });
  const cfg = testConfig(repo, { dailyBudgetCents: 200, runBudgetCents: 75, overshootCents: 40, minRunCents: 20 });
  const db = openDb(cfg.stateDir);
  const job = (status: string, cost: number | null, budget: number | null, reserved: number | null, outcome: string | null = null) =>
    db
      .prepare("INSERT INTO jobs(kind, depth, trigger, status, created_at, list_cost_cents, budget_cents, reserved_cents, cost_source, outcome) VALUES ('checkpoint','quick','t',?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?, 'platform', ?)")
      .run(status, cost, budget, reserved, outcome);

  let p = planRunBudget(db, cfg, "quick");
  assert.deepEqual(p, { ok: true, sessionBudgetCents: 75, reserveCents: 115 });

  job("done", 60, 75, 115);
  job("running", null, 75, 115);
  // available = 200 - 60 - 115 = 25; minus 40 allowance -> blocked
  p = planRunBudget(db, cfg, "quick");
  assert.equal(p.ok, false);

  setCap(db, 400); // available 225 - 40 = 185 -> full quick run
  assert.deepEqual(planRunBudget(db, cfg, "quick"), { ok: true, sessionBudgetCents: 75, reserveCents: 115 });

  // A run that overshot its cap by 55c raises the allowance used for later reservations.
  job("budget_reached", 130, 75, 115, "budget_reached");
  const st = budgetState(db, cfg);
  assert.equal(st.observedMaxOvershootCents, 55);
  assert.equal(st.overshootAllowanceCents, 55);
  assert.equal(st.spentCents, 190);
  // available = 400 - 190 - 115 = 95; room = 95 - 55 = 40 -> capped session budget below the 75c default
  assert.deepEqual(planRunBudget(db, cfg, "quick"), { ok: true, sessionBudgetCents: 40, reserveCents: 95 });

  // Spend older than the window no longer counts.
  db.prepare("UPDATE jobs SET created_at = '2020-01-01T00:00:00.000Z' WHERE status != 'running'").run();
  assert.equal(budgetState(db, cfg).spentCents, 0);
});
