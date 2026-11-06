/**
 * Findings ledger: grounding verification, dedupe, developer decisions, dismissal memory, stale detection.
 */
import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.ts";
import { tx } from "./db.ts";
import type { EvidenceItem, Proof, Submission, SubmittedFinding } from "./investigator/types.ts";
import type { ToolLogEntry } from "./investigator/sessionDriver.ts";
import { MIN_EVIDENCE_CHARS, toolLogContains } from "./investigator/sessionDriver.ts";
import { sha256, jaccard, kebab, normalizeWs, nowIso, parseJson, tokens } from "./util.ts";

export type FindingStatus = "open" | "accepted" | "dismissed" | "deferred" | "resolved" | "stale" | "unverified";

export interface FindingRow {
  id: number;
  fingerprint: string;
  kind: string;
  category: string;
  title: string;
  statement: string;
  why_it_matters: string;
  evidence: string;
  grounding: string;
  confidence: number | null;
  uncertainty: string | null;
  next_action: string | null;
  handoff_prompt: string | null;
  related_paths: string;
  path_hashes: string;
  revision: string;
  first_revision: string;
  first_job_id: number | null;
  last_job_id: number | null;
  seen_count: number;
  suppressed_count: number;
  status: FindingStatus;
  prev_status: string | null;
  status_reason: string | null;
  decision_note: string | null;
  decided_at: string | null;
  decision_path_hashes: string | null;
  defer_until: string | null;
  runtime: string;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  delivered_session: string | null;
  severity: string | null;
  attribution: string | null;
  proof: string | null;
  awareness: string | null;
  risk_areas: string | null;
  failure_case: string | null;
  controls_checked: string | null;
  origin_session: string | null;
  speak: string | null;
}

export interface Grounding {
  status: "grounded" | "partial" | "ungrounded";
  verified: number;
  checks: Array<{ index: number; result: "verified" | "failed" | "unverifiable"; detail: string }>;
}

export interface GroundingContext {
  readFile: (rel: string) => string | null; // the redacted snapshot copy the agent saw
  toolLog: ToolLogEntry[];
  toolLogTrusted: boolean; // only a live session's own transcript counts as evidence of an experiment
  eventsText: string;
}

const PATH_PREFIXES = [/^\/workspace\/review\/repo\//, /^\/workspace\/repo\//, /^\/mnt\/session\/uploads\/[^/]+\/repo\//, /^repo\//, /^\.\//];
export function normalizePath(p: string): string {
  let out = p.trim();
  for (const re of PATH_PREFIXES) out = out.replace(re, "");
  return out;
}

function quoteFound(haystack: string, quote: string): boolean {
  const h = normalizeWs(haystack);
  const pieces = normalizeWs(quote)
    .split(/\s*(?:\.\.\.|…)\s*/)
    .filter(Boolean);
  if (!pieces.length) return false;
  let from = 0;
  for (const p of pieces) {
    const at = h.indexOf(p, from);
    if (at < 0) return false;
    from = at + p.length;
  }
  return true;
}

/**
 * Mechanical check that each evidence item exists where the finding says it does.
 * This is what separates "grounded" from "plausible": quotes must appear verbatim in the snapshot,
 * experiments must appear in the session's own tool transcript.
 */
export function verifyGrounding(f: SubmittedFinding, ctx: GroundingContext): Grounding {
  const checks: Grounding["checks"] = [];
  f.evidence.forEach((e: EvidenceItem, index) => {
    if (e.type === "file") {
      const rel = normalizePath(e.path ?? "");
      const content = ctx.readFile(rel);
      if (content === null) return checks.push({ index, result: "failed", detail: `${rel}: not in snapshot` });
      if (!e.quote) return checks.push({ index, result: "unverifiable", detail: `${rel}: no quote` });
      if (normalizeWs(e.quote).replace(/\s/g, "").length < MIN_EVIDENCE_CHARS)
        return checks.push({ index, result: "unverifiable", detail: `${rel}: quote too short to identify code` });
      const lines = content.split("\n");
      if (e.line_start && e.line_start > 0) {
        const lo = Math.max(0, e.line_start - 4);
        const hi = Math.min(lines.length, (e.line_end ?? e.line_start) + 3);
        if (quoteFound(lines.slice(lo, hi).join("\n"), e.quote))
          return checks.push({ index, result: "verified", detail: `${rel}:${e.line_start} quote matches` });
      }
      if (quoteFound(content, e.quote))
        return checks.push({ index, result: "verified", detail: `${rel}: quote found${e.line_start ? " (cited line range off)" : ""}` });
      return checks.push({ index, result: "failed", detail: `${rel}: quote not found` });
    }
    if (e.type === "command") {
      if (!ctx.toolLogTrusted) return checks.push({ index, result: "unverifiable", detail: "no trusted sandbox transcript (offline)" });
      return toolLogContains(ctx.toolLog, e.command ?? "", e.output_excerpt ?? "")
        ? checks.push({ index, result: "verified", detail: "command + output found in session transcript" })
        : checks.push({ index, result: "failed", detail: "command/output not found in session transcript" });
    }
    if (e.type === "event") {
      if (normalizeWs(e.quote ?? "").replace(/\s/g, "").length < MIN_EVIDENCE_CHARS)
        return checks.push({ index, result: "unverifiable", detail: "event quote too short" });
      return quoteFound(ctx.eventsText, e.quote ?? "")
        ? checks.push({ index, result: "verified", detail: "quote found in development events" })
        : checks.push({ index, result: "failed", detail: "quote not found in development events" });
    }
    checks.push({ index, result: "unverifiable", detail: `unknown evidence type ${(e as EvidenceItem).type}` });
  });
  const verified = checks.filter((c) => c.result === "verified").length;
  const failed = checks.filter((c) => c.result === "failed").length;
  return { status: verified === 0 ? "ungrounded" : failed ? "partial" : "grounded", verified, checks };
}

/**
 * Proof as established by the evidence, not as claimed.
 *  - A quote of code, docs or a prompt that does not verify makes the whole finding unconfirmed: it misstates
 *    what is there.
 *  - "reproduced" needs every cited command found, with its output, in this run's own transcript. A command
 *    excerpt that does not verify (often paraphrased output) only costs the "reproduced" label: the finding then
 *    rests on its verified source quotes ("source_proven"), if it has any.
 */
export function checkedProof(claimed: Proof, f: Pick<SubmittedFinding, "evidence">, g: Grounding): Proof {
  const bad = (type: string) => g.checks.some((c) => c.result !== "verified" && f.evidence[c.index]?.type === type);
  const ok = (type: string) => g.checks.some((c) => c.result === "verified" && f.evidence[c.index]?.type === type);
  if (bad("file") || bad("event")) return "unconfirmed";
  if (claimed === "reproduced" && ok("command") && !bad("command")) return "reproduced";
  if (claimed !== "unconfirmed" && ok("file")) return "source_proven";
  return "unconfirmed";
}

export function evidencePaths(f: { evidence: EvidenceItem[]; related_paths: string[] }): string[] {
  const ps = [...f.related_paths, ...f.evidence.filter((e) => e.type === "file" && e.path).map((e) => e.path as string)];
  return [...new Set(ps.map(normalizePath).filter(Boolean))].sort();
}

export function hashesFor(paths: string[], fileHashes: Record<string, string>): Record<string, string> {
  return Object.fromEntries(paths.map((p) => [p, fileHashes[p] ?? "missing"]));
}

/** Hash the live working tree (used when the developer records a decision between runs). */
export function workingTreeHashes(repoRoot: string, paths: string[]): Record<string, string> {
  return Object.fromEntries(
    paths.map((p) => {
      try {
        return [p, sha256(fs.readFileSync(path.join(repoRoot, p)))];
      } catch {
        return [p, "missing"];
      }
    }),
  );
}

const changedPaths = (a: Record<string, string>, b: Record<string, string>): string[] =>
  Object.keys(a).filter((p) => b[p] !== undefined && a[p] !== b[p]);

function history(db: DB, findingId: number, jobId: number | null, action: string, note?: string) {
  db.prepare("INSERT INTO finding_history(finding_id, ts, job_id, action, note) VALUES (?, ?, ?, ?, ?)").run(findingId, nowIso(), jobId, action, note ?? null);
}

function findMatch(db: DB, f: SubmittedFinding, fp: string): FindingRow | undefined {
  const exact = db.prepare("SELECT * FROM findings WHERE fingerprint = ?").get(fp) as FindingRow | undefined;
  if (exact) return exact;
  // Fuzzy: same issue reported under a new fingerprint (similar wording and overlapping files).
  const rows = db.prepare("SELECT * FROM findings").all() as unknown as FindingRow[];
  const t = tokens(`${f.title} ${f.statement}`);
  const fPaths = new Set(evidencePaths(f));
  let best: { row: FindingRow; score: number } | undefined;
  for (const r of rows) {
    const score = jaccard(t, tokens(`${r.title} ${r.statement}`));
    const rPaths = parseJson<string[]>(r.related_paths, []);
    const overlap = !rPaths.length || !fPaths.size || rPaths.some((p) => fPaths.has(p));
    if (score >= 0.55 && overlap && (!best || score > best.score)) best = { row: r, score };
  }
  return best?.row;
}

export interface IngestContext extends GroundingContext {
  jobId: number;
  revision: string;
  fileHashes: Record<string, string>;
  runtime: string;
  /** The Claude Code session whose work produced this finding (delivery goes only there). */
  originSession?: (paths: string[]) => string | null;
}

export interface IngestReport {
  created: number[];
  updated: number[];
  reopened: number[];
  suppressed: number[];
  resolved: number[];
  reconfirmed: number[];
  unverified: number[];
}

export function ingestSubmission(db: DB, sub: Submission, ctx: IngestContext): IngestReport {
  const rep: IngestReport = { created: [], updated: [], reopened: [], suppressed: [], resolved: [], reconfirmed: [], unverified: [] };
  const now = nowIso();
  tx(db, () => {
    for (const f of sub.findings) {
      const fp = kebab(f.fingerprint) || kebab(f.title);
      const g = verifyGrounding(f, ctx);
      const paths = evidencePaths(f);
      const hashes = hashesFor(paths, ctx.fileHashes);
      const existing = findMatch(db, f, fp);
      const proof = checkedProof(f.proof, f, g);
      const common = {
        kind: f.issue_type,
        severity: f.severity,
        attribution: f.attribution,
        proof,
        awareness: f.session_awareness,
        risk_areas: JSON.stringify(f.risk_areas ?? []),
        failure_case: f.failure_case.slice(0, 2000),
        controls_checked: f.controls_checked.slice(0, 2000),
        category: f.category,
        title: f.title.slice(0, 200),
        statement: f.statement.slice(0, 4000),
        why_it_matters: f.why_it_matters.slice(0, 2000),
        evidence: JSON.stringify(f.evidence),
        grounding: JSON.stringify(g),
        confidence: Math.max(0, Math.min(1, f.confidence)),
        uncertainty: f.uncertainty.slice(0, 2000),
        next_action: f.suggested_next_action.slice(0, 2000),
        handoff_prompt: f.handoff_prompt?.slice(0, 4000) ?? null,
        related_paths: JSON.stringify(paths),
        path_hashes: JSON.stringify(hashes),
        revision: ctx.revision,
        last_job_id: ctx.jobId,
        runtime: ctx.runtime,
        updated_at: now,
      };
      const origin = ctx.originSession?.(paths) ?? null;
      if (!existing) {
        const status: FindingStatus = g.status === "ungrounded" ? "unverified" : "open";
        const fields: Record<string, unknown> = {
          fingerprint: fp,
          ...common,
          first_revision: ctx.revision,
          first_job_id: ctx.jobId,
          status,
          status_reason: status === "unverified" ? "no evidence item could be verified against the snapshot/transcript" : null,
          origin_session: origin,
          created_at: now,
        };
        const keys = Object.keys(fields);
        const r = db.prepare(`INSERT INTO findings(${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => fields[k] as never));
        const id = Number(r.lastInsertRowid);
        history(db, id, ctx.jobId, status === "unverified" ? "created-unverified" : "created", `grounding=${g.status}; proof claimed ${f.proof}, checked ${proof}`);
        (status === "unverified" ? rep.unverified : rep.created).push(id);
        continue;
      }

      // Existing issue: decide based on the developer's last decision.
      if (existing.status === "dismissed" || existing.status === "deferred") {
        const decisionHashes = parseJson<Record<string, string>>(existing.decision_path_hashes, {});
        // Relevant evidence change = a file the decision was based on changed AND either the code it quoted is
        // gone/different, or the new report brings a verified quote that was not part of the decided evidence.
        // Comment-only edits elsewhere in the file, extra citations of unchanged code, or the agent merely
        // asserting "new evidence" do not reopen a decision.
        const changed = changedPaths(decisionHashes, hashesFor(Object.keys(decisionHashes), ctx.fileHashes));
        const stored = parseJson<EvidenceItem[]>(existing.evidence, []);
        const storedFileIdx = stored.map((e, i) => (e.type === "file" ? i : -1)).filter((i) => i >= 0);
        const storedCheck = verifyGrounding({ ...f, evidence: stored }, { ...ctx, toolLogTrusted: false, eventsText: "" });
        const storedQuoteBroken = storedCheck.checks.some((c) => storedFileIdx.includes(c.index) && c.result === "failed");
        const key = (e: EvidenceItem) => `${normalizePath(e.path ?? "")}\0${normalizeWs(e.quote ?? "")}`;
        const storedKeys = new Set(storedFileIdx.map((i) => key(stored[i])));
        const newVerifiedQuote = g.checks.some((c) => c.result === "verified" && f.evidence[c.index].type === "file" && !storedKeys.has(key(f.evidence[c.index])));
        if (!changed.length || !(storedQuoteBroken || newVerifiedQuote)) {
          db.prepare("UPDATE findings SET suppressed_count = suppressed_count + 1, last_job_id = ?, updated_at = ? WHERE id = ?").run(ctx.jobId, now, existing.id);
          history(db, existing.id, ctx.jobId, "suppressed", `re-raised without relevant evidence change (developer ${existing.status} it${changed.length ? `; ${changed.join(", ")} changed but not the cited code` : ""})`);
          rep.suppressed.push(existing.id);
          continue;
        }
        const reason = `reopened: evidence changed since ${existing.status} (${changed.join(", ")})`;
        updateFinding(db, existing.id, { ...common, status: g.status === "ungrounded" ? "unverified" : "open", prev_status: existing.status, status_reason: reason, seen_count: existing.seen_count + 1, delivered_at: null, origin_session: origin ?? existing.origin_session });
        history(db, existing.id, ctx.jobId, "reopened", `${reason}${f.new_evidence_since_dismissal ? `; agent: ${f.new_evidence_since_dismissal}` : ""}`);
        rep.reopened.push(existing.id);
        continue;
      }
      let status: FindingStatus = existing.status;
      let reason = existing.status_reason;
      if (existing.status === "resolved") {
        status = "open";
        reason = "regression: re-raised after being resolved";
      } else if (existing.status === "stale") {
        status = (existing.prev_status as FindingStatus) || "open";
        reason = "re-confirmed at new revision";
      } else if (existing.status === "unverified" && g.status !== "ungrounded") {
        status = "open";
        reason = "now grounded";
      }
      if (g.status === "ungrounded" && existing.status !== "unverified") {
        // Keep the previous grounded evidence; record the weak re-report only.
        db.prepare("UPDATE findings SET seen_count = seen_count + 1, last_job_id = ?, updated_at = ? WHERE id = ?").run(ctx.jobId, now, existing.id);
        history(db, existing.id, ctx.jobId, "seen-ungrounded", "re-reported without verifiable evidence; kept previous evidence");
        rep.updated.push(existing.id);
        continue;
      }
      updateFinding(db, existing.id, {
        ...common,
        fingerprint: existing.fingerprint,
        status,
        status_reason: reason,
        seen_count: existing.seen_count + 1,
        ...(existing.status === "resolved" ? { delivered_at: null } : {}), // a regression is pushed to the session again
        ...(!existing.delivered_at && origin ? { origin_session: origin } : {}),
      });
      history(db, existing.id, ctx.jobId, existing.status === "stale" ? "reconfirmed" : "updated", `grounding=${g.status}; ${f.issue_type}/${f.severity}/${f.attribution}; proof ${proof}`);
      (existing.status === "stale" ? rep.reconfirmed : existing.status === "resolved" ? rep.reopened : rep.updated).push(existing.id);
    }

    for (const r of sub.resolved ?? []) {
      const row = db.prepare("SELECT * FROM findings WHERE fingerprint = ?").get(kebab(r.fingerprint)) as FindingRow | undefined;
      if (!row || row.status === "resolved" || row.status === "dismissed") continue;
      updateFinding(db, row.id, { status: "resolved", prev_status: row.status, status_reason: `resolved at ${ctx.revision}: ${r.reason}`.slice(0, 1000), last_job_id: ctx.jobId, updated_at: now });
      history(db, row.id, ctx.jobId, "resolved", r.reason);
      rep.resolved.push(row.id);
    }
    for (const fpRaw of sub.still_valid ?? []) {
      const row = db.prepare("SELECT * FROM findings WHERE fingerprint = ?").get(kebab(fpRaw)) as FindingRow | undefined;
      if (!row || row.status !== "stale") continue;
      if (rep.reconfirmed.includes(row.id) || rep.updated.includes(row.id)) continue; // already re-reported with evidence
      // "Still valid" is only accepted if the stored file evidence still verifies at this revision.
      const stored = parseJson<EvidenceItem[]>(row.evidence, []);
      const regrounded = verifyGrounding(
        { ...placeholderFinding(row.fingerprint, row.title, row.statement), evidence: stored },
        { ...ctx, toolLogTrusted: false },
      );
      const fileChecks = regrounded.checks.filter((c) => stored[c.index]?.type === "file");
      if (!fileChecks.some((c) => c.result === "verified") || fileChecks.some((c) => c.result === "failed")) {
        db.prepare("UPDATE findings SET status_reason = ?, updated_at = ? WHERE id = ?").run(
          `agent says still valid, but its cited code no longer matches at ${ctx.revision}; needs a re-report with current evidence`,
          now,
          row.id,
        );
        history(db, row.id, ctx.jobId, "reconfirm-rejected", "stored evidence does not verify at the new revision");
        continue;
      }
      const paths = parseJson<string[]>(row.related_paths, []);
      updateFinding(db, row.id, {
        grounding: JSON.stringify(regrounded),
        status: (row.prev_status as FindingStatus) || "open",
        status_reason: `re-confirmed at ${ctx.revision}`,
        path_hashes: JSON.stringify(hashesFor(paths, ctx.fileHashes)),
        revision: ctx.revision,
        last_job_id: ctx.jobId,
        updated_at: now,
      });
      history(db, row.id, ctx.jobId, "reconfirmed", "agent re-checked stale finding");
      rep.reconfirmed.push(row.id);
    }
  });
  return rep;
}

function placeholderFinding(fingerprint: string, title: string, statement: string): SubmittedFinding {
  return {
    fingerprint, issue_type: "defect", severity: "low", attribution: "pre_existing", proof: "unconfirmed", session_awareness: "unaware", risk_areas: [],
    category: "risk", title, statement, failure_case: "", controls_checked: "", why_it_matters: "", evidence: [], confidence: 0, uncertainty: "",
    suggested_next_action: "", related_paths: [],
  };
}

function updateFinding(db: DB, id: number, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE findings SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => fields[k] as never), id);
}

/**
 * Mark findings stale when the files their evidence points at changed since they were last confirmed.
 * Stale findings are re-verified by the next assessment (still_valid / resolved) instead of being trusted.
 */
export function markStale(db: DB, fileHashes: Record<string, string>, revision: string, jobId: number | null): number[] {
  const rows = db.prepare("SELECT * FROM findings WHERE status IN ('open','accepted','deferred')").all() as unknown as FindingRow[];
  const stale: number[] = [];
  for (const r of rows) {
    const prev = parseJson<Record<string, string>>(r.path_hashes, {});
    const changed = Object.keys(prev).filter((p) => (fileHashes[p] ?? "missing") !== prev[p]);
    if (!changed.length) continue;
    if (r.status === "deferred") {
      // Deferred items come back to the developer when their evidence moves.
      updateFinding(db, r.id, { status: "stale", prev_status: "open", status_reason: `deferred finding's files changed at ${revision}: ${changed.join(", ")}`, updated_at: nowIso() });
    } else {
      updateFinding(db, r.id, { status: "stale", prev_status: r.status, status_reason: `evidence files changed since ${r.revision}: ${changed.join(", ")}`, updated_at: nowIso() });
    }
    history(db, r.id, jobId, "stale", `changed: ${changed.join(", ")} (now ${revision})`);
    stale.push(r.id);
  }
  return stale;
}

export type Decision = "accept" | "dismiss" | "defer" | "reopen";

export function decide(db: DB, repoRoot: string, id: number, action: Decision, note: string, deferUntil?: string): FindingRow {
  const row = db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as FindingRow | undefined;
  if (!row) throw new Error(`No finding #${id}`);
  if (action !== "reopen" && !note.trim()) throw new Error("A reason is required (-m \"...\"): it is shown to the lookout on later runs.");
  const paths = parseJson<string[]>(row.related_paths, []);
  const status: FindingStatus = action === "accept" ? "accepted" : action === "dismiss" ? "dismissed" : action === "defer" ? "deferred" : "open";
  updateFinding(db, id, {
    status,
    prev_status: row.status,
    status_reason: action === "reopen" ? "reopened by developer" : null,
    decision_note: note.trim() || row.decision_note,
    decided_at: nowIso(),
    // Snapshot of the evidence files at decision time: a dismissed finding only comes back if these change.
    decision_path_hashes: JSON.stringify(workingTreeHashes(repoRoot, paths)),
    defer_until: action === "defer" ? deferUntil ?? null : null,
    updated_at: nowIso(),
  });
  history(db, id, null, `developer-${action}`, note);
  return db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as unknown as FindingRow;
}

/** Deferred findings with a passed defer date return to the inbox. */
export function expireDeferrals(db: DB): void {
  const rows = db.prepare("SELECT id, defer_until FROM findings WHERE status = 'deferred' AND defer_until IS NOT NULL").all() as Array<{ id: number; defer_until: string }>;
  for (const r of rows) {
    if (Date.parse(r.defer_until) <= Date.now()) {
      updateFinding(db, r.id, { status: "open", prev_status: "deferred", status_reason: `deferral until ${r.defer_until} expired`, updated_at: nowIso() });
      history(db, r.id, null, "defer-expired");
    }
  }
}

export const allFindings = (db: DB): FindingRow[] => db.prepare("SELECT * FROM findings ORDER BY id").all() as unknown as FindingRow[];

/** Compact ledger view handed to the hosted agent so it can dedupe and respect decisions. */
export function ledgerForAgent(db: DB, fileHashes: Record<string, string>) {
  return allFindings(db).map((r) => {
    const decisionHashes = parseJson<Record<string, string>>(r.decision_path_hashes, {});
    return {
      fingerprint: r.fingerprint,
      status: r.status,
      issue_type: r.kind,
      severity: r.severity,
      title: r.title,
      statement: r.statement,
      related_paths: parseJson<string[]>(r.related_paths, []),
      revision: r.revision,
      seen_count: r.seen_count,
      ...(r.status === "stale" ? { needs_recheck: r.status_reason } : {}),
      ...(r.decision_note ? { developer_decision: { action: r.status, reason: r.decision_note, at: r.decided_at } } : {}),
      ...(r.status === "dismissed" || r.status === "deferred"
        ? { files_changed_since_decision: changedPaths(decisionHashes, hashesFor(Object.keys(decisionHashes), fileHashes)) }
        : {}),
    };
  });
}
