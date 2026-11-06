import * as Schema from "effect/Schema";

// Pilot is a separate, local reviewer for Claude Code sessions. The desktop
// main process runs its `pilot api <method>` command (JSON API version 1)
// and forwards the decoded result. Structs ignore keys they do not know, so a
// newer Pilot can add fields; a changed enum or `api` version reads as
// "incompatible".

export const PilotSeverity = Schema.Literals(["critical", "high", "medium", "low"]);
export type PilotSeverity = typeof PilotSeverity.Type;

export const PilotFindingStatus = Schema.Literals([
  "open",
  "stale",
  "accepted",
  "dismissed",
  "deferred",
  "resolved",
  "unverified",
]);
export type PilotFindingStatus = typeof PilotFindingStatus.Type;

export const PilotEvidence = Schema.Struct({
  type: Schema.Literals(["file", "command", "event"]),
  path: Schema.optional(Schema.String),
  lineStart: Schema.optional(Schema.Number),
  quote: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  outputExcerpt: Schema.optional(Schema.String),
  check: Schema.NullOr(Schema.Literals(["verified", "failed", "unverifiable"])),
});
export type PilotEvidence = typeof PilotEvidence.Type;

/** Whether Pilot told the coding session about a finding, and why or why not. */
export const PilotSpeech = Schema.Struct({
  action: Schema.Literals(["speak", "inbox", "silent"]),
  why: Schema.String,
  toldSession: Schema.Boolean,
});
export type PilotSpeech = typeof PilotSpeech.Type;

export const PilotFinding = Schema.Struct({
  /** `<repo>#<id>`, the handle `decide` takes. */
  ref: Schema.String,
  repo: Schema.String,
  repoKey: Schema.String,
  id: Schema.Number,
  title: Schema.String,
  severity: Schema.NullOr(PilotSeverity),
  issueType: Schema.Literals(["defect", "decision", "suggestion"]),
  attribution: Schema.NullOr(Schema.String),
  proof: Schema.NullOr(Schema.String),
  awareness: Schema.NullOr(Schema.String),
  riskAreas: Schema.Array(Schema.String),
  status: PilotFindingStatus,
  statement: Schema.String,
  failureCase: Schema.NullOr(Schema.String),
  whyItMatters: Schema.String,
  nextAction: Schema.NullOr(Schema.String),
  handoffPrompt: Schema.NullOr(Schema.String),
  evidence: Schema.Array(PilotEvidence),
  speech: Schema.NullOr(PilotSpeech),
  deliveredAt: Schema.NullOr(Schema.String),
  /** The code revision Pilot last checked the finding at, such as `4f9c2a1b7e+wt.3d5e8a90`. */
  revision: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  decisionNote: Schema.NullOr(Schema.String),
});
export type PilotFinding = typeof PilotFinding.Type;

const PilotRun = {
  id: Schema.Number,
  kind: Schema.String,
  status: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  costCents: Schema.NullOr(Schema.Number),
  summary: Schema.String,
};

export const PilotRepo = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  root: Schema.String,
  lastEventAt: Schema.String,
  paused: Schema.Boolean,
  excluded: Schema.Boolean,
  pendingEvents: Schema.Number,
  openFindings: Schema.Number,
  toldSession: Schema.Number,
  activeJob: Schema.NullOr(
    Schema.Struct({
      id: Schema.Number,
      kind: Schema.String,
      status: Schema.String,
      startedAt: Schema.NullOr(Schema.String),
    }),
  ),
  lastRun: Schema.NullOr(Schema.Struct(PilotRun)),
});
export type PilotRepo = typeof PilotRepo.Type;

export const PilotStatus = Schema.Struct({
  generatedAt: Schema.String,
  daemon: Schema.Struct({
    running: Schema.Boolean,
    pid: Schema.NullOr(Schema.Number),
    heartbeatAt: Schema.NullOr(Schema.String),
  }),
  paused: Schema.Boolean,
  profiles: Schema.Array(Schema.String),
  home: Schema.String,
  mode: Schema.Literals(["local", "offline", "live"]),
  claudeBin: Schema.String,
  delivery: Schema.Literals(["session", "inbox"]),
  selftest: Schema.Struct({ ok: Schema.Boolean, reason: Schema.String }),
  budget: Schema.Struct({
    windowHours: Schema.Number,
    capCents: Schema.Number,
    spentCents: Schema.Number,
    availableCents: Schema.Number,
  }),
  repos: Schema.Array(PilotRepo),
  /** Pilot nudges the person has not seen yet. Absent from Pilot versions without chat. */
  unread: Schema.optional(Schema.Number),
  /** Claude Code sessions active in the last 6 hours. */
  sessions: Schema.optional(Schema.Number),
  /** Whether Pilot also reviews finished work (off by default since chat). */
  reviewWork: Schema.optional(Schema.Boolean),
});
export type PilotStatus = typeof PilotStatus.Type;

export const PilotFindings = Schema.Struct({ findings: Schema.Array(PilotFinding) });
export type PilotFindings = typeof PilotFindings.Type;

/** Activity carries kinds, paths and statuses only; never prompt text or file contents. */
export const PilotActivityEvent = Schema.Struct({
  at: Schema.String,
  repo: Schema.String,
  kind: Schema.Literals(["prompt", "edit", "test", "stop"]),
  session: Schema.NullOr(Schema.String),
  agentType: Schema.NullOr(Schema.String),
  path: Schema.optional(Schema.String),
  testStatus: Schema.optional(Schema.String),
});
export type PilotActivityEvent = typeof PilotActivityEvent.Type;

export const PilotActivityRun = Schema.Struct({
  ...PilotRun,
  repo: Schema.String,
  trigger: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
});
export type PilotActivityRun = typeof PilotActivityRun.Type;

export const PilotActivity = Schema.Struct({
  events: Schema.Array(PilotActivityEvent),
  runs: Schema.Array(PilotActivityRun),
});
export type PilotActivity = typeof PilotActivity.Type;

export const PilotDecision = Schema.Struct({ ok: Schema.Literal(true), finding: PilotFinding });
export type PilotDecision = typeof PilotDecision.Type;

export const PilotPauseState = Schema.Struct({
  ok: Schema.Literal(true),
  paused: Schema.Boolean,
  /** "all", or the repository name the change applied to. */
  scope: Schema.String,
});
export type PilotPauseState = typeof PilotPauseState.Type;

/**
 * What a nudge says the person is forgetting: a standing rule, something they
 * said earlier, something waiting on them, a detail the session lacks, or a
 * fact that matters before something hard to undo.
 */
export const PilotNudgeKind = Schema.Literals(["rule", "earlier", "pending", "missing", "risky"]);
export type PilotNudgeKind = typeof PilotNudgeKind.Type;

export const PilotMessageState = Schema.Literals([
  "new",
  "seen",
  "sent",
  "dismissed",
  "useful",
  "not_useful",
]);
export type PilotMessageState = typeof PilotMessageState.Type;

/**
 * One exact quote behind a nudge or answer. `where` is `path:line` for rules
 * and memory, and `session label · time` for prompts and session messages.
 * `found` is false when Pilot could not find the quote in its source.
 */
export const PilotQuote = Schema.Struct({
  source: Schema.Literals(["rule", "memory", "prompt", "session", "nudge"]),
  where: Schema.String,
  quote: Schema.String,
  found: Schema.Boolean,
});
export type PilotQuote = typeof PilotQuote.Type;

/** One entry in the Pilot chat thread; quotes and text are redacted by Pilot before storage. */
export const PilotMessage = Schema.Struct({
  id: Schema.Number,
  at: Schema.String,
  /** "lookout" is the same role from builds before the rename to Pilot. */
  role: Schema.Literals(["you", "pilot", "lookout"]),
  kind: Schema.Literals(["nudge", "answer", "message", "note"]),
  nudgeKind: Schema.NullOr(PilotNudgeKind),
  text: Schema.String,
  evidence: Schema.Array(PilotQuote),
  session: Schema.NullOr(Schema.String),
  /** Repository name, " · ", and the session's first prompt (at most 40 characters). */
  sessionLabel: Schema.NullOr(Schema.String),
  repo: Schema.NullOr(Schema.String),
  state: PilotMessageState,
});
export type PilotMessage = typeof PilotMessage.Type;

export const PilotChat = Schema.Struct({
  messages: Schema.Array(PilotMessage),
  unread: Schema.Number,
});
export type PilotChat = typeof PilotChat.Type;

export const PilotAnswer = Schema.Struct({
  question: PilotMessage,
  answer: PilotMessage,
});
export type PilotAnswer = typeof PilotAnswer.Type;

/** `message` is the nudge after the change; a change to every nudge (`all`) may return none. */
export const PilotNudgeResult = Schema.Struct({
  ok: Schema.Literal(true),
  message: Schema.optional(Schema.NullOr(PilotMessage)),
});
export type PilotNudgeResult = typeof PilotNudgeResult.Type;

/** Whether a question was still waiting for Pilot's answer when it was cancelled. */
export const PilotCancelAskResult = Schema.Struct({ cancelled: Schema.Boolean });
export type PilotCancelAskResult = typeof PilotCancelAskResult.Type;

const PilotRepoSelector = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));

export const PilotFindingsInput = Schema.Struct({
  repo: Schema.optional(PilotRepoSelector),
  /** Every status except unverified, instead of only open and stale findings. */
  all: Schema.optional(Schema.Boolean),
});
export type PilotFindingsInput = typeof PilotFindingsInput.Type;

export const PilotActivityInput = Schema.Struct({
  repo: Schema.optional(PilotRepoSelector),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
});
export type PilotActivityInput = typeof PilotActivityInput.Type;

export const PilotDecideAction = Schema.Literals(["accept", "dismiss", "defer", "reopen"]);
export type PilotDecideAction = typeof PilotDecideAction.Type;

export const PILOT_NOTE_MAX_LENGTH = 2000;

export const PilotDecideInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMaxLength(256)),
  action: PilotDecideAction,
  /** Required for accept, dismiss and defer: the reviewer reads it on later runs. */
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(PILOT_NOTE_MAX_LENGTH))),
  /** ISO date a deferral ends. */
  until: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export type PilotDecideInput = typeof PilotDecideInput.Type;

/** Without `repo`, pausing or resuming applies to every watched repository. */
export const PilotPauseInput = Schema.Struct({ repo: Schema.optional(PilotRepoSelector) });
export type PilotPauseInput = typeof PilotPauseInput.Type;

const PilotMessageId = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

/** Without `since`, the newest messages; with it, only messages after that id. */
export const PilotChatInput = Schema.Struct({
  since: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  ),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
});
export type PilotChatInput = typeof PilotChatInput.Type;

export const PILOT_ASK_MAX_LENGTH = 4000;

export const PilotAskInput = Schema.Struct({
  text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PILOT_ASK_MAX_LENGTH),
    // Something to ask, and nothing a command line cannot carry.
    Schema.isPattern(/\S/),
    Schema.isPattern(/^[^\0]*$/),
  ),
});
export type PilotAskInput = typeof PilotAskInput.Type;

export const PilotNudgeAction = Schema.Literals([
  "send",
  "seen",
  "dismiss",
  "useful",
  "not_useful",
]);
export type PilotNudgeAction = typeof PilotNudgeAction.Type;

/** One nudge by id, or every unseen nudge at once (marking them seen is the only bulk action). */
export const PilotNudgeInput = Schema.Union([
  Schema.Struct({ id: PilotMessageId, action: PilotNudgeAction }),
  Schema.Struct({ all: Schema.Literal(true), action: Schema.Literal("seen") }),
]);
export type PilotNudgeInput = typeof PilotNudgeInput.Type;

/**
 * Why a call returned no value: the input was rejected before running Pilot,
 * Pilot reported an error, it did not answer in time, it could not start
 * (for example `node` is missing from PATH), it speaks another API version, or
 * the person cancelled the question.
 */
export const PilotFailureReason = Schema.Literals([
  "invalid",
  "failed",
  "timeout",
  "unavailable",
  "incompatible",
  "cancelled",
]);
export type PilotFailureReason = typeof PilotFailureReason.Type;

const PilotNotInstalled = Schema.Struct({
  installed: Schema.Literal(false),
  /** Where the app looked for Pilot's launcher. */
  launcher: Schema.String,
});
const PilotFailure = Schema.Struct({
  installed: Schema.Literal(true),
  ok: Schema.Literal(false),
  reason: PilotFailureReason,
  error: Schema.String,
});

const pilotResponse = <S extends Schema.Top>(value: S) =>
  Schema.Union([
    PilotNotInstalled,
    PilotFailure,
    Schema.Struct({ installed: Schema.Literal(true), ok: Schema.Literal(true), value }),
  ]);

export const PilotStatusResponse = pilotResponse(PilotStatus);
export const PilotFindingsResponse = pilotResponse(PilotFindings);
export const PilotActivityResponse = pilotResponse(PilotActivity);
export const PilotDecisionResponse = pilotResponse(PilotDecision);
export const PilotPauseResponse = pilotResponse(PilotPauseState);
export const PilotChatResponse = pilotResponse(PilotChat);
export const PilotAnswerResponse = pilotResponse(PilotAnswer);
export const PilotNudgeResponse = pilotResponse(PilotNudgeResult);

export type PilotResponse<T> =
  | typeof PilotNotInstalled.Type
  | typeof PilotFailure.Type
  | { readonly installed: true; readonly ok: true; readonly value: T };

/** Every method resolves with a response; only an untrusted caller or a malformed payload rejects. */
export interface PilotBridge {
  status(): Promise<PilotResponse<PilotStatus>>;
  findings(input: PilotFindingsInput): Promise<PilotResponse<PilotFindings>>;
  activity(input: PilotActivityInput): Promise<PilotResponse<PilotActivity>>;
  decide(input: PilotDecideInput): Promise<PilotResponse<PilotDecision>>;
  pause(input: PilotPauseInput): Promise<PilotResponse<PilotPauseState>>;
  resume(input: PilotPauseInput): Promise<PilotResponse<PilotPauseState>>;
  chat(input: PilotChatInput): Promise<PilotResponse<PilotChat>>;
  /** Waits for Pilot's answer (up to about a minute); `cancelAsk` ends the wait early. */
  ask(input: PilotAskInput): Promise<PilotResponse<PilotAnswer>>;
  cancelAsk(): Promise<PilotCancelAskResult>;
  nudge(input: PilotNudgeInput): Promise<PilotResponse<PilotNudgeResult>>;
}
