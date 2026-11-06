/**
 * Contract between the watcher and whatever runs an investigation (hosted Managed Agents session or the
 * labelled offline fake). The hosted agent returns results only through the `submit_assessment` custom tool,
 * so they arrive as schema-shaped JSON that we validate before trusting.
 */

export type IssueType = "defect" | "decision" | "suggestion";
export type Severity = "critical" | "high" | "medium" | "low";
export type Attribution = "introduced" | "amplified" | "pre_existing" | "proposed";
export type Proof = "reproduced" | "source_proven" | "unconfirmed";
export type Awareness = "unaware" | "aware" | "addressing";
export type FindingCategory = "assumption" | "omission" | "risk";
export const ISSUE_TYPES: IssueType[] = ["defect", "decision", "suggestion"];
export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
export const ATTRIBUTIONS: Attribution[] = ["introduced", "amplified", "pre_existing", "proposed"];
export const PROOFS: Proof[] = ["reproduced", "source_proven", "unconfirmed"];
export const AWARENESS: Awareness[] = ["unaware", "aware", "addressing"];
export const CATEGORIES: FindingCategory[] = ["assumption", "omission", "risk"];
export const RISK_AREAS = ["money", "security", "privacy", "data_loss", "production", "irreversible", "compliance"] as const;

export interface EvidenceItem {
  type: "file" | "command" | "event";
  path?: string;
  line_start?: number;
  line_end?: number;
  quote?: string;
  command?: string;
  output_excerpt?: string;
  exit_code?: number;
  event_ref?: string;
}

export interface SubmittedFinding {
  fingerprint: string;
  issue_type: IssueType;
  severity: Severity;
  attribution: Attribution;
  proof: Proof;
  session_awareness: Awareness;
  awareness_quote?: string;
  risk_areas: string[];
  category: FindingCategory;
  title: string;
  statement: string;
  failure_case: string;
  controls_checked: string;
  why_it_matters: string;
  evidence: EvidenceItem[];
  confidence: number;
  uncertainty: string;
  suggested_next_action: string;
  handoff_prompt?: string;
  related_paths: string[];
  new_evidence_since_dismissal?: string;
}

export interface Submission {
  phase: "baseline" | "comparison" | "checkpoint";
  summary: string;
  notes_update?: Record<string, unknown>;
  findings: SubmittedFinding[];
  resolved?: Array<{ fingerprint: string; reason: string }>;
  still_valid?: string[];
  escalate?: { needed: boolean; reason?: string };
}

const noteItem = {
  type: "object",
  properties: {
    text: { type: "string" },
    source: { type: "string", enum: ["developer", "repo", "lookout", "coding-agent", "inferred"] },
    status: { type: "string" },
    evidence: { type: "string" },
  },
  required: ["text", "source"],
};

/** JSON schema for the custom tool. Kept explicit so the hosted model sees the full contract. */
export const SUBMISSION_SCHEMA = {
  type: "object" as const,
  properties: {
    phase: { type: "string", enum: ["baseline", "comparison", "checkpoint"] },
    summary: { type: "string", description: "2-5 sentences: what you checked, what you concluded, and the limits of the check." },
    notes_update: {
      type: "object",
      description:
        "Your updated working model of the project. Each list replaces the previous one; developer-sourced items are kept automatically (repeat one verbatim with a status to annotate it).",
      properties: {
        requirements: { type: "array", items: noteItem },
        constraints: { type: "array", items: noteItem },
        proposed_solutions: { type: "array", items: noteItem },
        assumptions: { type: "array", items: noteItem },
        open_questions: { type: "array", items: noteItem },
        evidence_log: { type: "array", items: noteItem },
      },
    },
    findings: {
      type: "array",
      description: "Only failures that meet the reporting criteria. An empty list is the normal result.",
      items: {
        type: "object",
        properties: {
          fingerprint: {
            type: "string",
            description: "Stable kebab-case id for the underlying issue. Reuse the ledger's fingerprint when it is the same issue.",
          },
          issue_type: {
            type: "string",
            enum: ISSUE_TYPES,
            description: "defect = the change/request leads to wrong behaviour; decision = only the developer can settle it (a requirement conflict or a trade-off); suggestion = optional, never pushed to the developer.",
          },
          severity: {
            type: "string",
            enum: SEVERITIES,
            description: "From demonstrated consequence and reachability, not from certainty. critical: money, data loss, security breach, outage or irreversible harm on a normal path. high: serious wrong behaviour on a realistic path, or a reachable security weakness. medium: wrong behaviour on a less common but realistic path, bounded impact. low: edge cases, cosmetic, hard to reach.",
          },
          attribution: {
            type: "string",
            enum: ATTRIBUTIONS,
            description: "introduced = the current change causes it; amplified = the change makes an existing problem worse or more likely; pre_existing = present before and not made worse; proposed = the request/plan would cause it once implemented.",
          },
          proof: {
            type: "string",
            enum: PROOFS,
            description: "reproduced = you ran something and observed the failure (cite the command); source_proven = traced trigger -> path -> consequence through the code (cite the lines); unconfirmed = plausible but not established. Checked mechanically against your evidence.",
          },
          session_awareness: {
            type: "string",
            enum: AWARENESS,
            description: "Does the coding session already know? Judge from events.json (developer prompts and coding-agent messages). unaware = nothing there mentions it; aware = mentioned but not being handled; addressing = the session is already fixing or explicitly planning to fix it.",
          },
          awareness_quote: { type: "string", description: "For aware/addressing: verbatim quote from events.json that shows it." },
          risk_areas: {
            type: "array",
            items: { type: "string", enum: [...RISK_AREAS] },
            description: "What the failure would hit, if any of these. Empty when none applies.",
          },
          category: { type: "string", enum: CATEGORIES },
          title: { type: "string", description: "The consequence in one line, e.g. 'Retried POST /orders can charge a customer twice'." },
          statement: { type: "string", description: "What is wrong, stated precisely." },
          failure_case: { type: "string", description: "One concrete scenario: trigger / inputs -> path -> wrong outcome." },
          controls_checked: { type: "string", description: "Controls and alternative explanations you checked that could prevent it, and what you found." },
          why_it_matters: { type: "string", description: "Tie it to the project goal or a stated requirement." },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["file", "command", "event"] },
                path: { type: "string", description: "Repo-relative path (file evidence)." },
                line_start: { type: "integer" },
                line_end: { type: "integer" },
                quote: { type: "string", description: "Verbatim text copied from the file or event. Verified mechanically." },
                command: { type: "string", description: "Exact command you ran in the sandbox (command evidence)." },
                output_excerpt: { type: "string", description: "Verbatim excerpt of that command's output." },
                exit_code: { type: "integer" },
                event_ref: { type: "string", description: "events.json id for event evidence." },
              },
              required: ["type"],
            },
          },
          confidence: { type: "number", description: "0..1 probability that the stated failure occurs under the stated conditions." },
          uncertainty: { type: "string", description: "What you could not verify and what would change your mind." },
          suggested_next_action: { type: "string" },
          handoff_prompt: { type: "string", description: "Optional ready-to-paste instruction for the coding agent." },
          related_paths: { type: "array", items: { type: "string" } },
          new_evidence_since_dismissal: {
            type: "string",
            description: "Only when re-raising a dismissed fingerprint: what changed since the developer's decision.",
          },
        },
        required: [
          "fingerprint",
          "issue_type",
          "severity",
          "attribution",
          "proof",
          "session_awareness",
          "risk_areas",
          "category",
          "title",
          "statement",
          "failure_case",
          "controls_checked",
          "why_it_matters",
          "evidence",
          "confidence",
          "uncertainty",
          "suggested_next_action",
          "related_paths",
        ],
      },
    },
    resolved: {
      type: "array",
      description: "Ledger fingerprints (open or stale) that the current revision fixes or makes irrelevant.",
      items: { type: "object", properties: { fingerprint: { type: "string" }, reason: { type: "string" } }, required: ["fingerprint", "reason"] },
    },
    still_valid: { type: "array", items: { type: "string" }, description: "Stale/open fingerprints you re-checked and that still hold." },
    escalate: {
      type: "object",
      description: "Request a deeper (more expensive) investigation only when a quick pass cannot settle a material question.",
      properties: { needed: { type: "boolean" }, reason: { type: "string" } },
      required: ["needed"],
    },
  },
  required: ["phase", "summary", "findings"],
};

export const SUBMIT_TOOL = {
  type: "custom" as const,
  name: "submit_assessment",
  description:
    "Record your assessment for this phase. Call exactly once per phase, after investigating. Findings must cite verifiable evidence. An empty findings list is the normal result.",
  input_schema: SUBMISSION_SCHEMA,
};

type V = { ok: true; value: Submission } | { ok: false; errors: string[] };

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Hand-written validation (no schema library): returns precise errors the agent can fix. */
export function validateSubmission(input: unknown): V {
  const errors: string[] = [];
  const o = input as Record<string, any>;
  if (!o || typeof o !== "object") return { ok: false, errors: ["input must be an object"] };
  if (!["baseline", "comparison", "checkpoint"].includes(o.phase)) errors.push("phase must be baseline|comparison|checkpoint");
  if (!isStr(o.summary)) errors.push("summary is required");
  if (!Array.isArray(o.findings)) errors.push("findings must be an array (may be empty)");
  const findings: SubmittedFinding[] = [];
  for (const [i, f] of (Array.isArray(o.findings) ? o.findings : []).entries()) {
    const p = `findings[${i}]`;
    for (const k of ["fingerprint", "title", "statement", "failure_case", "controls_checked", "why_it_matters", "uncertainty", "suggested_next_action"]) {
      if (!isStr(f?.[k])) errors.push(`${p}.${k} is required`);
    }
    const oneOf = (k: string, allowed: readonly string[]) => {
      if (!allowed.includes(f?.[k])) errors.push(`${p}.${k} must be ${allowed.join("|")}`);
    };
    oneOf("issue_type", ISSUE_TYPES);
    oneOf("severity", SEVERITIES);
    oneOf("attribution", ATTRIBUTIONS);
    oneOf("proof", PROOFS);
    oneOf("session_awareness", AWARENESS);
    oneOf("category", CATEGORIES);
    if (!Array.isArray(f?.risk_areas) || f.risk_areas.some((x: unknown) => !(RISK_AREAS as readonly string[]).includes(x as string)))
      errors.push(`${p}.risk_areas must be an array of ${RISK_AREAS.join("|")}`);
    if (typeof f?.confidence !== "number" || f.confidence < 0 || f.confidence > 1) errors.push(`${p}.confidence must be 0..1`);
    if (!Array.isArray(f?.evidence) || f.evidence.length === 0) errors.push(`${p}.evidence needs at least one item`);
    for (const [j, e] of (Array.isArray(f?.evidence) ? f.evidence : []).entries()) {
      if (!["file", "command", "event"].includes(e?.type)) errors.push(`${p}.evidence[${j}].type invalid`);
      if (e?.type === "file" && (!isStr(e.path) || !isStr(e.quote))) errors.push(`${p}.evidence[${j}] file evidence needs path and verbatim quote`);
      if (e?.type === "command" && (!isStr(e.command) || !isStr(e.output_excerpt))) errors.push(`${p}.evidence[${j}] command evidence needs command and output_excerpt`);
      if (e?.type === "event" && !isStr(e.quote)) errors.push(`${p}.evidence[${j}] event evidence needs a verbatim quote`);
    }
    if (!Array.isArray(f?.related_paths) || f.related_paths.some((x: unknown) => typeof x !== "string")) errors.push(`${p}.related_paths must be an array of strings`);
    for (const [j, e] of (Array.isArray(f?.evidence) ? f.evidence : []).entries()) {
      for (const k of ["line_start", "line_end", "exit_code"]) if (e?.[k] !== undefined && e?.[k] !== null && !Number.isInteger(e[k])) errors.push(`${p}.evidence[${j}].${k} must be an integer`);
    }
    if (f && typeof f === "object") findings.push(f as SubmittedFinding);
  }
  if (o.resolved !== undefined) {
    if (!Array.isArray(o.resolved)) errors.push("resolved must be an array");
    else
      o.resolved.forEach((r: any, i: number) => {
        if (!r || typeof r !== "object" || !isStr(r.fingerprint) || !isStr(r.reason)) errors.push(`resolved[${i}] needs fingerprint and reason`);
      });
  }
  if (o.still_valid !== undefined) {
    if (!Array.isArray(o.still_valid)) errors.push("still_valid must be an array");
    else o.still_valid.forEach((x: unknown, i: number) => { if (!isStr(x)) errors.push(`still_valid[${i}] must be a fingerprint string`); });
  }
  if (o.escalate !== undefined && (typeof o.escalate !== "object" || o.escalate === null || typeof o.escalate.needed !== "boolean")) errors.push("escalate.needed must be boolean");
  if (o.notes_update !== undefined && (typeof o.notes_update !== "object" || o.notes_update === null || Array.isArray(o.notes_update))) errors.push("notes_update must be an object");
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { ...(o as Submission), findings } };
}
