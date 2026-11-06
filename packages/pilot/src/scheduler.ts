/**
 * When to assess. Pure planning over pending events + a thin DB apply step.
 *
 * Policy (all local, no model calls):
 *  - SessionStart events are context only (consumed, never trigger).
 *  - Only a batch that contains code changes (edits) or test results is assessed. A Stop with no change in
 *    this repository (a question-and-answer turn) is consumed without a run.
 *  - A Stop (coding agent finished a turn) or a test result triggers a "checkpoint" once the burst is quiet for
 *    quietMs (debounce). A long uninterrupted burst is cut at maxBatchAgeMs; edits with no Stop are assessed
 *    once they have been idle that long.
 *  - Prompts are context for the next checkpoint (promptReview=merge, the default). With promptReview=early
 *    they trigger an "intent" review after promptQuietMs, before code exists. Prompts older than
 *    PROMPT_CONTEXT_MS that never led to a change are dropped.
 *  - A queued-but-not-started job absorbs newly planned events instead of creating a second job.
 */
import type { Config } from "./config.ts";
import type { DB, EventRow } from "./db.ts";
import { tx } from "./db.ts";
import { nowIso } from "./util.ts";

export interface PendingEvent {
  id: number;
  kind: string;
  ts_ms: number;
  payload: Record<string, any>;
}

export interface PlannedJob {
  kind: "intent" | "checkpoint";
  trigger: string;
  eventIds: number[];
}

export interface Plan {
  consumeOnly: number[];
  jobs: PlannedJob[];
  waiting: string | null;
  /** Stop/test events with no edits: the watcher checks (git, no model) whether files changed anyway. */
  probe: number[];
}

type Policy = Pick<Config, "quietMs" | "promptQuietMs" | "maxBatchAgeMs" | "promptReview">;

export const PROMPT_CONTEXT_MS = 6 * 3600_000;

export function planJobs(now: number, pending: PendingEvent[], p: Policy): Plan {
  const plan: Plan = { consumeOnly: [], jobs: [], waiting: null, probe: [] };
  const prompts = pending.filter((e) => e.kind === "prompt" && now - e.ts_ms < PROMPT_CONTEXT_MS);
  const edits = pending.filter((e) => e.kind === "edit");
  const tests = pending.filter((e) => e.kind === "test");
  const stops = pending.filter((e) => e.kind === "stop");
  plan.consumeOnly = pending.filter((e) => e.kind === "session" || (e.kind === "prompt" && now - e.ts_ms >= PROMPT_CONTEXT_MS)).map((e) => e.id);
  if (!edits.length && (stops.length || tests.length)) {
    const quiet = now - Math.max(...[...stops, ...tests].map((e) => e.ts_ms)) >= p.quietMs;
    if (quiet) plan.probe = [...stops, ...tests].map((e) => e.id);
    else plan.waiting = `debouncing ${stops.length + tests.length} event(s)`;
  }
  const work = edits.length ? [...edits, ...tests, ...stops] : [];
  const max = (xs: PendingEvent[]) => Math.max(...xs.map((e) => e.ts_ms));
  const min = (xs: PendingEvent[]) => Math.min(...xs.map((e) => e.ts_ms));

  let workTrigger: string | null = null;
  if (work.length) {
    const triggers = work.filter((e) => e.kind === "stop" || e.kind === "test");
    const quiet = now - max(work) >= p.quietMs;
    const old = now - min(work) >= p.maxBatchAgeMs;
    if (triggers.length && quiet) workTrigger = triggers.some((e) => e.kind === "stop") ? "stop" : "test";
    // A long burst is cut only across turns (a Stop happened): test runs inside one long turn, e.g. many subagents
    // working in parallel, wait for the turn to end instead of triggering half-done reviews.
    else if (stops.length && old) workTrigger = "max-batch-age";
    else if (!triggers.length && old && quiet) workTrigger = "edits-idle";
    else plan.waiting = triggers.length ? `debouncing ${work.length} work event(s)` : `${work.length} edit(s) waiting for a Stop/test checkpoint`;
  }

  if (workTrigger) {
    const ids = [...work.map((e) => e.id), ...prompts.map((e) => e.id)]; // prompts: the request behind the change
    plan.jobs.push({ kind: "checkpoint", trigger: workTrigger, eventIds: [...new Set(ids)].sort((a, b) => a - b) });
  } else if (prompts.length && p.promptReview === "early" && !work.length) {
    if (now - max(prompts) >= p.promptQuietMs) plan.jobs.push({ kind: "intent", trigger: "prompt", eventIds: prompts.map((e) => e.id) });
    else plan.waiting = plan.waiting ?? `debouncing ${prompts.length} prompt(s)`;
  }
  return plan;
}

export function pendingEvents(db: DB): PendingEvent[] {
  const rows = db.prepare("SELECT * FROM events WHERE consumed = 0 ORDER BY id").all() as unknown as EventRow[];
  return rows.map((r) => ({ id: r.id, kind: r.kind, ts_ms: r.ts_ms, payload: JSON.parse(r.payload) }));
}

const KIND_RANK: Record<string, number> = { intent: 1, checkpoint: 2, manual: 3, onboarding: 4, deep: 5 };

/** Apply a plan: consume context-only events, fold into a queued job or create a new one. */
/** Turn probe events into a checkpoint job (files changed) or consume them (nothing changed). */
export function resolveProbe(plan: Plan, changed: boolean, prompts: number[]): Plan {
  if (!plan.probe.length) return plan;
  if (!changed) return { ...plan, consumeOnly: [...plan.consumeOnly, ...plan.probe], probe: [] };
  const ids = [...new Set([...plan.probe, ...prompts])].sort((a, b) => a - b);
  return { ...plan, jobs: [...plan.jobs, { kind: "checkpoint", trigger: "changed-outside-edits", eventIds: ids }], probe: [] };
}

export function applyPlan(db: DB, plan: Plan): number[] {
  const touched: number[] = [];
  tx(db, () => {
    const consume = db.prepare("UPDATE events SET consumed = 1, job_id = ? WHERE id = ?");
    for (const id of plan.consumeOnly) consume.run(null, id);
    for (const j of plan.jobs) {
      const queued = db
        .prepare("SELECT id, kind, trigger FROM jobs WHERE status = 'queued' AND kind IN ('intent','checkpoint') ORDER BY id DESC LIMIT 1")
        .get() as { id: number; kind: string; trigger: string } | undefined;
      let jobId: number;
      if (queued) {
        jobId = queued.id;
        const kind = KIND_RANK[j.kind] > KIND_RANK[queued.kind] ? j.kind : queued.kind;
        const trig = queued.trigger.split("+").includes(j.trigger) ? queued.trigger : `${queued.trigger}+${j.trigger}`;
        db.prepare("UPDATE jobs SET kind = ?, trigger = ? WHERE id = ?").run(kind, trig, jobId);
      } else {
        jobId = Number(
          db.prepare("INSERT INTO jobs(kind, depth, trigger, status, created_at) VALUES (?, 'quick', ?, 'queued', ?)").run(j.kind, j.trigger, nowIso()).lastInsertRowid,
        );
      }
      for (const id of j.eventIds) consume.run(jobId, id);
      touched.push(jobId);
    }
  });
  return touched;
}

export function enqueueJob(db: DB, kind: string, depth: "quick" | "deep", trigger: string, input: unknown, parent: number | null = null): number {
  return Number(
    db
      .prepare("INSERT INTO jobs(kind, depth, trigger, status, created_at, input, parent_job_id) VALUES (?, ?, ?, 'queued', ?, ?, ?)")
      .run(kind, depth, trigger, nowIso(), input === undefined ? null : JSON.stringify(input), parent).lastInsertRowid,
  );
}
