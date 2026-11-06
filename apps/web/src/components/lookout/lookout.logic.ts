import type {
  LookoutActivityEvent,
  LookoutActivityRun,
  LookoutMessage,
  LookoutMessageState,
  LookoutNudgeKind,
  LookoutQuote,
  LookoutRepo,
  LookoutResponse,
  LookoutStatus,
} from "@starkfuture/contracts";
import { formatRelativeTimeLabel } from "../../timestampFormat";

export type LookoutWatchState = "watching" | "paused" | "not-running" | "not-installed" | "unknown";

/**
 * One word for the status dot: is Lookout watching right now? A stopped
 * daemon is "not running" even when paused, so "Watching" never shows beside it.
 */
export function lookoutWatchState(
  response: LookoutResponse<LookoutStatus> | null,
): LookoutWatchState {
  if (response === null) return "unknown";
  if (!response.installed) return "not-installed";
  if (!response.ok) return "unknown";
  if (!response.value.daemon.running) return "not-running";
  return response.value.paused ? "paused" : "watching";
}

export const WATCH_STATE_LABELS: Record<LookoutWatchState, string> = {
  watching: "Watching",
  paused: "Paused",
  "not-running": "Not running",
  "not-installed": "Not installed",
  unknown: "Checking",
};

/** Lookout versions before the chat report no unread count and have no `chat` method. */
export const chatSupported = (status: LookoutStatus) => status.unread !== undefined;

/** Dollars with cents, or whole dollars when there are none: "$1.20", "$10". */
export function formatDollars(cents: number): string {
  const value = Math.max(0, cents) / 100;
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

/** "$1.20 of $10 today" for Lookout's usual 24-hour window. */
export function budgetLabel(budget: LookoutStatus["budget"]): string {
  const window = budget.windowHours === 24 ? "today" : `in the last ${budget.windowHours} h`;
  return `${formatDollars(budget.spentCents)} of ${formatDollars(budget.capCents)} ${window}`;
}

/** The empty thread's promise, which never says "Watching" unless Lookout is. */
export function emptyThreadText(state: LookoutWatchState, sessions: number | undefined): string {
  if (state === "not-running") return "Lookout starts with your next Claude Code session.";
  if (state === "paused") return "Lookout is paused. Resume it to hear when you forget something.";
  const watching =
    sessions === undefined || sessions <= 0
      ? "Watching your Claude Code sessions."
      : `Watching ${sessions === 1 ? "1 session" : `${sessions} sessions`}.`;
  return `${watching} Lookout speaks up when you're about to forget something.`;
}

export const NUDGE_KIND_LABELS: Record<LookoutNudgeKind, string> = {
  rule: "Your rule",
  earlier: "You said earlier",
  pending: "Waiting on you",
  missing: "Missing detail",
  risky: "Hard to undo",
};

export const NUDGE_KIND_BADGES = {
  rule: "info",
  earlier: "secondary",
  pending: "warning",
  missing: "secondary",
  risky: "error",
} as const satisfies Record<LookoutNudgeKind, string>;

/** What happened to a nudge after the person acted on it, or null while it still waits. */
export function nudgeOutcome(state: LookoutMessageState): string | null {
  switch (state) {
    case "sent":
      return "Sent to the session";
    case "useful":
      return "Got it";
    case "not_useful":
      return "Marked not useful";
    case "dismissed":
      return "Dismissed";
    default:
      return null;
  }
}

/** Lookout's words for a refused nudge action, in words for the person. */
export function nudgeErrorText(error: string): string {
  return /session ended/i.test(error)
    ? "That session has ended, so this can't go into its next turn."
    : error;
}

/** The thread in id order, with each message replaced by its newest copy. */
export function mergeMessages(
  current: readonly LookoutMessage[],
  incoming: readonly LookoutMessage[],
): LookoutMessage[] {
  if (incoming.length === 0) return current as LookoutMessage[];
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].toSorted((a, b) => a.id - b.id);
}

export const newestMessageId = (messages: readonly LookoutMessage[]) =>
  messages.length === 0 ? null : messages[messages.length - 1]!.id;

/**
 * Whether the question being answered still needs its own bubble: Lookout may
 * store the question before it answers, and the next poll then shows it.
 */
export function pendingQuestionShown(
  messages: readonly LookoutMessage[],
  pending: { readonly text: string; readonly afterId: number | null },
): boolean {
  const text = pending.text.trim();
  return !messages.some(
    (message) =>
      message.role === "you" &&
      (pending.afterId === null || message.id > pending.afterId) &&
      message.text.trim() === text,
  );
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Splits `session label · time` into the label and a time, with an ISO time made relative. */
function splitWhere(where: string): { label: string; time: string | null } {
  const parts = where
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  const last = parts.at(-1);
  if (last === undefined || !ISO_TIME.test(last)) return { label: parts.join(" · "), time: null };
  return { label: parts.slice(0, -1).join(" · "), time: formatRelativeTimeLabel(last) || last };
}

/** `/Users/me/.claude/CLAUDE.md:12` reads as `CLAUDE.md:12`. */
function fileLabel(where: string): string {
  return where.split(/[\\/]/).findLast(Boolean) ?? where;
}

/** Where a quote comes from, in plain words: "CLAUDE.md:12", "You, in billing · fix rounding · 2h ago". */
export function quoteSourceLabel(quote: Pick<LookoutQuote, "source" | "where">): string {
  switch (quote.source) {
    case "rule":
    case "memory":
      return fileLabel(quote.where);
    case "prompt":
    case "session":
    case "nudge": {
      const { label, time } = splitWhere(quote.where);
      const who =
        quote.source === "prompt"
          ? "You"
          : quote.source === "session"
            ? "The session said"
            : "Lookout said earlier";
      const place = label ? `${who}, in ${label}` : who;
      // The time ("2h ago") never breaks across lines.
      return time ? `${place} ·\u00a0${time.replaceAll(" ", "\u00a0")}` : place;
    }
  }
}

const trimSeparators = (path: string) => path.replace(/[\\/]+$/, "");

/**
 * The watched repository that contains `projectRoot`, preferring the deepest
 * root when repositories nest (a worktree inside a checkout).
 */
export function repoForPath(
  repos: readonly Pick<LookoutRepo, "key" | "root">[],
  projectRoot: string | null | undefined,
): string | null {
  if (!projectRoot) return null;
  const target = trimSeparators(projectRoot);
  let best: { key: string; length: number } | null = null;
  for (const repo of repos) {
    const root = trimSeparators(repo.root);
    if (!root) continue;
    const inside =
      target === root || target.startsWith(`${root}/`) || target.startsWith(`${root}\\`);
    if (inside && (best === null || root.length > best.length))
      best = { key: repo.key, length: root.length };
  }
  return best?.key ?? null;
}

const RUN_KINDS: Record<string, string> = {
  intent: "Checked a prompt",
  prompt: "Checked a prompt",
  "prompt-check": "Checked a prompt",
  checkpoint: "Reviewed changes",
  deep: "Looked deeper",
  manual: "Review you asked for",
  onboarding: "First look at the repository",
  ask: "Answered your question",
};

const RUN_STATUSES: Record<string, string> = {
  queued: "Waiting",
  starting: "Starting",
  running: "Running now",
  done: "Done",
  skipped: "Nothing new to check",
  failed: "Failed",
  timed_out: "Took too long",
  budget_reached: "Stopped at the budget",
  cancelled: "Cancelled",
};

const RUN_TRIGGERS: Record<string, string> = {
  prompt: "after your prompt",
  stop: "when a turn ended",
  test: "after tests ran",
  "edits-idle": "after edits went quiet",
  "changed-outside-edits": "after files changed outside the session",
  manual: "on request",
  escalation: "to look closer",
  onboard: "when Lookout started watching",
};

/**
 * A run summary without Lookout's internal markup: phase tags such as
 * "[checkpoint]", "finding(s)", snapshot ids and pointers to the CLI.
 */
export function plainRunSummary(summary: string): string {
  const lines = summary
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(\[[^\]]*\]\s*)+/, "")
        .replace(/\s*\[[A-Z][^\]]*\]/g, "")
        .replace(/\s*\(details: lookout runs\)/gi, "")
        .replace(/\b(\d+) finding\(s\)/g, (_, count: string) =>
          count === "1" ? "1 finding" : `${count} findings`,
        )
        .replace(/^no change since last assessment\b.*$/i, "No change since the last check")
        .trim(),
    )
    .filter(Boolean);
  const text = lines.join(" ");
  return text ? text[0]!.toUpperCase() + text.slice(1) : "";
}

/** One Lookout run in plain words; unknown kinds, statuses and triggers are left out, never shown raw. */
export function describeRun(run: LookoutActivityRun): {
  readonly title: string;
  readonly detail: string;
  readonly summary: string | null;
} {
  const kind = RUN_KINDS[run.kind] ?? "Lookout check";
  const status = RUN_STATUSES[run.status];
  const trigger = run.trigger
    ?.split("+")
    .map((part) => RUN_TRIGGERS[part])
    .find(Boolean);
  const finished = run.status === "done" || run.status === "skipped";
  return {
    title: `${kind} in ${run.repo}`,
    detail: [status, trigger].filter(Boolean).join(", "),
    // Other summaries carry the failure's internal reason; the status already says what happened.
    summary: finished ? plainRunSummary(run.summary) || null : null,
  };
}

/** One session event in plain words. */
export function describeEvent(event: LookoutActivityEvent): string {
  const subagent = event.agentType ? " (subagent)" : "";
  switch (event.kind) {
    case "prompt":
      return event.agentType ? "A subagent got a prompt" : "You sent a prompt";
    case "edit":
      return `Changed a file${subagent}`;
    case "test":
      return event.testStatus === "passed"
        ? `Tests passed${subagent}`
        : event.testStatus === "failed"
          ? `Tests failed${subagent}`
          : `Tests ran${subagent}`;
    case "stop":
      return `A turn ended${subagent}`;
  }
}

/** Pairs each item with a stable React key; repeats of the same base get a counter. */
export function withKeys<T>(items: readonly T[], keyOf: (item: T) => string) {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = keyOf(item);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { key: count === 0 ? base : `${base}~${count}`, item };
  });
}
