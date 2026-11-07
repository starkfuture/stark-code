import type {
  PilotActivityEvent,
  PilotActivityRun,
  PilotEngine,
  PilotInstallStatus,
  PilotMessage,
  PilotMessageState,
  PilotNudgeKind,
  PilotQuote,
  PilotRepo,
  PilotResponse,
  PilotSettings,
  PilotStatus,
} from "@starkfuture/contracts";
import { formatRelativeTimeLabel } from "../../timestampFormat";

export type PilotWatchState = "watching" | "paused" | "not-running" | "not-installed" | "unknown";

/**
 * One word for the status dot: is Pilot watching right now? A stopped
 * daemon is "not running" even when paused, so "Watching" never shows beside it.
 */
export function pilotWatchState(response: PilotResponse<PilotStatus> | null): PilotWatchState {
  if (response === null) return "unknown";
  if (!response.installed) return "not-installed";
  if (!response.ok) return "unknown";
  if (!response.value.daemon.running) return "not-running";
  return response.value.paused ? "paused" : "watching";
}

export const WATCH_STATE_LABELS: Record<PilotWatchState, string> = {
  watching: "Watching",
  paused: "Paused",
  "not-running": "Not running",
  "not-installed": "Not installed",
  unknown: "Checking",
};

export const ENGINE_LABELS: Record<PilotEngine, string> = { claude: "Claude", codex: "Codex" };

/** Codex runs on the person's own plan, so its choice always says so. */
export function codexPlanLabel(codex: PilotSettings["engines"]["codex"]): string {
  const left = codex.runsLeftToday;
  return `Uses your Codex plan · ${left === 1 ? "1 run" : `${left} runs`} left today`;
}

const isLookout = (id: string) => id.startsWith("lookout@");

const listNames = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** The button the panel offers for Claude Code's Pilot, or null when there is nothing to do. */
export function installAction(
  status: PilotInstallStatus | null,
): "Install" | "Update" | "Remove" | null {
  if (status === null) return null;
  if (status.state === "update") return "Update";
  if (status.state === "legacy") return status.installsCopy ? "Install" : "Remove";
  return status.state === "not-installed" ? "Install" : null;
}

/** One short line on what Install, Update or Remove is about; paths stay in the details. */
export function installHeadline(status: PilotInstallStatus): string {
  if (status.state === "update") return `Pilot ${status.bundledVersion} is available.`;
  if (status.state !== "legacy") return "Pilot isn't installed in Claude Code.";
  const other = status.replaces.find((plugin) => !isLookout(plugin.id));
  if (other)
    return other.source
      ? `Replaces the Pilot running from ${other.source.replace(/\/+$/, "").split("/").pop()}.`
      : `Replaces the Pilot installed as ${other.id}.`;
  return status.installsCopy ? "Replaces Lookout." : "Lookout still runs beside Pilot.";
}

/** What must happen before installing, in one line, or null. */
export function installBlocker(status: PilotInstallStatus): string | null {
  return status.missingSettings.length > 0
    ? `Add ${listNames(status.missingSettings)} to ${status.configFile} first.`
    : null;
}

/** Where things go and what changes, for the details under the headline. */
export function installDetails(
  status: PilotInstallStatus,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  return [
    { label: "Claude Code", value: status.profile },
    ...(status.installsCopy && status.target
      ? [{ label: "Copies to", value: `${status.target} (Pilot ${status.bundledVersion})` }]
      : []),
    ...status.replaces.map((plugin) => ({
      label: "Replaces",
      value: plugin.source ? `${plugin.id} from ${plugin.source}` : plugin.id,
    })),
    { label: "Thinks with", value: status.claudeBin ?? "claude from your PATH" },
    {
      label: "Settings",
      value:
        status.carriedSettings.length > 0
          ? `Carries ${listNames(status.carriedSettings)} into ${status.configFile}`
          : status.missingSettings.length > 0
            ? `Could not read ${listNames(status.missingSettings)} from the Pilot being replaced`
            : status.configFile,
    },
  ];
}

export type PilotStatusLine = {
  readonly kind: "error" | "on-hold" | "installed" | "not-running" | "budget";
  readonly text: string;
};

/**
 * The one status line above the thread, by priority: what just failed, a
 * self-test hold, a fresh install, Pilot not running, then the budget.
 */
export function pilotStatusLine(input: {
  readonly error: string | null;
  readonly status: Pick<PilotStatus, "selftest" | "budget">;
  readonly watch: PilotWatchState;
  readonly pluginInstalled: boolean;
  readonly installedVersion: string | null;
  readonly selftest: "idle" | "running" | "failed";
}): PilotStatusLine | null {
  if (input.error) return { kind: "error", text: input.error };
  if (!input.pluginInstalled) return null;
  if (!input.status.selftest.ok)
    return {
      kind: "on-hold",
      text:
        input.selftest === "running"
          ? "Running the self-test. It takes about a minute."
          : input.selftest === "failed"
            ? "The self-test did not pass, so Pilot stays on hold."
            : "Pilot is on hold until it passes a self-test.",
    };
  if (input.installedVersion)
    return {
      kind: "installed",
      text: `Pilot ${input.installedVersion} is installed. ${input.watch === "not-running" ? "It starts with your next Claude Code session." : "New Claude Code sessions use it."}`,
    };
  if (input.watch === "not-running")
    return {
      kind: "not-running",
      text: "Pilot isn't running. It starts with your next Claude Code session.",
    };
  if (input.status.budget.availableCents <= 0)
    return {
      kind: "budget",
      text: "Today's budget is used up. Pilot speaks up again when budget frees.",
    };
  return null;
}

/** Pilot versions before the chat report no unread count and have no `chat` method. */
export const chatSupported = (status: PilotStatus) => status.unread !== undefined;

/** Dollars with cents, or whole dollars when there are none: "$1.20", "$10". */
export function formatDollars(cents: number): string {
  const value = Math.max(0, cents) / 100;
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

/** "$1.20 of $10 today" for Pilot's usual 24-hour window. */
export function budgetLabel(budget: PilotStatus["budget"]): string {
  const window = budget.windowHours === 24 ? "today" : `in the last ${budget.windowHours} h`;
  return `${formatDollars(budget.spentCents)} of ${formatDollars(budget.capCents)} ${window}`;
}

/** The empty thread's promise, which never says "Watching" unless Pilot is. */
export function emptyThreadText(state: PilotWatchState, sessions: number | undefined): string {
  if (state === "not-running") return "Pilot starts with your next Claude Code session.";
  if (state === "paused") return "Pilot is paused. Resume it to hear when you forget something.";
  const watching =
    sessions === undefined || sessions <= 0
      ? "Watching your Claude Code sessions."
      : `Watching ${sessions === 1 ? "1 session" : `${sessions} sessions`}.`;
  return `${watching} Pilot speaks up when you're about to forget something.`;
}

export const NUDGE_KIND_LABELS: Record<PilotNudgeKind, string> = {
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
} as const satisfies Record<PilotNudgeKind, string>;

/** What happened to a nudge after the person acted on it, or null while it still waits. */
export function nudgeOutcome(state: PilotMessageState): string | null {
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

/** Pilot's words for a refused nudge action, in words for the person. */
export function nudgeErrorText(error: string): string {
  return /session ended/i.test(error)
    ? "That session has ended, so this can't go into its next turn."
    : error;
}

/** The thread in id order, with each message replaced by its newest copy. */
export function mergeMessages(
  current: readonly PilotMessage[],
  incoming: readonly PilotMessage[],
): PilotMessage[] {
  if (incoming.length === 0) return current as PilotMessage[];
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].toSorted((a, b) => a.id - b.id);
}

export const newestMessageId = (messages: readonly PilotMessage[]) =>
  messages.length === 0 ? null : messages[messages.length - 1]!.id;

/**
 * Whether the question being answered still needs its own bubble: Pilot may
 * store the question before it answers, and the next poll then shows it.
 */
export function pendingQuestionShown(
  messages: readonly PilotMessage[],
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

/**
 * Where a quote comes from, as the parts of one quiet line: who said it, the
 * file or session it is in, and how long ago. "CLAUDE.md:12"; "You", "billing ·
 * fix rounding", "2h ago". The UI shortens `place` and keeps `time` whole.
 */
export function quoteSource(quote: Pick<PilotQuote, "source" | "where">): {
  readonly who: string | null;
  readonly place: string;
  readonly time: string | null;
} {
  switch (quote.source) {
    case "rule":
    case "memory":
      return { who: null, place: fileLabel(quote.where), time: null };
    case "prompt":
    case "session":
    case "nudge": {
      const { label, time } = splitWhere(quote.where);
      const who =
        quote.source === "prompt" ? "You" : quote.source === "session" ? "The session" : "Pilot";
      return { who, place: label, time };
    }
  }
}

/** The same line as plain text, for a tooltip or a screen reader. */
export function quoteSourceLabel(quote: Pick<PilotQuote, "source" | "where">): string {
  const { who, place, time } = quoteSource(quote);
  return [who, place, time].filter(Boolean).join(" · ");
}

/**
 * Whether a nudge's first quote already names its session, so the card need
 * not repeat it.
 */
export function quoteNamesSession(
  message: Pick<PilotMessage, "evidence" | "sessionLabel">,
): boolean {
  const label = message.sessionLabel?.trim();
  const first = message.evidence[0];
  return !label || (first !== undefined && first.where.includes(label));
}

/**
 * The nudge whose actions stay visible without hovering: the newest one the
 * person has not acted on yet. Other nudges show their actions on hover or focus.
 */
export function newestOpenNudgeId(messages: readonly PilotMessage[]): number | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.kind === "nudge" && (message.state === "new" || message.state === "seen"))
      return message.id;
  }
  return null;
}

const trimSeparators = (path: string) => path.replace(/[\\/]+$/, "");

/**
 * The watched repository that contains `projectRoot`, preferring the deepest
 * root when repositories nest (a worktree inside a checkout).
 */
export function repoForPath(
  repos: readonly Pick<PilotRepo, "key" | "root">[],
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
  "chat-answer": "Answered your question",
};

const RUN_STATUSES: Record<string, string> = {
  queued: "Waiting",
  starting: "Starting",
  running: "Running now",
  done: "Done",
  skipped: "Skipped",
  failed: "Failed",
  timed_out: "Took too long",
  budget_reached: "Stopped at the budget",
  cancelled: "Cancelled",
  nudge: "Spoke up",
  silent: "Nothing to say",
  dropped: "Held back",
  held: "Held back",
};

/** Statuses whose summary is the run's internal reason; the status word says enough. */
const UNFINISHED_OR_FAILED = new Set([
  "queued",
  "starting",
  "running",
  "failed",
  "timed_out",
  "budget_reached",
  "cancelled",
]);

/** Why Pilot held a reminder back, in plain words; unknown reasons are left to the status word. */
const HELD_BACK_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^repeats nudge/i, "It had already said that"],
  [/quote did not match/i, "A quote didn't match its source"],
  [/quotes only the new prompt/i, "Nothing earlier to quote"],
  [/^no quote/i, "Nothing to quote"],
];

const RUN_TRIGGERS: Record<string, string> = {
  prompt: "after your prompt",
  stop: "when a turn ended",
  test: "after tests ran",
  "edits-idle": "after edits went quiet",
  "changed-outside-edits": "after files changed outside the session",
  manual: "on request",
  question: "for your question",
  escalation: "to look closer",
  onboard: "when Pilot started watching",
};

/**
 * A run summary without Pilot's internal markup: phase tags such as
 * "[checkpoint]", "finding(s)", snapshot ids and pointers to the CLI.
 */
export function plainRunSummary(summary: string): string {
  const pilotLine = plainPilotSummary(summary.trim());
  if (pilotLine !== null) return pilotLine;
  const lines = summary
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(\[[^\]]*\]\s*)+/, "")
        .replace(/\s*\[[A-Z][^\]]*\]/g, "")
        .replace(/\s*\(details: pilot runs\)/gi, "")
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

/**
 * Pilot's own prompt-check and answer summaries, such as
 * "nudge #3 (pending, confidence 0.85)" or "answered by Codex (4/4 quotes found)",
 * without ids, confidence scores or slugs. Null when the summary is not one of them.
 */
function plainPilotSummary(summary: string): string | null {
  const [main = "", ...rest] = summary.split(/\s+·\s+(?=\w+ instead:)/);
  const instead = rest.join(" ").replace(/^(\w+) instead: (.*)$/, "used $1 instead: $2");
  const withInstead = (text: string) => [text, instead].filter(Boolean).join(" · ");
  const nudge =
    /^nudge(?: #\d+)? \((\w+), confidence [\d.]+\)(; queued for the session's next turn)?$/.exec(
      main,
    );
  if (nudge) {
    const label = NUDGE_KIND_LABELS[nudge[1] as PilotNudgeKind] ?? "A reminder";
    return withInstead(nudge[2] ? `${label}, sent to the session` : label);
  }
  if (main === "silent") return withInstead("");
  const skipped = /^skipped: (.+)$/.exec(main);
  if (skipped) return withInstead(skipped[1]![0]!.toUpperCase() + skipped[1]!.slice(1));
  const held = /^(?:dropped|held): (.*)$/.exec(main);
  if (held) {
    const reason = HELD_BACK_REASONS.find(([pattern]) => pattern.test(held[1]!))?.[1] ?? "";
    return withInstead(reason);
  }
  const answered = /^answered by (\w+) \((\d+)\/(\d+) quotes found\)(?:; (.*))?$/.exec(main);
  if (answered) {
    const [, engine, found, total, fallback] = answered;
    const quotes = total === "0" ? "no quotes" : `${found} of ${total} quotes found`;
    return withInstead([`With ${engine}`, quotes, fallback].filter(Boolean).join(" · "));
  }
  return null;
}

/** One Pilot run in plain words; unknown kinds, statuses and triggers are left out, never shown raw. */
export function describeRun(run: PilotActivityRun): {
  readonly title: string;
  readonly detail: string;
  readonly summary: string | null;
} {
  const kind = RUN_KINDS[run.kind] ?? "Pilot check";
  const status = RUN_STATUSES[run.status];
  const trigger = run.trigger
    ?.split("+")
    .map((part) => RUN_TRIGGERS[part])
    .find(Boolean);
  // Unfinished and failed runs carry an internal reason; the status already says what happened.
  const summary = UNFINISHED_OR_FAILED.has(run.status)
    ? null
    : plainRunSummary(run.summary) || null;
  return {
    title: run.repo ? `${kind} in ${run.repo}` : kind,
    detail: [status, trigger].filter(Boolean).join(", "),
    summary,
  };
}

/** One session event in plain words. */
export function describeEvent(event: PilotActivityEvent): string {
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
