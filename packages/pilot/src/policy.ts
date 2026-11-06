/**
 * When Pilot speaks. Pure, deterministic, and owned by the application - the model only reports facts
 * (severity, attribution, proof, awareness, risk areas); evidence is checked mechanically before this runs.
 *
 * Pilot tells the session about a finding only when ALL of these hold:
 *  1. Concrete evidence: proof (checked against the citations, see findings.checkedProof) is "reproduced" or
 *     "source_proven", and confidence is high enough.
 *  2. It matters: a defect or a decision (not a suggestion), severity medium or above.
 *  3. It is about the current work: introduced, amplified or proposed by it - or a pre-existing failure the work
 *     now relies on that is risky (high/critical, or it touches money, security, data, production, ...).
 *  4. The session is not already handling it, and the developer has not decided on it.
 *  5. At least one reason the session needs to hear it from Pilot:
 *       - risky:           high/critical severity, or it touches money, security, privacy, data, production, ...
 *       - outside_context: the evidence is in files this session has never opened
 *       - unaware:         nothing in the session mentions it, and the current work caused it
 *  6. Not demoted: medium findings in a category the developer keeps dismissing go to the inbox.
 * Everything else goes to the inbox (or is only recorded). Spacing limits are applied at delivery time.
 */
import type { Attribution, Awareness, IssueType, Proof, Severity } from "./investigator/types.ts";

export type SpeechAction = "speak" | "inbox" | "silent";

export interface SpeechInput {
  issueType: IssueType;
  severity: Severity;
  attribution: Attribution;
  proof: Proof; // as checked against the evidence, not as claimed
  awareness: Awareness;
  riskAreas: string[];
  confidence: number;
  grounding: "grounded" | "partial" | "ungrounded";
  status: string;
  outsideContext: { unseen: string[] } | null; // null = unknown (no session information)
  dismissedInCategory: number;
}

export interface SpeechConfig {
  minConfidence: number;
  riskAreas: string[];
  demoteAfterDismissals: number;
}

export interface SpeechDecision {
  action: SpeechAction;
  reasons: string[]; // why it speaks (empty unless action = speak)
  why: string; // one line for the inbox: why it spoke or why it stayed quiet
}

const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function decideSpeech(i: SpeechInput, c: SpeechConfig): SpeechDecision {
  const quiet = (action: SpeechAction, why: string): SpeechDecision => ({ action, reasons: [], why });
  if (i.grounding === "ungrounded") return quiet("silent", "no cited evidence could be verified");
  if (!["open", "stale"].includes(i.status)) return quiet("silent", `status ${i.status}`);
  if (i.status === "stale") return quiet("inbox", "evidence changed; waiting for a re-check");
  if (i.awareness === "addressing") return quiet("silent", "the session is already handling it");
  if (i.proof === "unconfirmed") return quiet("inbox", i.grounding === "grounded" ? "not proven: no reproduction or source trace" : "a cited quote did not verify");
  if (i.confidence < c.minConfidence) return quiet("inbox", `confidence ${i.confidence.toFixed(2)} below ${c.minConfidence}`);
  if (i.issueType === "suggestion") return quiet("inbox", "optional suggestion");
  if (RANK[i.severity] < RANK.medium) return quiet("inbox", "low severity");
  const high = RANK[i.severity] >= RANK.high;
  const causedByWork = i.attribution !== "pre_existing";
  const areas = i.riskAreas.filter((a) => c.riskAreas.includes(a));
  if (!causedByWork && !high && !areas.length) return quiet("inbox", "existing issue, not caused or worsened by this work");

  const reasons: string[] = [];
  if (high || areas.length) reasons.push(`risky: ${high ? `${i.severity} severity` : ""}${high && areas.length ? ", " : ""}${areas.join(", ")}`);
  if (i.outsideContext && i.outsideContext.unseen.length) reasons.push(`outside_context: this session has not opened ${i.outsideContext.unseen.slice(0, 3).join(", ")}`);
  if (i.awareness === "unaware" && causedByWork) reasons.push("unaware: nothing in the session mentions it");
  if (!reasons.length) return quiet("inbox", "the session already knows about it and it is not high risk");
  if (!high && !areas.length && i.dismissedInCategory >= c.demoteAfterDismissals)
    return quiet("inbox", `you dismissed ${i.dismissedInCategory} similar findings; kept in the inbox`);
  return { action: "speak", reasons, why: reasons.join("; ") };
}
