import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { LookoutDecision, LookoutFindings } from "./lookout.ts";

// Captured stdout of `lookout api findings` and `lookout api decide` (Lookout API 1) for one finding.
// Lookout reports `revision` as text: the git revision it checked, plus a working-tree suffix.
const FINDINGS_STDOUT = `{"api":1,"findings":[{"ref":"billing#1","repo":"billing","repoKey":"billing-c7d638836d","id":1,"title":"Invoice totals round per line","severity":"high","issueType":"defect","attribution":"introduced","proof":"source_proven","awareness":"unaware","riskAreas":["money"],"status":"open","statement":"Each line is rounded before summing.","failureCase":"100 lines of 0.005 drift the total by 50 cents.","whyItMatters":"Customers are overcharged.","nextAction":"Round once after summing.","handoffPrompt":"Round the invoice total once, after summing the lines.","evidence":[{"type":"file","path":"src/invoice.ts","lineStart":2,"quote":"lines.map((line) => round(line)).reduce((a, b) => a + b, 0);","check":"verified"}],"speech":{"action":"speak","why":"risky: high severity, money; unaware: nothing in the session mentions it","toldSession":false},"deliveredAt":null,"revision":"4f9c2a1b7e+wt.3d5e8a90","createdAt":"2026-11-05T17:43:17.183Z","updatedAt":"2026-11-05T17:43:17.183Z","decisionNote":null}]}`;
const DECIDE_STDOUT = `{"api":1,"ok":true,"finding":{"ref":"billing#1","repo":"billing","repoKey":"billing-c7d638836d","id":1,"title":"Invoice totals round per line","severity":"high","issueType":"defect","attribution":"introduced","proof":"source_proven","awareness":"unaware","riskAreas":["money"],"status":"deferred","statement":"Each line is rounded before summing.","failureCase":"100 lines of 0.005 drift the total by 50 cents.","whyItMatters":"Customers are overcharged.","nextAction":"Round once after summing.","handoffPrompt":"Round the invoice total once, after summing the lines.","evidence":[{"type":"file","path":"src/invoice.ts","lineStart":2,"quote":"lines.map((line) => round(line)).reduce((a, b) => a + b, 0);","check":"verified"}],"speech":{"action":"speak","why":"risky: high severity, money; unaware: nothing in the session mentions it","toldSession":false},"deliveredAt":null,"revision":"4f9c2a1b7e+wt.3d5e8a90","createdAt":"2026-11-05T17:43:17.183Z","updatedAt":"2026-11-05T17:43:24.822Z","decisionNote":"Fix lands with the tax rework."}}`;

const decodeFindings = Schema.decodeUnknownOption(Schema.fromJsonString(LookoutFindings));
const decodeDecision = Schema.decodeUnknownOption(Schema.fromJsonString(LookoutDecision));

describe("Lookout contracts", () => {
  it("decode real findings and decide output from Lookout", () => {
    const findings = Option.getOrThrow(decodeFindings(FINDINGS_STDOUT)).findings;
    expect(findings.map((finding) => [finding.ref, finding.status, finding.revision])).toEqual([
      ["billing#1", "open", "4f9c2a1b7e+wt.3d5e8a90"],
    ]);

    const decision = Option.getOrThrow(decodeDecision(DECIDE_STDOUT));
    expect(decision.finding.status).toBe("deferred");
    expect(decision.finding.decisionNote).toBe("Fix lands with the tax rework.");
  });
});
