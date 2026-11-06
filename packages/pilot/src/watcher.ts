/**
 * Scheduling. Idle cost is a SQLite poll every pollMs - no model calls, no network.
 *
 *  - RepoWatcher: one working tree. Plans checkpoints from its event queue, enforces pause/stop, the budget gate
 *    and the minimum interval between runs, starts runs, and on startup recovers jobs interrupted by a crash.
 *  - daemon(): the machine-wide background process (started by the SessionStart hook). It owns one RepoWatcher
 *    per registered repository, shares one concurrency limit and one budget across them, and takes repositories
 *    in turn so a busy one cannot starve the rest. It exits after a quiet period; the next session restarts it.
 *  - watch(): a single repository in the foreground (scripts, tests, debugging).
 *  - While the daemon runs and the Agent Engine is connected, it also polls the engine's findings feed every
 *    engine_poll_min (engine.ts). The poll runs beside the scheduling loop and never delays it.
 *  - Prompt watching (promptWatch.ts) runs beside it too: one prompt check at a time, never blocking the loop.
 */
import os from "node:os";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import type { DB, JobRow } from "./db.ts";
import { getJob, kvGet, kvSet, openDb, tx, updateJob } from "./db.ts";
import { planRunBudget } from "./budget.ts";
import { enginePollDue, macKeychain, pollEngine, scrubKeys, type PollDeps } from "./engine.ts";
import { expireDeferrals } from "./findings.ts";
import { isExcluded, kvGetReg, kvSetReg, listRepos, pilotHome, openRegistry } from "./home.ts";
import { PromptWatcher } from "./promptWatch.ts";
import type { Investigator } from "./investigator/index.ts";
import { runJob } from "./runner.ts";
import { applyPlan, pendingEvents, planJobs, PROMPT_CONTEXT_MS, resolveProbe } from "./scheduler.ts";
import { repoIdentity, worktreeFingerprint } from "./snapshot.ts";
import { sleep } from "./util.ts";

export interface WatchOptions {
  untilIdle?: boolean;
  log: (msg: string) => void;
}

interface Lock {
  pid: number;
  host: string;
  heartbeat: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, but we may not signal it (sandboxed shell)
  }
}

/**
 * A lock is held while its process is alive on this host. The heartbeat only guards against pid reuse
 * (10 min), so a watcher busy for a few seconds (large snapshot) is never mistaken for a dead one.
 */
export function lockAlive(lock: Lock | null): boolean {
  if (!lock) return false;
  if (lock.host !== os.hostname()) return Date.now() - lock.heartbeat < 60_000;
  return alive(lock.pid) && Date.now() - lock.heartbeat < 10 * 60_000;
}

export function watcherStatus(db: DB): { running: boolean; lock: Lock | null } {
  const lock = kvGet<Lock | null>(db, "watcher", null);
  return { running: lockAlive(lock), lock };
}

export function daemonStatus(): { running: boolean; lock: Lock | null } {
  const lock = kvGetReg<Lock | null>(openRegistry(), "daemon", null);
  return { running: lockAlive(lock), lock };
}

const me = (): Lock => ({ pid: process.pid, host: os.hostname(), heartbeat: Date.now() });
const fmtJob = (j: JobRow) => `#${j.id} ${j.kind}${j.depth === "deep" ? " (deep)" : ""}`;
const ts = () => new Date().toTimeString().slice(0, 8); // local time, as people read it

export class RepoWatcher {
  readonly cfg: Config;
  readonly inv: Investigator;
  readonly log: (m: string) => void;
  readonly label: string;
  readonly db: DB;
  readonly active = new Map<number, Promise<void>>();
  private lastWaiting = "";
  private lastBlocked = "";
  blocked = false;

  constructor(cfg: Config, inv: Investigator, log: (m: string) => void, label = "") {
    this.cfg = cfg;
    this.inv = inv;
    this.log = log;
    this.label = label;
    this.db = openDb(cfg.stateDir);
  }

  /** Atomic per-repository lock: two processes cannot schedule the same working tree. */
  acquire(): Lock | null {
    return tx(this.db, () => {
      const lock = kvGet<Lock | null>(this.db, "watcher", null);
      if (lock && lock.pid !== process.pid && lockAlive(lock)) return lock;
      kvSet(this.db, "watcher", me());
      return null;
    });
  }

  beat(): void {
    kvSet(this.db, "watcher", me());
  }

  release(): void {
    const lock = kvGet<Lock | null>(this.db, "watcher", null);
    if (lock?.pid === process.pid) kvSet(this.db, "watcher", null);
  }

  private say(m: string): void {
    this.log(`[${ts()}]${this.label ? ` ${this.label}` : ""} ${m}`);
  }

  launch(jobId: number, shouldStop: () => boolean): void {
    const j = getJob(this.db, jobId)!;
    const jl = (m: string) => this.say(`${fmtJob(j)}: ${m}`);
    const p = runJob(this.cfg, this.db, this.inv, jobId, { shouldStop, log: jl })
      .then((r) => {
        if (r.state === "blocked") jl(`blocked - ${r.reason}`);
        else if (r.state === "skipped") jl(`skipped - ${r.reason}`);
        else {
          const created = r.report.flatMap((x) => x.created).length;
          const other = r.report.reduce((n, x) => n + x.updated.length + x.reopened.length + x.reconfirmed.length, 0);
          const supp = r.report.flatMap((x) => x.suppressed).length;
          const resolved = r.report.flatMap((x) => x.resolved).length;
          const unver = r.report.flatMap((x) => x.unverified).length;
          jl(`${r.status} · new ${created} · updated ${other} · resolved ${resolved} · suppressed ${supp} · unverified(hidden) ${unver}`);
          for (const line of r.summary.split("\n")) jl(`  ${line.slice(0, 220)}`);
        }
      })
      .catch((err) => jl(`error: ${(err as Error).message}`))
      .finally(() => this.active.delete(jobId));
    this.active.set(jobId, p);
  }

  /** Jobs whose run was in flight when the previous process stopped. */
  async recover(shouldStop: () => boolean): Promise<void> {
    const repo = repoIdentity(this.cfg.repoRoot);
    for (const j of this.db.prepare("SELECT * FROM jobs WHERE status IN ('starting','running') ORDER BY id").all() as unknown as JobRow[]) {
      if (j.session_id && this.inv.runtime !== "local-claude") {
        this.say(`recovering ${fmtJob(j)} (session ${j.session_id})`);
        updateJob(this.db, j.id, { status: "running" });
        this.launch(j.id, shouldStop);
        continue;
      }
      let orphan: string | null = null;
      if (this.inv.runtime !== "local-claude") {
        try {
          orphan = await this.inv.findOrphan(j.id, repo.repoId);
        } catch (e) {
          this.say(`orphan lookup failed for ${fmtJob(j)}: ${(e as Error).message}`);
        }
      }
      if (orphan) {
        this.say(`recovering ${fmtJob(j)}: found session ${orphan} created before the crash`);
        updateJob(this.db, j.id, { status: "running", session_id: orphan });
        this.launch(j.id, shouldStop);
      } else {
        this.say(`requeueing ${fmtJob(j)} (its run did not survive the restart)`);
        updateJob(this.db, j.id, { status: "queued", reserved_cents: 0, session_id: null });
      }
    }
  }

  /** One scheduling pass. Launches at most `slots` runs; returns how many it launched. */
  tick(o: { slots: number; paused: boolean; shouldStop: () => boolean }): number {
    const { db, cfg } = this;
    expireDeferrals(db);
    // Never replay old history as new work (e.g. after the daemon was down for a day).
    const stale = db.prepare("UPDATE events SET consumed = 1 WHERE consumed = 0 AND ts_ms < ?").run(Date.now() - cfg.staleEventHours * 3600_000);
    if (Number(stale.changes)) this.say(`dropped ${stale.changes} event(s) older than ${cfg.staleEventHours} h`);
    // review_work off (the default): events stay recorded, unconsumed, as context, but no automatic review is planned
    // or started and nothing is spent on one. A review the developer asks for (`assess`, `onboard`) picks them up;
    // the stale cutoff above keeps them from being replayed later if reviews are turned on.
    const auto = cfg.reviewWork;

    const pending = auto ? pendingEvents(db) : [];
    let plan = planJobs(Date.now(), pending, cfg);
    if (plan.probe.length) {
      // Did files change without Edit/Write events (sed, codegen, git apply)? Compare a cheap git fingerprint
      // with the one recorded at the last assessment. The first probe only records a baseline.
      const fp = worktreeFingerprint(cfg.repoRoot);
      const last = kvGet<string | null>(db, "tree_fp", null);
      if (last === null) kvSet(db, "tree_fp", fp);
      const prompts = pending.filter((e) => e.kind === "prompt" && Date.now() - e.ts_ms < PROMPT_CONTEXT_MS).map((e) => e.id);
      plan = resolveProbe(plan, last !== null && fp !== last, prompts);
    }
    if (plan.jobs.length || plan.consumeOnly.length) {
      const ids = applyPlan(db, plan);
      for (const j of plan.jobs) this.say(`batched ${j.eventIds.length} event(s) -> ${j.kind} job #${ids[plan.jobs.indexOf(j)]} (trigger ${j.trigger})`);
    } else if (plan.waiting && plan.waiting !== this.lastWaiting) this.say(plan.waiting);
    this.lastWaiting = plan.waiting ?? "";

    this.blocked = false;
    const hold = kvGet<{ until: string; reason: string } | null>(db, "quota_hold", null);
    const held = !!hold && Date.parse(hold.until) > Date.now();
    if (held) {
      this.blocked = true;
      const msg = `usage-limit hold until ${hold!.until}: ${hold!.reason}`;
      if (msg !== this.lastBlocked) this.say(`${msg}. Events keep queueing.`);
      this.lastBlocked = msg;
      return 0;
    } else if (hold) kvSet(db, "quota_hold", null);
    if (o.paused || kvGet<boolean>(db, "paused", false)) return 0;

    let launched = 0;
    const queued = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id").all() as unknown as JobRow[];
    for (const j of queued) {
      if (launched >= o.slots) break;
      if (!auto && (j.kind === "checkpoint" || j.kind === "intent")) continue;
      // Automatic checkpoints are spaced out per repository; the queued job keeps absorbing new events meanwhile.
      if (j.kind === "checkpoint" || j.kind === "intent") {
        const last = (db.prepare("SELECT MAX(started_at) AS t FROM jobs WHERE kind IN ('checkpoint','intent') AND started_at IS NOT NULL").get() as { t: string | null }).t;
        const wait = last ? Date.parse(last) + cfg.minRunIntervalMin * 60_000 - Date.now() : 0;
        if (wait > 0) {
          const msg = `next automatic review in ${Math.ceil(wait / 1000)}s (min interval ${cfg.minRunIntervalMin} min)`;
          if (msg.replace(/\d+s/, "") !== this.lastBlocked.replace(/\d+s/, "")) this.say(msg);
          this.lastBlocked = msg;
          continue;
        }
      }
      // Gate here (cheap, local) so a budget-blocked job never starts a snapshot.
      const budget = planRunBudget(db, cfg, j.depth === "deep" ? "deep" : "quick");
      if (!budget.ok) {
        this.blocked = true;
        kvSet(db, "blocked_reason", { job: j.id, reason: budget.reason, at: new Date().toISOString() });
        if (budget.reason !== this.lastBlocked) this.say(`budget gate: job #${j.id} held - ${budget.reason}. Raise with \`pilot budget set <cents>\`.`);
        this.lastBlocked = budget.reason;
        break;
      }
      this.lastBlocked = "";
      this.launch(j.id, o.shouldStop);
      launched++;
    }
    return launched;
  }

  /** Nothing running, nothing runnable, nothing about to be planned. */
  idle(paused: boolean): boolean {
    if (this.active.size) return false;
    const queued = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'${this.cfg.reviewWork ? "" : " AND kind NOT IN ('checkpoint','intent')"}`).get() as { n: number }).n,
    );
    if (!this.cfg.reviewWork) return queued === 0 || paused || this.blocked || kvGet<boolean>(this.db, "paused", false);
    const future = planJobs(Date.now() + Math.max(this.cfg.quietMs, this.cfg.promptQuietMs) + 1, pendingEvents(this.db), this.cfg).jobs.length;
    if (future) return false;
    return queued === 0 || paused || this.blocked || kvGet<boolean>(this.db, "paused", false);
  }

  async stopRuns(interrupt: boolean): Promise<void> {
    if (!this.active.size) return;
    if (interrupt && this.inv.runtime === "live") {
      this.say(`stop requested: interrupting ${this.active.size} running session(s)`);
      await Promise.race([Promise.allSettled([...this.active.values()]), sleep(90_000)]);
    } else if (this.inv.runtime !== "live") {
      // A local run cannot outlive its scheduler (nobody would read its result): stop it; it is requeued on restart.
      this.say(`stop requested: stopping ${this.active.size} local run(s)`);
      await this.inv.stopAll?.();
      await Promise.race([Promise.allSettled([...this.active.values()]), sleep(15_000)]);
    } else this.say(`stop requested: leaving ${this.active.size} hosted session(s) running; results are collected next time`);
  }
}

/** One repository in the foreground. */
export async function watch(cfg: Config, inv: Investigator, o: WatchOptions): Promise<void> {
  const w = new RepoWatcher(cfg, inv, o.log);
  const holder = w.acquire();
  if (holder) throw new Error(`another Pilot process is scheduling this repository (pid ${holder.pid}); use \`pilot stop\` first`);
  kvSet(w.db, "stop_requested", null);
  const stopMode = () => kvGet<{ mode: string } | null>(w.db, "stop_requested", null)?.mode ?? null;
  const shouldStop = () => stopMode() === "interrupt";
  await w.recover(shouldStop);
  for (;;) {
    w.beat();
    const stop = stopMode();
    if (stop) {
      await w.stopRuns(stop === "interrupt");
      break;
    }
    w.tick({ slots: Math.max(0, cfg.maxConcurrent - w.active.size), paused: false, shouldStop });
    if (o.untilIdle && w.idle(false)) {
      const queued = Number((w.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").get() as { n: number }).n);
      if (queued && kvGet<boolean>(w.db, "paused", false)) o.log(`paused with ${queued} queued job(s); exiting (--until-idle)`);
      if (queued && w.blocked) o.log(`blocked with ${queued} queued job(s); exiting (--until-idle)`);
      break;
    }
    await sleep(cfg.pollMs);
  }
  w.release();
}

export interface DaemonOptions {
  log: (msg: string) => void;
  makeInvestigator: (cfg: Config, db: DB) => Promise<Investigator>;
  untilIdle?: boolean;
  /** Agent Engine polling: the Keychain and fetch to use (tests inject fakes), or false to never poll. */
  engine?: Partial<Pick<PollDeps, "keychain" | "fetch">> | false;
  /** Prompt watching (promptWatch.ts). Off unless asked for: `pilot daemon` turns it on. */
  promptWatch?: boolean;
  /** Runs the isolation self-test when it is missing or stale (prompt checks refuse to run without one). */
  ensureSelfTest?: (cfg: Config) => Promise<void>;
}

/** The machine-wide background process. */
export async function daemon(o: DaemonOptions): Promise<void> {
  const reg = openRegistry();
  const holder = (() => {
    reg.exec("BEGIN IMMEDIATE");
    try {
      const lock = kvGetReg<Lock | null>(reg, "daemon", null);
      if (lock && lock.pid !== process.pid && lockAlive(lock)) {
        reg.exec("COMMIT");
        return lock;
      }
      kvSetReg(reg, "daemon", me());
      reg.exec("COMMIT");
      return null;
    } catch (e) {
      reg.exec("ROLLBACK");
      throw e;
    }
  })();
  if (holder) {
    o.log(`Pilot daemon already running (pid ${holder.pid})`);
    return;
  }
  kvSetReg(reg, "daemon_stop", null);
  const log = (m: string) => o.log(m);
  log(`[${ts()}] Pilot daemon started (pid ${process.pid})`);
  const prompts = o.promptWatch ? new PromptWatcher(reg, (m) => log(`[${ts()}] ${m}`), o.ensureSelfTest) : null;
  const watchers = new Map<string, RepoWatcher | null>();
  const retryAt = new Map<string, number>(); // repos that could not be watched yet (locked elsewhere, init error)
  const stopMode = () => kvGetReg<{ mode: string } | null>(reg, "daemon_stop", null)?.mode ?? null;
  const shouldStop = () => stopMode() === "interrupt";
  let turn = 0;
  let lastBusy = Date.now();
  let enginePoll: Promise<void> | null = null;
  const pollEngineIfDue = () => {
    if (o.engine === false || enginePoll || !enginePollDue(reg)) return;
    const elog = (m: string) => log(`[${ts()}] Agent Engine: ${scrubKeys(m)}`);
    enginePoll = pollEngine({ reg, keychain: o.engine?.keychain ?? macKeychain(), fetch: o.engine?.fetch, log: elog })
      .then(() => undefined)
      .catch((e) => elog(`poll error - ${(e as Error).message}`))
      .finally(() => {
        enginePoll = null;
      });
  };
  for (;;) {
    kvSetReg(reg, "daemon", me());
    try {
      pollEngineIfDue();
    } catch (e) {
      log(`[${ts()}] Agent Engine: ${scrubKeys((e as Error).message)}`);
    }
    const stop = stopMode();
    const all = [...watchers.values()].filter((w): w is RepoWatcher => !!w);
    if (stop) {
      for (const w of all) await w.stopRuns(stop === "interrupt");
      await prompts?.stop();
      break;
    }
    const paused = kvGetReg<boolean>(reg, "paused", false);
    try {
      prompts?.tick(paused);
    } catch (e) {
      log(`[${ts()}] prompt watch: tick failed - ${(e as Error).message}`);
    }
    const repos = listRepos(reg)
      .filter((r) => !isExcluded(r.root))
      .sort((a, b) => a.key.localeCompare(b.key));
    for (const r of repos) {
      if (watchers.get(r.key)) continue;
      if (watchers.has(r.key) && Date.now() < (retryAt.get(r.key) ?? 0)) continue;
      try {
        const cfg = loadConfig(r.root, { cheap: true });
        const w = new RepoWatcher(cfg, await o.makeInvestigator(cfg, openDb(cfg.stateDir)), log, r.name);
        const held = w.acquire();
        if (held) {
          if (!watchers.has(r.key)) log(`[${ts()}] ${r.name}: scheduled by another process (pid ${held.pid}); retrying every minute`);
          watchers.set(r.key, null);
          retryAt.set(r.key, Date.now() + 60_000);
          continue;
        }
        await w.recover(shouldStop);
        watchers.set(r.key, w);
      } catch (e) {
        log(`[${ts()}] ${r.name}: cannot watch - ${(e as Error).message}; retrying in 5 min`);
        watchers.set(r.key, null);
        retryAt.set(r.key, Date.now() + 5 * 60_000);
      }
    }
    const live = repos.map((r) => watchers.get(r.key)).filter((w): w is RepoWatcher => !!w);
    let running = live.reduce((n, w) => n + w.active.size, 0);
    // Take repositories in turn: the starting point rotates every pass.
    for (let i = 0; i < live.length; i++) {
      const w = live[(turn + i) % live.length];
      w.beat();
      try {
        running += w.tick({ slots: Math.max(0, w.cfg.maxConcurrent - running), paused, shouldStop });
      } catch (e) {
        log(`[${ts()}] ${w.label}: tick failed - ${(e as Error).message}`);
      }
    }
    turn++;
    const busy = live.some((w) => !w.idle(paused)) || !!prompts?.busy();
    if (busy) lastBusy = Date.now();
    if (o.untilIdle && !busy) break;
    const base = live[0]?.cfg ?? loadConfig(pilotHome(), { cheap: true });
    const idleExit = base.daemonIdleExitMin;
    if (idleExit > 0 && Date.now() - lastBusy > idleExit * 60_000) {
      log(`[${ts()}] idle for ${idleExit} min; exiting (the next Claude Code session starts it again)`);
      break;
    }
    await sleep(base.pollMs);
  }
  if (enginePoll) await Promise.race([enginePoll, sleep(25_000)]);
  for (const w of watchers.values()) w?.release();
  const lock = kvGetReg<Lock | null>(reg, "daemon", null);
  if (lock?.pid === process.pid) kvSetReg(reg, "daemon", null);
  log(`[${ts()}] Pilot daemon stopped`);
}
