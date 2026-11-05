import * as Schema from "effect/Schema";

// Lookout is a separate, local reviewer for Claude Code sessions. The desktop
// main process runs its `lookout api <method>` command (JSON API version 1)
// and forwards the decoded result. Structs ignore keys they do not know, so a
// newer Lookout can add fields; a changed enum or `api` version reads as
// "incompatible".

export const LookoutSeverity = Schema.Literals(["critical", "high", "medium", "low"]);
export type LookoutSeverity = typeof LookoutSeverity.Type;

export const LookoutFindingStatus = Schema.Literals([
  "open",
  "stale",
  "accepted",
  "dismissed",
  "deferred",
  "resolved",
  "unverified",
]);
export type LookoutFindingStatus = typeof LookoutFindingStatus.Type;

export const LookoutEvidence = Schema.Struct({
  type: Schema.Literals(["file", "command", "event"]),
  path: Schema.optional(Schema.String),
  lineStart: Schema.optional(Schema.Number),
  quote: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  outputExcerpt: Schema.optional(Schema.String),
  check: Schema.NullOr(Schema.Literals(["verified", "failed", "unverifiable"])),
});
export type LookoutEvidence = typeof LookoutEvidence.Type;

/** Whether Lookout told the coding session about a finding, and why or why not. */
export const LookoutSpeech = Schema.Struct({
  action: Schema.Literals(["speak", "inbox", "silent"]),
  why: Schema.String,
  toldSession: Schema.Boolean,
});
export type LookoutSpeech = typeof LookoutSpeech.Type;

export const LookoutFinding = Schema.Struct({
  /** `<repo>#<id>`, the handle `decide` takes. */
  ref: Schema.String,
  repo: Schema.String,
  repoKey: Schema.String,
  id: Schema.Number,
  title: Schema.String,
  severity: Schema.NullOr(LookoutSeverity),
  issueType: Schema.Literals(["defect", "decision", "suggestion"]),
  attribution: Schema.NullOr(Schema.String),
  proof: Schema.NullOr(Schema.String),
  awareness: Schema.NullOr(Schema.String),
  riskAreas: Schema.Array(Schema.String),
  status: LookoutFindingStatus,
  statement: Schema.String,
  failureCase: Schema.NullOr(Schema.String),
  whyItMatters: Schema.String,
  nextAction: Schema.NullOr(Schema.String),
  handoffPrompt: Schema.NullOr(Schema.String),
  evidence: Schema.Array(LookoutEvidence),
  speech: Schema.NullOr(LookoutSpeech),
  deliveredAt: Schema.NullOr(Schema.String),
  /** The code revision Lookout last checked the finding at, such as `4f9c2a1b7e+wt.3d5e8a90`. */
  revision: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  decisionNote: Schema.NullOr(Schema.String),
});
export type LookoutFinding = typeof LookoutFinding.Type;

const LookoutRun = {
  id: Schema.Number,
  kind: Schema.String,
  status: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  costCents: Schema.NullOr(Schema.Number),
  summary: Schema.String,
};

export const LookoutRepo = Schema.Struct({
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
  lastRun: Schema.NullOr(Schema.Struct(LookoutRun)),
});
export type LookoutRepo = typeof LookoutRepo.Type;

export const LookoutStatus = Schema.Struct({
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
  repos: Schema.Array(LookoutRepo),
});
export type LookoutStatus = typeof LookoutStatus.Type;

export const LookoutFindings = Schema.Struct({ findings: Schema.Array(LookoutFinding) });
export type LookoutFindings = typeof LookoutFindings.Type;

/** Activity carries kinds, paths and statuses only; never prompt text or file contents. */
export const LookoutActivityEvent = Schema.Struct({
  at: Schema.String,
  repo: Schema.String,
  kind: Schema.Literals(["prompt", "edit", "test", "stop"]),
  session: Schema.NullOr(Schema.String),
  agentType: Schema.NullOr(Schema.String),
  path: Schema.optional(Schema.String),
  testStatus: Schema.optional(Schema.String),
});
export type LookoutActivityEvent = typeof LookoutActivityEvent.Type;

export const LookoutActivityRun = Schema.Struct({
  ...LookoutRun,
  repo: Schema.String,
  trigger: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
});
export type LookoutActivityRun = typeof LookoutActivityRun.Type;

export const LookoutActivity = Schema.Struct({
  events: Schema.Array(LookoutActivityEvent),
  runs: Schema.Array(LookoutActivityRun),
});
export type LookoutActivity = typeof LookoutActivity.Type;

export const LookoutDecision = Schema.Struct({ ok: Schema.Literal(true), finding: LookoutFinding });
export type LookoutDecision = typeof LookoutDecision.Type;

export const LookoutPauseState = Schema.Struct({
  ok: Schema.Literal(true),
  paused: Schema.Boolean,
  /** "all", or the repository name the change applied to. */
  scope: Schema.String,
});
export type LookoutPauseState = typeof LookoutPauseState.Type;

const LookoutRepoSelector = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));

export const LookoutFindingsInput = Schema.Struct({
  repo: Schema.optional(LookoutRepoSelector),
  /** Every status except unverified, instead of only open and stale findings. */
  all: Schema.optional(Schema.Boolean),
});
export type LookoutFindingsInput = typeof LookoutFindingsInput.Type;

export const LookoutActivityInput = Schema.Struct({
  repo: Schema.optional(LookoutRepoSelector),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
});
export type LookoutActivityInput = typeof LookoutActivityInput.Type;

export const LookoutDecideAction = Schema.Literals(["accept", "dismiss", "defer", "reopen"]);
export type LookoutDecideAction = typeof LookoutDecideAction.Type;

export const LOOKOUT_NOTE_MAX_LENGTH = 2000;

export const LookoutDecideInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMaxLength(256)),
  action: LookoutDecideAction,
  /** Required for accept, dismiss and defer: the reviewer reads it on later runs. */
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(LOOKOUT_NOTE_MAX_LENGTH))),
  /** ISO date a deferral ends. */
  until: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export type LookoutDecideInput = typeof LookoutDecideInput.Type;

/** Without `repo`, pausing or resuming applies to every watched repository. */
export const LookoutPauseInput = Schema.Struct({ repo: Schema.optional(LookoutRepoSelector) });
export type LookoutPauseInput = typeof LookoutPauseInput.Type;

/**
 * Why a call returned no value: the input was rejected before running Lookout,
 * Lookout reported an error, it did not answer in time, it could not start
 * (for example `node` is missing from PATH), or it speaks another API version.
 */
export const LookoutFailureReason = Schema.Literals([
  "invalid",
  "failed",
  "timeout",
  "unavailable",
  "incompatible",
]);
export type LookoutFailureReason = typeof LookoutFailureReason.Type;

const LookoutNotInstalled = Schema.Struct({
  installed: Schema.Literal(false),
  /** Where the app looked for Lookout's launcher. */
  launcher: Schema.String,
});
const LookoutFailure = Schema.Struct({
  installed: Schema.Literal(true),
  ok: Schema.Literal(false),
  reason: LookoutFailureReason,
  error: Schema.String,
});

const lookoutResponse = <S extends Schema.Top>(value: S) =>
  Schema.Union([
    LookoutNotInstalled,
    LookoutFailure,
    Schema.Struct({ installed: Schema.Literal(true), ok: Schema.Literal(true), value }),
  ]);

export const LookoutStatusResponse = lookoutResponse(LookoutStatus);
export const LookoutFindingsResponse = lookoutResponse(LookoutFindings);
export const LookoutActivityResponse = lookoutResponse(LookoutActivity);
export const LookoutDecisionResponse = lookoutResponse(LookoutDecision);
export const LookoutPauseResponse = lookoutResponse(LookoutPauseState);

export type LookoutResponse<T> =
  | typeof LookoutNotInstalled.Type
  | typeof LookoutFailure.Type
  | { readonly installed: true; readonly ok: true; readonly value: T };

/** Every method resolves with a response; only an untrusted caller or a malformed payload rejects. */
export interface LookoutBridge {
  status(): Promise<LookoutResponse<LookoutStatus>>;
  findings(input: LookoutFindingsInput): Promise<LookoutResponse<LookoutFindings>>;
  activity(input: LookoutActivityInput): Promise<LookoutResponse<LookoutActivity>>;
  decide(input: LookoutDecideInput): Promise<LookoutResponse<LookoutDecision>>;
  pause(input: LookoutPauseInput): Promise<LookoutResponse<LookoutPauseState>>;
  resume(input: LookoutPauseInput): Promise<LookoutResponse<LookoutPauseState>>;
}
