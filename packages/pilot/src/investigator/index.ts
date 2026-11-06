import type { DriveResult } from "./sessionDriver.ts";

export interface MatchContext {
  kind: string;
  diff: string;
  eventsText: string;
  approach: string;
  readFile: (rel: string) => string | null;
}

export interface RunSpec {
  jobId: number;
  repoRoot: string;
  kind: string;
  depth: "quick" | "deep";
  phases: string[];
  bundlePath: string;
  sessionBudgetCents: number;
  deadlineMs: number;
  title: string;
  metadata: Record<string, string>;
  existingSessionId: string | null;
  match: MatchContext;
  shouldStop: () => boolean;
  onUpload: (fileId: string) => void;
  onSessionCreated: (sessionId: string) => void;
  log: (msg: string) => void;
}

export type Runtime = "live" | "local-claude" | "offline-fixture";

/** Subscription/plan usage limit: not a failure of the job; hold and retry later. */
export class QuotaHoldError extends Error {
  readonly quotaHold = true;
  costCents = 0; // spent by this attempt before the limit hit
}

export interface RunOutcome {
  runtime: Runtime;
  sessionId: string;
  drive: DriveResult;
  listCostCents: number | null;
  costSource: "platform" | "platform-upper-bound" | "estimate" | "subscription-estimate" | "subscription-upper-bound" | "simulated" | "none";
  usage: Record<string, unknown> | null;
  consoleUrl?: string;
  fixture?: string;
}

export interface Investigator {
  readonly runtime: Runtime;
  run(spec: RunSpec): Promise<RunOutcome>;
  /** Find a session created for this job before a crash (create is not idempotent). */
  findOrphan(jobId: number, repoId: string): Promise<string | null>;
  interrupt(sessionId: string): Promise<void>;
  deleteUploads(fileIds: string[]): Promise<void>;
  /** Stop every run this process owns (local runtime). */
  stopAll?(): Promise<void>;
}

export const BUNDLE_MOUNT = "/mnt/session/uploads/lookout/bundle.tgz";
