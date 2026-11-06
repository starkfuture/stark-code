/**
 * Runs one queued job end to end:
 *   budget gate -> working-tree snapshot -> stale marking -> context bundle -> investigation (hosted or
 *   labelled offline) -> grounded ingest -> notes -> spend ledger -> optional escalation.
 * Also resumes a job whose session was already created (crash, restart, laptop sleep).
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import type { DB, EventRow, JobRow } from "./db.ts";
import { getJob, kvSet, updateJob } from "./db.ts";
import { planRunBudget } from "./budget.ts";
import { ledgerForAgent, markStale, ingestSubmission, type IngestReport } from "./findings.ts";
import { BUNDLE_MOUNT, type Investigator, type QuotaHoldError } from "./investigator/index.ts";
import { checkpointMessage, onboardingBaselineMessage, onboardingComparisonMessage, type TaskContext } from "./investigator/prompt.ts";
import { getNotes, mergeNotes, saveNotes } from "./notes.ts";
import { enqueueJob } from "./scheduler.ts";
import { buildSnapshot, packBundle, readSnapshotFile, repoIdentity, saveSnapshot, worktreeFingerprint, type Snapshot } from "./snapshot.ts";
import { redact } from "./secrets.ts";
import { centsToUsd, nowIso, parseJson, truncate } from "./util.ts";
import { applySpeech } from "./deliver.ts";
import { capDiff, compactEvents } from "./context.ts";

export interface JobControls {
  shouldStop: () => boolean;
  log: (msg: string) => void;
}

export type RunResult =
  | { state: "blocked"; reason: string }
  | { state: "skipped"; reason: string }
  | { state: "finished"; status: string; report: IngestReport[]; costCents: number | null; costSource: string; summary: string };

const jobDir = (cfg: Config, id: number) => path.join(cfg.stateDir, "jobs", String(id));

function eventsForJob(db: DB, jobId: number) {
  const rows = db.prepare("SELECT * FROM events WHERE job_id = ? ORDER BY id").all(jobId) as unknown as EventRow[];
  return rows.map((r) => {
    const p = JSON.parse(r.payload);
    const label =
      r.kind === "prompt"
        ? "developer_prompt (explicit desired behaviour and constraints are requirements; implementation choices are proposals)"
        : r.kind === "stop"
          ? "coding_agent_report (claims: verify them)"
          : r.kind === "test"
            ? "test_run (as reported by the coding agent's tool call)"
            : r.kind === "edit"
              ? "file_edit"
              : r.kind;
    return { id: `ev${r.id}`, kind: r.kind, label, at: r.ts, head_at_capture: r.head, claude_code_session: r.cc_session, ...p };
  });
}

function eventsText(events: Array<Record<string, any>>, extra: string[] = []): string {
  const parts = events.flatMap((e) => [e.prompt, e.coding_agent_message, e.command, e.output_tail, e.new_preview].filter((x) => typeof x === "string"));
  return [...parts, ...extra].join("\n\n");
}

function loadSnapshotRecord(db: DB, cfg: Config, id: string, revision: string | null): Pick<Snapshot, "id" | "revision" | "fileHashes" | "stageDir"> | null {
  const row = db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as { id: string; revision: string; file_hashes: string } | undefined;
  if (!row) return null;
  // Snapshot ids are content hashes; the same content can be assessed at several commits, so the job's own
  // recorded revision wins over the first revision stored for this content.
  return { id: row.id, revision: revision ?? row.revision, fileHashes: parseJson(row.file_hashes, {}), stageDir: path.join(cfg.stateDir, "snapshots", row.id) };
}

const ACTIVE = "('queued','starting','running')";

/**
 * Which Claude Code session a finding belongs to: the session whose edits in this batch touched the finding's
 * files, else the session of the batch's latest turn. Findings are delivered only to that session.
 */
export function originSessionFor(db: DB, jobId: number): (paths: string[]) => string | null {
  // A deep run escalated from a checkpoint belongs to the checkpoint's session.
  let id: number | null = jobId;
  let rows: Array<{ kind: string; cc_session: string; payload: string }> = [];
  for (let hops = 0; id !== null && !rows.length && hops < 3; hops++) {
    rows = db.prepare("SELECT kind, cc_session, payload FROM events WHERE job_id = ? AND cc_session IS NOT NULL ORDER BY id").all(id) as typeof rows;
    id = (db.prepare("SELECT parent_job_id FROM jobs WHERE id = ?").get(id) as { parent_job_id: number | null } | undefined)?.parent_job_id ?? null;
  }
  const latest = [...rows].reverse().find((r) => r.kind === "stop" || r.kind === "edit")?.cc_session ?? rows.at(-1)?.cc_session ?? null;
  return (paths) => {
    const set = new Set(paths);
    const hit = [...rows].reverse().find((r) => r.kind === "edit" && set.has(String(parseJson<Record<string, unknown>>(r.payload, {}).path ?? "")));
    return hit?.cc_session ?? latest;
  };
}

export async function runJob(cfg: Config, db: DB, inv: Investigator, jobId: number, ctl: JobControls): Promise<RunResult> {
  let job = getJob(db, jobId) as JobRow;
  const resume = job.status === "running" && !!job.session_id;
  const input = parseJson<Record<string, any>>(job.input, {});
  const depth = job.depth === "deep" ? "deep" : "quick";
  const dir = jobDir(cfg, jobId);
  const repo = repoIdentity(cfg.repoRoot);

  let snap: Pick<Snapshot, "id" | "revision" | "fileHashes" | "stageDir">;
  let phases: string[];
  let evText: string;
  let match: { diff: string; approach: string };

  if (!resume) {
    // Atomic claim: only one watcher can move a queued job forward.
    if (Number(db.prepare("UPDATE jobs SET status = 'starting' WHERE id = ? AND status = 'queued'").run(jobId).changes) !== 1) {
      return { state: "skipped", reason: "job already claimed by another runner" };
    }
    const release = () => db.prepare("UPDATE jobs SET status = 'queued' WHERE id = ? AND status = 'starting'").run(jobId);
    const plan = planRunBudget(db, cfg, depth);
    if (!plan.ok) {
      release();
      kvSet(db, "blocked_reason", { job: jobId, reason: plan.reason, at: nowIso() });
      return { state: "blocked", reason: plan.reason };
    }
    kvSet(db, "blocked_reason", null);
    // Reserve before any slow work so concurrent planning sees this run's money as committed.
    updateJob(db, jobId, { budget_cents: plan.sessionBudgetCents, reserved_cents: plan.reserveCents });

    const pinned = (db.prepare(`SELECT DISTINCT snapshot_id FROM jobs WHERE snapshot_id IS NOT NULL AND status IN ${ACTIVE}`).all() as Array<{ snapshot_id: string }>).map((r) => r.snapshot_id);
    // Review what this batch of work changed, including commits made during it: diff against HEAD as it was
    // when the batch's first event was captured.
    const baseHead = (db.prepare("SELECT head FROM events WHERE job_id = ? AND head IS NOT NULL ORDER BY id LIMIT 1").get(jobId) as { head: string } | undefined)?.head ?? null;
    const edited = new Set(
      (db.prepare("SELECT payload FROM events WHERE kind = 'edit' AND job_id IN (?, ?)").all(jobId, job.parent_job_id ?? -1) as Array<{ payload: string }>)
        .map((r) => String(parseJson<Record<string, unknown>>(r.payload, {}).path ?? ""))
        .filter(Boolean),
    );
    const s = buildSnapshot(cfg, pinned, baseHead, cfg.snapshotUntracked === "all" || ["onboarding", "manual", "deep"].includes(job.kind) ? "all" : edited);
    saveSnapshot(db, s);
    kvSet(db, "tree_fp", worktreeFingerprint(cfg.repoRoot)); // baseline for detecting changes made outside Edit/Write
    const stale = markStale(db, s.fileHashes, s.revision, jobId);
    if (stale.length) ctl.log(`marked ${stale.length} finding(s) stale (evidence files changed): #${stale.join(", #")}`);

    // A batch whose review timed out is not retried automatically: a later automatic job that would review exactly
    // the same working tree is skipped. `pilot assess` retries it on purpose.
    if (["checkpoint", "intent"].includes(job.kind)) {
      const prior = db
        .prepare("SELECT id, status FROM jobs WHERE snapshot_id = ? AND id != ? AND status NOT IN ('queued','starting','running','skipped') ORDER BY id DESC LIMIT 1")
        .get(s.id, jobId) as { id: number; status: string } | undefined;
      if (prior?.status === "timed_out") {
        const why = `same work as job #${prior.id}, whose review timed out; not retried automatically (\`pilot assess\` retries it)`;
        updateJob(db, jobId, { status: "skipped", outcome: "skipped", snapshot_id: s.id, revision: s.revision, finished_at: nowIso(), summary: why });
        return { state: "skipped", reason: why };
      }
    }

    const events = eventsForJob(db, jobId);
    // No-op dedupe: nothing new to look at (same tree, no new prompt) and no stale findings to re-check.
    const last = db
      .prepare("SELECT snapshot_id FROM jobs WHERE status = 'done' AND id != ? AND kind IN ('intent','checkpoint','manual','deep') ORDER BY id DESC LIMIT 1")
      .get(jobId) as { snapshot_id: string } | undefined;
    const newEvidence = events.some((e) => e.kind === "prompt" || (e.kind === "test" && e.status === "failed"));
    if (["checkpoint", "intent"].includes(job.kind) && last?.snapshot_id === s.id && !newEvidence && !stale.length) {
      updateJob(db, jobId, { status: "skipped", outcome: "skipped", snapshot_id: s.id, revision: s.revision, finished_at: nowIso(), summary: `no change since last assessment (${s.id})` });
      return { state: "skipped", reason: `working tree unchanged since last assessment (${s.revision})` };
    }
    if (job.kind === "checkpoint" && !s.diffPatch.trim() && !stale.length) {
      updateJob(db, jobId, { status: "skipped", outcome: "skipped", snapshot_id: s.id, revision: s.revision, finished_at: nowIso(), summary: "nothing changed in this batch of work" });
      return { state: "skipped", reason: `no code change to review (${s.revision})` };
    }

    // Context files for the hosted agent.
    const ctxDir = path.join(dir, "context");
    fs.rmSync(ctxDir, { recursive: true, force: true });
    fs.mkdirSync(ctxDir, { recursive: true });
    const notes = getNotes(db);
    // Everything that leaves this machine is redacted, including developer-typed notes/approach text.
    const write = (name: string, data: unknown) =>
      fs.writeFileSync(path.join(ctxDir, name), redact(typeof data === "string" ? data : JSON.stringify(data, null, 2)).text);
    write("job.json", {
      job_id: jobId,
      kind: job.kind,
      depth,
      trigger: job.trigger,
      repository: { id: repo.repoId, name: repo.name, remote: repo.remote },
      revision: s.revision,
      head: s.head,
      branch: s.branch,
      uncommitted_changes: s.dirty,
      snapshot_id: s.id,
      created_at: s.createdAt,
      escalation_reason: input.reason ?? null,
    });
    write("notes.json", job.kind === "onboarding" ? { ...notes, proposed_solutions: notes.proposed_solutions.filter((i) => i.source !== "developer") } : notes);
    write("findings.json", ledgerForAgent(db, s.fileHashes));
    write("manifest.json", { ...s.manifest, note: "excluded files were never uploaded; redacted values were replaced in the copy you see" });
    if (job.kind !== "onboarding") {
      // Budgeted context: a digest of the batch (one entry per file, latest requests and claims), not every event.
      const digest = compactEvents(events as never);
      write("events.json", { activity: digest.activity, events: digest.events });
      const recentFiles = [...events].reverse().filter((e) => e.kind === "edit").map((e) => String(e.path));
      write("diff.patch", s.diffPatch ? capDiff(s.diffPatch, [...new Set(recentFiles)]) : "(no uncommitted changes against HEAD)");
    }

    const bundlePath = path.join(dir, "bundle.tgz");
    const bytes = packBundle(s, ctxDir, bundlePath);
    ctl.log(`snapshot ${s.id} rev ${s.revision}: ${s.manifest.included.length} files, ${s.manifest.excluded.length} excluded, bundle ${(bytes / 1024).toFixed(1)} KiB`);

    const tctx: TaskContext = { transport: inv.runtime === "local-claude" ? "local" : "managed", jobId, kind: job.kind, depth, trigger: job.trigger, revision: s.revision, snapshotId: s.id, bundleMount: BUNDLE_MOUNT, escalationReason: input.reason };
    const prompts = events.filter((e) => e.kind === "prompt").map((e) => redact(String(e.prompt)).text);
    const approach = redact(String(input.approach ?? "")).text;
    phases =
      job.kind === "onboarding"
        ? [onboardingBaselineMessage(tctx), onboardingComparisonMessage(tctx, approach, prompts)]
        : [checkpointMessage(tctx)];
    // Grounding corpus: this batch plus the repo's recent requests and agent messages (a finding re-reported later
    // may quote the request that started the work, which belongs to an earlier batch).
    const recent = (db.prepare("SELECT payload FROM events WHERE ts_ms >= ? AND kind IN ('prompt','stop') ORDER BY id").all(Date.now() - 24 * 3600_000) as Array<{ payload: string }>).map((r) => parseJson<Record<string, any>>(r.payload, {}));
    evText = eventsText([...events, ...recent], [approach, ...prompts]);
    match = { diff: s.diffPatch, approach };
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ phases, evText, match }));
    snap = s;

    updateJob(db, jobId, {
      started_at: nowIso(),
      snapshot_id: s.id,
      revision: s.revision,
      runtime: inv.runtime,
      attempt: job.attempt + 1,
    });
  } else {
    const saved = parseJson<{ phases: string[]; evText: string; match: { diff: string; approach: string } } | null>(
      fs.existsSync(path.join(dir, "run.json")) ? fs.readFileSync(path.join(dir, "run.json"), "utf8") : null,
      null,
    );
    const rec = job.snapshot_id ? loadSnapshotRecord(db, cfg, job.snapshot_id, job.revision) : null;
    if (!saved || !rec) throw new Error(`cannot resume job ${jobId}: run files or snapshot missing`);
    ({ phases, evText, match } = saved);
    snap = rec;
    ctl.log(`resuming session ${job.session_id} (rebuilding state from server event history)`);
  }

  job = getJob(db, jobId) as JobRow;
  const timeout = (depth === "deep" ? cfg.deepRunTimeoutSec : cfg.runTimeoutSec) * 1000;
  const deadline = (job.started_at ? Date.parse(job.started_at) : Date.now()) + timeout;
  const readFile = (rel: string) => readSnapshotFile(snap, rel);

  let outcome;
  try {
    outcome = await inv.run({
      jobId,
      repoRoot: cfg.repoRoot,
      kind: job.kind,
      depth,
      phases,
      bundlePath: path.join(dir, "bundle.tgz"),
      sessionBudgetCents: job.budget_cents ?? cfg.runBudgetCents,
      deadlineMs: deadline,
      title: `pilot ${repo.name} #${jobId} ${job.kind}`,
      metadata: { app: "lookout", lookout_job_id: String(jobId), lookout_repo: repo.repoId, revision: snap.revision, snapshot_id: snap.id },
      existingSessionId: job.session_id,
      match: { kind: job.kind, diff: match.diff, eventsText: evText, approach: match.approach, readFile },
      shouldStop: ctl.shouldStop,
      onUpload: (fileId) => {
        const ids = parseJson<string[]>(getJob(db, jobId)?.upload_ids, []);
        updateJob(db, jobId, { upload_ids: JSON.stringify([...ids, fileId]) });
      },
      onSessionCreated: (sessionId) => updateJob(db, jobId, { status: "running", session_id: sessionId }),
      log: ctl.log,
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const cur = getJob(db, jobId) as JobRow;
    if ((err as QuotaHoldError).quotaHold) {
      // Plan/subscription usage limit: the job is fine, the account is not available. Hold, do not fail.
      // Whatever this attempt already spent stays on the books.
      const until = new Date(Date.now() + cfg.quotaBackoffMin * 60_000).toISOString();
      kvSet(db, "quota_hold", { until, reason: msg, job: jobId });
      updateJob(db, jobId, {
        status: "queued",
        session_id: null,
        reserved_cents: 0,
        attempt: job.attempt,
        prior_cost_cents: cur.prior_cost_cents + ((err as QuotaHoldError).costCents ?? 0),
        error: `held: ${truncate(msg, 300)}`,
      });
      return { state: "blocked", reason: `usage limit: ${msg} - retrying after ${until}` };
    }
    const sessionStarted = !!cur.session_id;
    updateJob(db, jobId, {
      status: sessionStarted ? "failed" : "queued",
      error: truncate(msg, 2000),
      // A session that started may have spent up to its cap and may still be running: book the cap (upper bound).
      ...(sessionStarted
        ? { finished_at: nowIso(), list_cost_cents: cur.budget_cents, cost_source: inv.runtime === "live" ? "platform-upper-bound" : "subscription-upper-bound" }
        : { reserved_cents: 0 }),
    });
    if (!sessionStarted && job.attempt + 1 >= 3) updateJob(db, jobId, { status: "failed", finished_at: nowIso() });
    throw err;
  }

  // Audit trail: what the review actually ran (commands + output excerpts), kept with the job, private to this machine.
  try {
    fs.writeFileSync(path.join(dir, "toollog.json"), JSON.stringify(outcome.drive.toolLog.map((t) => ({ command: t.command, output: truncate(t.output ?? "", 4000), isError: t.isError })), null, 1), { mode: 0o600 });
  } catch {
    /* best effort */
  }
  const status = { completed: "done", budget_reached: "budget_reached", timed_out: "timed_out", stopped: "cancelled", failed: "failed", terminated: "failed" }[outcome.drive.status];
  const summary = outcome.drive.submissions.map((s) => `[${s.phase}] ${s.findings.length} finding(s): ${s.summary}`).join("\n") || outcome.drive.reason || "no submission";
  // Unknown cost for a run that did not finish cleanly: book its cap as an upper bound.
  const unknownCost = outcome.listCostCents === null && status !== "done" && outcome.runtime !== "offline-fixture";
  updateJob(db, jobId, {
    status,
    outcome: outcome.drive.status,
    finished_at: nowIso(),
    session_id: outcome.sessionId,
    list_cost_cents: unknownCost ? job.budget_cents : outcome.listCostCents,
    cost_source: unknownCost ? (outcome.runtime === "live" ? "platform-upper-bound" : "subscription-upper-bound") : outcome.costSource,
    usage: JSON.stringify({ ...(outcome.usage ?? {}), denied_tool_asks: outcome.drive.deniedAsks, invalid_submissions: outcome.drive.invalidSubmissions, errors: outcome.drive.errors, fixture: outcome.fixture }),
    summary: truncate(summary, 4000),
    error: outcome.drive.reason && status !== "done" ? outcome.drive.reason : null,
  });

  // Grounded ingest of every accepted submission (idempotent via fingerprints if a resumed run repeats).
  const reports: IngestReport[] = [];
  const fresh = getJob(db, jobId) as JobRow;
  if (!fresh.ingested) {
    try {
      const originSession = originSessionFor(db, jobId);
      let notes = getNotes(db);
      for (const sub of outcome.drive.submissions) {
        reports.push(
          ingestSubmission(db, sub, {
            jobId,
            revision: snap.revision,
            fileHashes: snap.fileHashes,
            runtime: outcome.runtime,
            readFile,
            toolLog: outcome.drive.toolLog,
            toolLogTrusted: outcome.runtime !== "offline-fixture", // a live/local run's own transcript; fixtures are not evidence
            eventsText: evText,
            originSession,
          }),
        );
        notes = mergeNotes(notes, sub.notes_update, `job ${jobId} (${sub.phase})`);
      }
      if (outcome.drive.submissions.length) saveNotes(db, notes, jobId);
      updateJob(db, jobId, { ingested: 1 });
      const touched = [...new Set(reports.flatMap((r) => [...r.created, ...r.updated, ...r.reopened, ...r.reconfirmed]))];
      const decided = applySpeech(db, cfg, touched);
      for (const [id, d] of decided) ctl.log(`#${id}: ${d.action === "speak" ? "will tell the session" : d.action} - ${d.why}`);
    } catch (err) {
      updateJob(db, jobId, { status: "failed", error: `ingest failed: ${truncate((err as Error).message, 500)}` });
      ctl.log(`ingest failed: ${(err as Error).message}`);
    }
  }

  if (cfg.deleteUploads) {
    const ids = parseJson<string[]>(getJob(db, jobId)?.upload_ids, []);
    if (ids.length) await inv.deleteUploads(ids);
  }

  // Escalation: a quick pass may ask for one deeper, budgeted investigation.
  const esc = outcome.drive.submissions.find((s) => s.escalate?.needed);
  if (esc && depth === "quick" && cfg.autoDeep && status === "done") {
    const child = db.prepare("SELECT id FROM jobs WHERE parent_job_id = ?").get(jobId);
    if (!child) {
      const id = enqueueJob(db, "deep", "deep", "escalation", { reason: esc.escalate?.reason ?? "unspecified" }, jobId);
      ctl.log(`escalation requested: queued deep job #${id} (${esc.escalate?.reason ?? ""})`);
    }
  }

  ctl.log(`cost ${centsToUsd(outcome.listCostCents)} (${outcome.costSource})${outcome.consoleUrl ? ` · ${outcome.consoleUrl}` : ""}`);
  return { state: "finished", status, report: reports, costCents: outcome.listCostCents, costSource: outcome.costSource, summary };
}
