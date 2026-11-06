import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  PilotAnswer,
  PilotAskInput,
  PilotChat,
  PilotChatInput,
  PilotDecision,
  PilotFindings,
  PilotNudgeInput,
  PilotNudgeResult,
  PilotStatus,
} from "./pilot.ts";

// Captured stdout of `pilot api findings` and `pilot api decide` (Pilot API 1) for one finding.
// Pilot reports `revision` as text: the git revision it checked, plus a working-tree suffix.
const FINDINGS_STDOUT = `{"api":1,"findings":[{"ref":"billing#1","repo":"billing","repoKey":"billing-c7d638836d","id":1,"title":"Invoice totals round per line","severity":"high","issueType":"defect","attribution":"introduced","proof":"source_proven","awareness":"unaware","riskAreas":["money"],"status":"open","statement":"Each line is rounded before summing.","failureCase":"100 lines of 0.005 drift the total by 50 cents.","whyItMatters":"Customers are overcharged.","nextAction":"Round once after summing.","handoffPrompt":"Round the invoice total once, after summing the lines.","evidence":[{"type":"file","path":"src/invoice.ts","lineStart":2,"quote":"lines.map((line) => round(line)).reduce((a, b) => a + b, 0);","check":"verified"}],"speech":{"action":"speak","why":"risky: high severity, money; unaware: nothing in the session mentions it","toldSession":false},"deliveredAt":null,"revision":"4f9c2a1b7e+wt.3d5e8a90","createdAt":"2026-11-05T17:43:17.183Z","updatedAt":"2026-11-05T17:43:17.183Z","decisionNote":null}]}`;
const DECIDE_STDOUT = `{"api":1,"ok":true,"finding":{"ref":"billing#1","repo":"billing","repoKey":"billing-c7d638836d","id":1,"title":"Invoice totals round per line","severity":"high","issueType":"defect","attribution":"introduced","proof":"source_proven","awareness":"unaware","riskAreas":["money"],"status":"deferred","statement":"Each line is rounded before summing.","failureCase":"100 lines of 0.005 drift the total by 50 cents.","whyItMatters":"Customers are overcharged.","nextAction":"Round once after summing.","handoffPrompt":"Round the invoice total once, after summing the lines.","evidence":[{"type":"file","path":"src/invoice.ts","lineStart":2,"quote":"lines.map((line) => round(line)).reduce((a, b) => a + b, 0);","check":"verified"}],"speech":{"action":"speak","why":"risky: high severity, money; unaware: nothing in the session mentions it","toldSession":false},"deliveredAt":null,"revision":"4f9c2a1b7e+wt.3d5e8a90","createdAt":"2026-11-05T17:43:17.183Z","updatedAt":"2026-11-05T17:43:24.822Z","decisionNote":"Fix lands with the tax rework."}}`;

// `pilot api chat`, `ask` and `nudge` replies as specified for Pilot's chat (API 1, additive).
const NUDGE = `{"id":41,"at":"2026-11-06T09:12:00.000Z","role":"pilot","kind":"nudge","nudgeKind":"rule","text":"Your rule says to merge only on \\"merge #N\\".","evidence":[{"source":"rule","where":"/Users/me/.claude/CLAUDE.md:12","quote":"Never merge a PR unless the user writes 'merge #<n>'","found":true}],"session":"5f0c2a9e-1b7d-4c1e-9f3a-2b8d6e4c1a70","sessionLabel":"billing · fix the invoice rounding","repo":"billing","state":"new"}`;
const CHAT_STDOUT = `{"api":1,"messages":[${NUDGE}],"unread":1}`;
const ASK_STDOUT = `{"api":1,"question":{"id":42,"at":"2026-11-06T09:13:00.000Z","role":"you","kind":"message","nudgeKind":null,"text":"what's waiting on me?","evidence":[],"session":null,"sessionLabel":null,"repo":null,"state":"seen"},"answer":{"id":43,"at":"2026-11-06T09:13:20.000Z","role":"pilot","kind":"answer","nudgeKind":null,"text":"A session asked which sandbox to use.","evidence":[{"source":"session","where":"orders · deploy · 2026-11-06T07:00:00.000Z","quote":"Should I use kciam or the w02283 sandbox?","found":false}],"session":null,"sessionLabel":null,"repo":null,"state":"seen"}}`;
const NUDGE_STDOUT = `{"api":1,"ok":true,"message":${NUDGE.replace('"state":"new"', '"state":"sent"')}}`;

const decodeFindings = Schema.decodeUnknownOption(Schema.fromJsonString(PilotFindings));
const decodeDecision = Schema.decodeUnknownOption(Schema.fromJsonString(PilotDecision));

describe("Pilot contracts", () => {
  it("decode real findings and decide output from Pilot", () => {
    const findings = Option.getOrThrow(decodeFindings(FINDINGS_STDOUT)).findings;
    expect(findings.map((finding) => [finding.ref, finding.status, finding.revision])).toEqual([
      ["billing#1", "open", "4f9c2a1b7e+wt.3d5e8a90"],
    ]);

    const decision = Option.getOrThrow(decodeDecision(DECIDE_STDOUT));
    expect(decision.finding.status).toBe("deferred");
    expect(decision.finding.decisionNote).toBe("Fix lands with the tax rework.");
  });
});

const decodeStatus = Schema.decodeUnknownOption(PilotStatus);
const decodeChat = Schema.decodeUnknownOption(Schema.fromJsonString(PilotChat));

describe("Pilot chat contracts", () => {
  const decode = <A, I>(schema: Schema.Codec<A, I>, text: string) =>
    Option.getOrThrow(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text));

  it("decode chat, ask and nudge replies", () => {
    const chat = decode(PilotChat, CHAT_STDOUT);
    expect(chat.unread).toBe(1);
    expect(chat.messages[0]).toMatchObject({ id: 41, kind: "nudge", nudgeKind: "rule" });

    const answer = decode(PilotAnswer, ASK_STDOUT);
    expect(answer.question.role).toBe("you");
    expect(answer.answer.evidence[0]).toMatchObject({ source: "session", found: false });

    expect(decode(PilotNudgeResult, NUDGE_STDOUT).message?.state).toBe("sent");
    // Marking every nudge seen may not name one.
    expect(decode(PilotNudgeResult, `{"api":1,"ok":true}`).message).toBeUndefined();
  });

  it("reads status from Pilot versions with and without chat", () => {
    const base = {
      generatedAt: "2026-11-06T09:00:00.000Z",
      daemon: { running: true, pid: 1, heartbeatAt: null },
      paused: false,
      profiles: [],
      home: "/h",
      mode: "local",
      claudeBin: "claude",
      delivery: "session",
      selftest: { ok: true, reason: "" },
      budget: { windowHours: 24, capCents: 1000, spentCents: 0, availableCents: 1000 },
      repos: [],
    };
    expect(Option.getOrThrow(decodeStatus(base)).unread).toBeUndefined();
    expect(
      Option.getOrThrow(decodeStatus({ ...base, unread: 2, sessions: 3, reviewWork: false })),
    ).toMatchObject({ unread: 2, sessions: 3, reviewWork: false });
  });

  it("reads Pilot's messages under their old role name too", () => {
    const old = decodeChat(CHAT_STDOUT.replace('"role":"pilot"', '"role":"lookout"'));
    expect(Option.getOrThrow(old).messages[0]?.role).toBe("lookout");
    expect(Option.isNone(decodeChat(CHAT_STDOUT.replace('"role":"pilot"', '"role":"bot"')))).toBe(
      true,
    );
  });

  it("refuses a nudge kind or state it does not know", () => {
    expect(
      Option.isNone(decodeChat(CHAT_STDOUT.replace('"nudgeKind":"rule"', '"nudgeKind":"style"'))),
    ).toBe(true);
    expect(
      Option.isNone(decodeChat(CHAT_STDOUT.replace('"state":"new"', '"state":"archived"'))),
    ).toBe(true);
  });

  it("limits what the app may ask Pilot to do", () => {
    const valid = <A, I>(schema: Schema.Codec<A, I>, value: unknown) =>
      Option.isSome(Schema.decodeUnknownOption(schema)(value));
    expect(valid(PilotAskInput, { text: "what's waiting on me?" })).toBe(true);
    expect(valid(PilotAskInput, { text: "x".repeat(4000) })).toBe(true);
    for (const text of ["", "   \n ", "x".repeat(4001), "a\0b"])
      expect(valid(PilotAskInput, { text })).toBe(false);

    expect(valid(PilotNudgeInput, { id: 41, action: "send" })).toBe(true);
    expect(valid(PilotNudgeInput, { all: true, action: "seen" })).toBe(true);
    for (const input of [
      { id: 41, action: "delete" },
      { id: 0, action: "seen" },
      { id: 1.5, action: "seen" },
      { all: true, action: "send" },
      { action: "seen" },
    ])
      expect(valid(PilotNudgeInput, input)).toBe(false);

    expect(valid(PilotChatInput, { since: 40, limit: 200 })).toBe(true);
    expect(valid(PilotChatInput, { since: -1 })).toBe(false);
  });
});
