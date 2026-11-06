import test from "node:test";
import assert from "node:assert/strict";
import { decideSpeech, type SpeechInput } from "../src/policy.ts";

const cfg = { minConfidence: 0.7, riskAreas: ["money", "security", "privacy", "data_loss", "production", "irreversible"], demoteAfterDismissals: 3 };
const base: SpeechInput = {
  issueType: "defect",
  severity: "medium",
  attribution: "introduced",
  proof: "source_proven",
  awareness: "aware",
  riskAreas: [],
  confidence: 0.9,
  grounding: "grounded",
  status: "open",
  outsideContext: { unseen: [] },
  dismissedInCategory: 0,
};
const d = (over: Partial<SpeechInput>) => decideSpeech({ ...base, ...over }, cfg);

test("no concrete evidence, no speech", () => {
  assert.equal(d({ grounding: "ungrounded", severity: "critical" }).action, "silent");
  assert.equal(d({ grounding: "partial", proof: "unconfirmed", severity: "critical" }).action, "inbox");
  assert.equal(d({ grounding: "partial", proof: "source_proven", severity: "critical" }).action, "speak", "an unverifiable experiment excerpt only costs the reproduced label");
  assert.equal(d({ proof: "unconfirmed", severity: "critical" }).action, "inbox");
  assert.equal(d({ confidence: 0.5, severity: "critical" }).action, "inbox");
});

test("it speaks when the evidence is concrete AND the session needs to hear it", () => {
  // The user's list: risky, outside the session's context, or the session does not know (and caused it).
  assert.match(d({ severity: "high" }).why, /^risky: high severity/);
  assert.match(d({ riskAreas: ["security"] }).why, /^risky: security/);
  assert.match(d({ outsideContext: { unseen: ["docs/orders-api.md"] } }).why, /outside_context: this session has not opened docs\/orders-api\.md/);
  assert.match(d({ awareness: "unaware" }).why, /unaware/);
  assert.equal(d({}).action, "inbox", "medium, already mentioned in the session, nothing risky, all in context: stays in the inbox");
});

test("it stays quiet for things that do not need an interruption", () => {
  assert.equal(d({ awareness: "addressing", severity: "critical" }).action, "silent", "the session is already handling it");
  assert.equal(d({ issueType: "suggestion", severity: "high" }).action, "inbox");
  assert.equal(d({ severity: "low", awareness: "unaware" }).action, "inbox");
  assert.equal(d({ attribution: "pre_existing", awareness: "unaware" }).action, "inbox", "medium existing issue not caused by the work");
  assert.equal(d({ attribution: "pre_existing", severity: "high" }).action, "speak", "but a high existing issue the work relies on is raised");
  assert.equal(d({ attribution: "pre_existing", awareness: "unaware", severity: "high" }).reasons.some((r) => r.startsWith("unaware")), false);
  assert.equal(d({ status: "dismissed", severity: "critical" }).action, "silent");
  assert.equal(d({ status: "stale", severity: "critical" }).action, "inbox");
});

test("repeated dismissals demote medium findings, never risky ones", () => {
  assert.equal(d({ awareness: "unaware", dismissedInCategory: 3 }).action, "inbox");
  assert.equal(d({ riskAreas: ["money"], dismissedInCategory: 9 }).action, "speak");
  assert.equal(d({ severity: "high", dismissedInCategory: 9 }).action, "speak");
});
