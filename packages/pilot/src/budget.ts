/**
 * Rolling budget across ALL watched repositories and prompt watching (default $10 API-equivalent per 24 h), layered
 * on the per-run cap.
 *
 * - spent: sum of each run's cost inside the window, in every registered repository: the platform-reported list
 *   cost, or a labelled estimate when the platform figure is unavailable.
 * - reserved: for runs in flight, their session cap plus an overshoot allowance, because the platform lets
 *   the in-flight model request that crosses the cap finish ("at most one model request per thread").
 * - A run only starts if spent + reserved + (its cap + allowance) fits under the cap.
 */
import path from "node:path";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { openDb } from "./db.ts";
import { kvGetReg, kvSetReg, listRepos, pilotHome, openRegistry } from "./home.ts";
import type { DB as RegDB } from "./home.ts";

export interface BudgetState {
  capCents: number;
  spentCents: number;
  spentBySource: Record<string, number>;
  reservedCents: number;
  overshootAllowanceCents: number;
  observedMaxOvershootCents: number;
  availableCents: number;
}

/** Global cap override (`pilot budget set`), else config daily_budget_cents. */
export const getCap = (_db: DB, cfg: Config): number => kvGetReg<number | null>(openRegistry(), "budget_cap_cents", null) ?? cfg.dailyBudgetCents;
export const setCap = (_db: DB, cents: number): void => kvSetReg(openRegistry(), "budget_cap_cents", Math.round(cents));

const windowStart = (cfg: Config) => new Date(Date.now() - cfg.budgetWindowHours * 3600_000).toISOString();

/** One repository's spend inside the window, and its in-flight reservations. */
export function repoSpend(db: DB, cfg: Config): { bySource: Record<string, number>; spent: number; reserved: number } {
  const rows = db
    .prepare(
      "SELECT COALESCE(cost_source, 'earlier attempts') AS cost_source, COALESCE(SUM(COALESCE(list_cost_cents, 0) + prior_cost_cents), 0) AS c FROM jobs WHERE (list_cost_cents IS NOT NULL OR prior_cost_cents > 0) AND COALESCE(finished_at, started_at, created_at) >= ? GROUP BY 1",
    )
    .all(windowStart(cfg)) as Array<{ cost_source: string | null; c: number }>;
  const bySource: Record<string, number> = {};
  let spent = 0;
  for (const r of rows) {
    bySource[r.cost_source ?? "unknown"] = Number(r.c);
    spent += Number(r.c);
  }
  const reserved = Number((db.prepare("SELECT COALESCE(SUM(reserved_cents), 0) AS r FROM jobs WHERE status IN ('starting','running')").get() as { r: number }).r);
  return { bySource, spent, reserved };
}

/** Prompt checks and chat answers (registry watch_runs) inside the window, and what running ones reserve. */
export function watchSpend(reg: RegDB, cfg: Config): { spent: number; reserved: number } {
  const since = Date.now() - cfg.budgetWindowHours * 3600_000;
  const r = reg.prepare("SELECT COALESCE(SUM(cost_cents), 0) AS s, COALESCE(SUM(CASE WHEN status = 'running' THEN reserved_cents ELSE 0 END), 0) AS r FROM watch_runs WHERE created_ms >= ?").get(since) as { s: number; r: number };
  return { spent: Number(r.s), reserved: Number(r.r) };
}

/** Spend + reservations of every other registered repository and of prompt watching (the budget is machine-wide). */
function otherReposCents(cfg: Config): number {
  let total = 0;
  try {
    const reg = openRegistry();
    for (const r of listRepos(reg)) {
      if (r.root === cfg.repoRoot) continue;
      const st = repoSpend(openDb(path.join(pilotHome(), "repos", r.key)), cfg);
      total += st.spent + st.reserved;
    }
    const w = watchSpend(reg, cfg);
    total += w.spent + w.reserved;
  } catch {
    /* registry unavailable: count this repository only */
  }
  return total;
}

/** The machine-wide window across every repository's reviews and prompt watching. */
export function machineBudget(cfg: Config): { capCents: number; spentCents: number; reservedCents: number; availableCents: number; watchCents: number } {
  const reg = openRegistry();
  let spent = 0;
  let reserved = 0;
  for (const r of listRepos(reg)) {
    const st = repoSpend(openDb(path.join(pilotHome(), "repos", r.key)), cfg);
    spent += st.spent;
    reserved += st.reserved;
  }
  const w = watchSpend(reg, cfg);
  const cap = kvGetReg<number | null>(reg, "budget_cap_cents", null) ?? cfg.dailyBudgetCents;
  return { capCents: cap, spentCents: spent + w.spent, reservedCents: reserved + w.reserved, availableCents: cap - spent - reserved - w.spent - w.reserved, watchCents: w.spent };
}

export function budgetState(db: DB, cfg: Config): BudgetState {
  const cap = getCap(db, cfg);
  const own = repoSpend(db, cfg);
  const others = otherReposCents(cfg);
  const spentBySource: Record<string, number> = { ...own.bySource, ...(others ? { "other repositories": others } : {}) };
  const spent = own.spent + others;
  const reserved = own.reserved;
  const observed = Number(
    (
      db
        .prepare(
          "SELECT COALESCE(MAX(list_cost_cents - budget_cents), 0) AS o FROM jobs WHERE list_cost_cents IS NOT NULL AND budget_cents IS NOT NULL AND outcome = 'budget_reached'",
        )
        .get() as { o: number }
    ).o,
  );
  const allowance = Math.max(cfg.overshootCents, observed);
  return {
    capCents: cap,
    spentCents: spent,
    spentBySource,
    reservedCents: reserved,
    overshootAllowanceCents: allowance,
    observedMaxOvershootCents: Math.max(0, observed),
    availableCents: cap - spent - reserved,
  };
}

export type BudgetPlan = { ok: true; sessionBudgetCents: number; reserveCents: number } | { ok: false; reason: string };

export function planRunBudget(db: DB, cfg: Config, depth: "quick" | "deep"): BudgetPlan {
  const st = budgetState(db, cfg);
  const want = depth === "deep" ? cfg.deepRunBudgetCents : cfg.runBudgetCents;
  const room = st.availableCents - st.overshootAllowanceCents;
  if (room < cfg.minRunCents) {
    return {
      ok: false,
      reason: `budget: $${(st.spentCents / 100).toFixed(2)} spent in the last ${cfg.budgetWindowHours} h (all repos) + $${(st.reservedCents / 100).toFixed(2)} reserved of $${(st.capCents / 100).toFixed(2)} cap leaves less than the $${(cfg.minRunCents / 100).toFixed(2)} minimum run after the $${(st.overshootAllowanceCents / 100).toFixed(2)} overshoot allowance`,
    };
  }
  const session = Math.min(want, room);
  return { ok: true, sessionBudgetCents: Math.floor(session), reserveCents: Math.floor(session) + st.overshootAllowanceCents };
}

/** Labelled token-based estimate used only when the platform does not report list_cost. */
const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-fable-5-1": { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

export function estimateCents(model: string, usage: Record<string, any> | null): number | null {
  const p = PRICES[model];
  if (!p || !usage) return null;
  const dollars =
    ((usage.input_tokens ?? 0) * p.in +
      (usage.output_tokens ?? 0) * p.out +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
      1_000_000 +
    ((usage.active_seconds ?? 0) / 3600) * 0.08;
  return Math.ceil(dollars * 100);
}
