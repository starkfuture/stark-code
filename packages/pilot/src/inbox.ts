/** CLI rendering for findings, runs, status. */
import type { Config } from "./config.ts";
import type { DB, JobRow } from "./db.ts";
import { kvGet } from "./db.ts";
import { kvGetReg, listRepos, pilotHome, watchedProfiles } from "./home.ts";
import { loadConfig } from "./config.ts";
import { displayQuote, unreadCount } from "./chat.ts";
import { cleanLabel } from "./sessionInfo.ts";
import { budgetState } from "./budget.ts";
import { allFindings, workingTreeHashes, type FindingRow, type Grounding } from "./findings.ts";
import type { EvidenceItem } from "./investigator/types.ts";
import { OFFLINE_LABEL } from "./investigator/offline.ts";
import { daemonStatus } from "./watcher.ts";
import { engineStatusLine } from "./engine.ts";
import { centsToUsd, parseJson } from "./util.ts";

const C = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (C ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1"), dim = paint("2"), red = paint("31"), yellow = paint("33"), green = paint("32"), cyan = paint("36");

const runtimeTag = (r: FindingRow | JobRow) =>
  (r.runtime ?? "") === "offline-fixture" ? yellow(" [OFFLINE FIXTURE]") : (r.runtime ?? "") === "local-claude" ? dim(" [local claude]") : "";

function groundTag(r: FindingRow): string {
  const g = parseJson<Grounding | null>(r.grounding, null);
  if (!g) return "";
  if (g.status === "grounded") return green(`evidence ✓${g.verified}`);
  if (g.status === "partial") return yellow(`evidence ✓${g.verified} ✗${g.checks.filter((c) => c.result === "failed").length}`);
  return red("evidence ✗ (unverified)");
}

/** Cheap live check (no model call): have the cited files changed in the working tree since the finding was confirmed? */
function liveChange(r: FindingRow, repoRoot: string): string {
  if (!["open", "accepted", "deferred"].includes(r.status)) return "";
  const prev = parseJson<Record<string, string>>(r.path_hashes, {});
  const now = workingTreeHashes(repoRoot, Object.keys(prev));
  const changed = Object.keys(prev).filter((p) => prev[p] !== now[p]);
  return changed.length ? `\n     ${yellow(`⚠ ${changed.join(", ")} changed since ${r.revision}; re-check at next checkpoint`)}` : "";
}

const sevPaint = (sev: string | null) => (sev === "critical" || sev === "high" ? red : sev === "medium" ? yellow : dim);
const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** What Pilot did with the finding: told the session, will tell it, or kept it in the inbox (and why). */
function speechTag(r: FindingRow): string {
  const sp = parseJson<{ action: string; why: string } | null>(r.speak, null);
  if (r.delivered_at) return green(`told the session ${r.delivered_at.slice(5, 16).replace("T", " ")}`);
  if (!sp) return dim("not assessed for delivery");
  if (sp.action === "speak" && !r.origin_session) return yellow(`important (${sp.why}); from a review you started, so it stays here`);
  if (sp.action === "speak") return yellow(`will tell the session (${sp.why})`);
  return dim(`kept quiet: ${sp.why}`);
}

function line(r: FindingRow, repoRoot: string, ref: string): string {
  const conf = r.confidence === null ? "" : ` · conf ${r.confidence.toFixed(2)}`;
  const seen = r.seen_count > 1 ? ` · seen ${r.seen_count}x` : "";
  const facts = [r.kind, r.attribution?.replace("_", " "), r.proof?.replace("_", " ")].filter(Boolean).join(" · ");
  return `  ${bold(`${ref}#${r.id}`)} ${sevPaint(r.severity)((r.severity ?? "unrated").toUpperCase())} ${r.title}${runtimeTag(r)}\n     ${dim(`${facts}${conf} · `)}${groundTag(r)}${dim(` · rev ${r.revision}${seen}`)}${liveChange(r, repoRoot)}\n     ${speechTag(r)}\n     ${cyan("→")} ${r.next_action ?? ""}`;
}

/** One repository's section, or "" when it has nothing to show. */
export function renderInbox(db: DB, all: boolean, repoRoot: string, ref = "#"): string {
  const rows = allFindings(db);
  const open = rows.filter((r) => r.status === "open").sort((a, b) => (SEV_ORDER[a.severity ?? "low"] ?? 9) - (SEV_ORDER[b.severity ?? "low"] ?? 9) || a.id - b.id);
  const stale = rows.filter((r) => r.status === "stale");
  const decided = all ? rows.filter((r) => !["open", "stale"].includes(r.status)) : [];
  if (!open.length && !stale.length && !decided.length) return "";
  const out: string[] = [bold(`${ref}  ${dim(repoRoot)}`)];
  for (const r of open) out.push(line(r, repoRoot, ref));
  if (stale.length) out.push(dim("  stale - evidence changed, waiting for a re-check:"), ...stale.map((r) => line(r, repoRoot, ref)));
  for (const r of decided) out.push(dim(`  ${ref}#${r.id} ${r.status}: ${r.title}${r.decision_note ? ` - ${r.decision_note}` : ""}`));
  const counts = (st: string) => rows.filter((r) => r.status === st).length;
  out.push(dim(`  accepted ${counts("accepted")} · deferred ${counts("deferred")} · dismissed ${counts("dismissed")} · resolved ${counts("resolved")} · unverified (hidden) ${counts("unverified")}`));
  return out.join("\n");
}

export function renderFinding(db: DB, id: number, ref = ""): string {
  const r = db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as FindingRow | undefined;
  if (!r) return `No finding #${id}`;
  const ev = parseJson<EvidenceItem[]>(r.evidence, []);
  const g = parseJson<Grounding | null>(r.grounding, null);
  const hist = db.prepare("SELECT * FROM finding_history WHERE finding_id = ? ORDER BY id").all(id) as Array<{ ts: string; action: string; note: string | null; job_id: number | null }>;
  const o: string[] = [
    `${bold(`${ref}#${r.id} ${r.title}`)}${runtimeTag(r)}`,
    `${(r.severity ?? "unrated").toUpperCase()} ${r.kind} · ${r.attribution ?? "?"} · proof ${r.proof ?? "?"} · session ${r.awareness ?? "?"} · ${r.category}${parseJson<string[]>(r.risk_areas, []).length ? ` · risk: ${parseJson<string[]>(r.risk_areas, []).join(", ")}` : ""}`,
    `status ${r.status}${r.status_reason ? ` (${r.status_reason})` : ""} · ${speechTag(r)}`,
    `fingerprint ${r.fingerprint} · first seen ${r.first_revision} · applies to ${r.revision} · seen ${r.seen_count}x${r.suppressed_count ? ` · suppressed ${r.suppressed_count}x after decision` : ""}`,
    "",
    bold("What it identified"),
    `  ${r.statement}`,
    ...(r.failure_case ? [bold("Failure case"), `  ${r.failure_case}`] : []),
    ...(r.controls_checked ? [bold("Controls checked"), `  ${r.controls_checked}`] : []),
    bold("Why it matters"),
    `  ${r.why_it_matters}`,
    bold(`Evidence (${g?.status ?? "?"})`),
  ];
  ev.forEach((e, i) => {
    const check = g?.checks.find((c) => c.index === i);
    const mark = check ? (check.result === "verified" ? green("✓") : check.result === "failed" ? red("✗") : yellow("?")) : " ";
    if (e.type === "file") o.push(`  ${mark} ${e.path}${e.line_start ? `:${e.line_start}${e.line_end && e.line_end !== e.line_start ? `-${e.line_end}` : ""}` : ""}  ${dim(check?.detail ?? "")}\n      "${e.quote}"`);
    else if (e.type === "command") o.push(`  ${mark} $ ${e.command}  ${dim(check?.detail ?? "")}\n      ${e.output_excerpt}`);
    else o.push(`  ${mark} event ${e.event_ref ?? ""}  ${dim(check?.detail ?? "")}\n      "${e.quote}"`);
  });
  o.push(bold("Uncertainty"), `  confidence ${r.confidence?.toFixed(2) ?? "?"} - ${r.uncertainty ?? ""}`);
  o.push(bold("Suggested next action"), `  ${r.next_action ?? ""}`);
  if (r.handoff_prompt) o.push(dim("  handoff prompt available: `pilot handoff " + r.id + "`"));
  if (r.decision_note) o.push(bold("Your decision"), `  ${r.status} at ${r.decided_at}: ${r.decision_note}`);
  o.push(bold("History"));
  for (const h of hist) o.push(dim(`  ${h.ts.slice(0, 19)} ${h.action}${h.job_id ? ` (job #${h.job_id})` : ""}${h.note ? ` - ${h.note}` : ""}`));
  if (r.runtime === "offline-fixture") o.push("", yellow(`Note: produced by ${OFFLINE_LABEL}.`));
  return o.join("\n");
}

export function renderHandoff(db: DB, id: number): string {
  const r = db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as FindingRow | undefined;
  if (!r) return `No finding #${id}`;
  const ev = parseJson<EvidenceItem[]>(r.evidence, []);
  const evLines = ev
    .map((e) => (e.type === "file" ? `- ${e.path}${e.line_start ? `:${e.line_start}` : ""}: "${e.quote}"` : e.type === "command" ? `- \`${e.command}\` -> ${e.output_excerpt}` : `- "${e.quote}"`))
    .join("\n");
  return `An independent reviewer raised this about the current change (revision ${r.revision}). Verify it before acting; push back if it is wrong.

Issue: ${r.title}
${r.statement}

Why it matters: ${r.why_it_matters}

Evidence:
${evLines}

Requested change: ${r.handoff_prompt ?? r.next_action ?? ""}
${r.decision_note ? `\nDeveloper note: ${r.decision_note}\n` : ""}`;
}

export function renderRuns(db: DB, limit = 15): string {
  const rows = db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit) as unknown as JobRow[];
  if (!rows.length) return dim("no runs yet");
  return rows
    .map((j) => {
      const usage = parseJson<Record<string, any>>(j.usage, {});
      const tok = usage.input_tokens !== undefined && !usage.simulated ? ` · tok in ${usage.input_tokens}/out ${usage.output_tokens}/cache ${usage.cache_read_input_tokens ?? 0}` : "";
      const secs = j.started_at && j.finished_at ? ` · ${((Date.parse(j.finished_at) - Date.parse(j.started_at)) / 1000).toFixed(1)}s` : "";
      const cost = j.list_cost_cents !== null ? ` · ${centsToUsd(j.list_cost_cents)} ${dim(`(${j.cost_source})`)}` : "";
      const cap = j.budget_cents !== null ? dim(` cap ${centsToUsd(j.budget_cents)}`) : "";
      return `${bold(`#${j.id}`)} ${j.kind}/${j.depth} ${j.status}${runtimeTag(j)} · trigger ${j.trigger}${j.revision ? ` · rev ${j.revision}` : ""}${cost}${cap}${tok}${secs}${j.session_id ? dim(` · ${j.session_id}`) : ""}${j.error ? red(` · ${j.error.slice(0, 120)}`) : ""}`;
    })
    .join("\n");
}

export function renderStatus(reg: import("./home.ts").DB, one: { cfg: Config; db: DB } | null): string {
  const ds = daemonStatus();
  const paused = kvGetReg<boolean>(reg, "paused", false);
  const repos = listRepos(reg);
  const lines = [
    `${bold("daemon")}    ${ds.running ? green(`running (pid ${ds.lock?.pid})`) : dim("not running (starts with the next Claude Code session)")}${paused ? yellow(" · PAUSED (events still captured)") : ""}`,
    `${bold("profiles")}  ${watchedProfiles().join(", ")}`,
    `${bold("repos")}     ${repos.length} watched · home ${pilotHome()}`,
    `${bold("chat")}      ${unreadCount(reg)} unread nudge(s) · thinks with ${loadConfig(pilotHome(), { cheap: true }).engine} · \`pilot chat\``,
    `${bold("engine")}    ${engineStatusLine(reg)}`,
  ];
  if (!one) return lines.join("\n");
  const { cfg, db } = one;
  const blocked = kvGet<{ reason: string } | null>(db, "blocked_reason", null);
  const b = budgetState(db, cfg);
  const pend = db.prepare("SELECT kind, COUNT(*) AS n FROM events WHERE consumed = 0 GROUP BY kind").all() as Array<{ kind: string; n: number }>;
  const jobs = db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as Array<{ status: string; n: number }>;
  const mode =
    cfg.mode === "offline"
      ? yellow(`OFFLINE - ${OFFLINE_LABEL}`)
      : cfg.mode === "local"
        ? green(`local (${cfg.claudeBin} -p on your Claude Code login; sandboxed; cost = API-equivalent estimate, usage counts against your plan)`)
        : green("live (Claude Managed Agents)");
  const hold = kvGet<{ until: string; reason: string } | null>(db, "quota_hold", null);
  const src = Object.entries(b.spentBySource).map(([k, v]) => `${centsToUsd(v)} ${k}`).join(", ") || "none";
  return [
    ...lines,
    `${bold("mode")}      ${mode} · model ${cfg.model} (quick ${cfg.quickEffort} / deep ${cfg.deepEffort})`,
    `${bold("repo")}      ${cfg.repoRoot}${kvGet<boolean>(db, "paused", false) ? yellow(" · PAUSED") : ""}`,
    `${bold("queue")}     pending events: ${pend.map((p) => `${p.kind} ${p.n}`).join(", ") || "none"} · jobs: ${jobs.map((j) => `${j.status} ${j.n}`).join(", ") || "none"}`,
    `${bold("budget")}    last ${cfg.budgetWindowHours} h, all repos: spent ${centsToUsd(b.spentCents)} [${src}] + reserved ${centsToUsd(b.reservedCents)} of ${centsToUsd(b.capCents)} · available ${centsToUsd(b.availableCents)}`,
    ...(blocked ? [`${bold("blocked")}   ${yellow(blocked.reason)}`] : []),
    ...(hold && Date.parse(hold.until) > Date.now() ? [`${bold("held")}      ${yellow(`usage limit until ${hold.until}: ${hold.reason}`)}`] : []),
    `${bold("limits")}    run cap ${centsToUsd(cfg.runBudgetCents)} · timeout ${cfg.runTimeoutSec}s · min interval ${cfg.minRunIntervalMin} min · debounce ${cfg.quietMs}ms · speak at most every ${cfg.speakSpacingMin} min`,
  ].join("\n");
}

const NUDGE_LABEL: Record<string, string> = { rule: "Your rule", earlier: "You said earlier", pending: "Waiting on you", missing: "Missing detail", risky: "Hard to undo" };

/** The Pilot chat thread, oldest first (`pilot chat`, `pilot ask`). */
export function renderChat(rows: import("./chat.ts").ChatRow[]): string {
  return rows
    .map((r) => {
      const at = new Date(Number(r.at_ms)).toLocaleString();
      const ev = parseJson<import("./chat.ts").Evidence[]>(r.evidence_json, []);
      const quotes = ev.map((e) => `    ${e.found ? green("✓") : red("not found")} ${dim(cleanLabel(e.where))}\n      "${displayQuote(e.quote).replace(/\s+/g, " ")}"`).join("\n");
      if (r.role === "you") return `${dim(at)}  ${bold("You")}: ${r.text}`;
      if (r.kind === "nudge") {
        const state = r.state === "new" ? yellow("new") : dim(r.state.replace("_", " "));
        return `${dim(at)}  ${bold("Pilot")} #${r.id} ${cyan(NUDGE_LABEL[r.nudge_kind ?? ""] ?? "Nudge")} · ${r.session_label ? cleanLabel(r.session_label) : "no session"} · ${state}${r.engine ? dim(` · ${r.engine}`) : ""}\n  ${r.text}${quotes ? `\n${quotes}` : ""}`;
      }
      return `${dim(at)}  ${bold("Pilot")}${r.kind === "note" ? dim(" (note)") : ""}${r.engine ? dim(` [${r.engine}]`) : ""}: ${r.text}${quotes ? `\n${quotes}` : ""}`;
    })
    .join("\n\n");
}
