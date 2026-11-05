import type {
  LookoutEvidence,
  LookoutFinding,
  LookoutFindingStatus,
  LookoutRepo,
  LookoutResponse,
  LookoutSeverity,
  LookoutStatus,
} from "@starkfuture/contracts";

type BadgeVariant = "error" | "warning" | "info" | "success" | "secondary" | "outline";

/** The colour pairs with the severity word; never show one without the other. */
export function severityBadge(severity: LookoutSeverity | null): {
  readonly label: string;
  readonly variant: BadgeVariant;
} {
  switch (severity) {
    case "critical":
      return { label: "Critical", variant: "error" };
    case "high":
      return { label: "High", variant: "warning" };
    case "medium":
      return { label: "Medium", variant: "info" };
    case "low":
      return { label: "Low", variant: "secondary" };
    default:
      return { label: "Unrated", variant: "outline" };
  }
}

const STATUS_LABELS: Record<LookoutFindingStatus, string> = {
  open: "Open",
  stale: "Stale",
  accepted: "Accepted",
  dismissed: "Dismissed",
  deferred: "Deferred",
  resolved: "Resolved",
  unverified: "Unverified",
};

export const findingStatusLabel = (status: LookoutFindingStatus) => STATUS_LABELS[status];

/** Open and stale findings still need a decision; every other status can be reopened. */
export const isFindingOpen = (finding: Pick<LookoutFinding, "status">) =>
  finding.status === "open" || finding.status === "stale";

export type LookoutWatchState = "watching" | "paused" | "not-running" | "not-installed" | "unknown";

/** One word for the status dot: is Lookout watching right now? */
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

/**
 * Whether Lookout told the coding session about a finding, or why it kept the
 * finding in its inbox. `formatTime` renders the delivery time.
 */
export function speechLine(
  finding: Pick<LookoutFinding, "speech" | "deliveredAt">,
  formatTime: (iso: string) => string,
): string | null {
  if (finding.deliveredAt) {
    const time = formatTime(finding.deliveredAt);
    return time ? `Told the session at ${time}` : "Told the session";
  }
  const why = finding.speech?.why.trim();
  if (!finding.speech) return null;
  return why ? `Kept quiet: ${why}` : "Kept quiet";
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

/**
 * Findings for the folder this conversation works in come first; otherwise
 * Lookout's own order (severity, then newest) is kept.
 */
export function orderFindings<T extends Pick<LookoutFinding, "repoKey">>(
  findings: readonly T[],
  preferredRepoKey: string | null,
): T[] {
  if (!preferredRepoKey) return [...findings];
  return [
    ...findings.filter((finding) => finding.repoKey === preferredRepoKey),
    ...findings.filter((finding) => finding.repoKey !== preferredRepoKey),
  ];
}

export function formatCents(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

export function budgetLabel(budget: LookoutStatus["budget"]): string {
  return `${formatCents(budget.spentCents)} of ${formatCents(budget.capCents)} used in ${budget.windowHours} h`;
}

export function evidenceLocation(evidence: LookoutEvidence): string | null {
  if (evidence.path) {
    return evidence.lineStart === undefined
      ? evidence.path
      : `${evidence.path}:${evidence.lineStart}`;
  }
  return evidence.command ?? null;
}

export const EVIDENCE_CHECK_LABELS = {
  verified: "Verified",
  failed: "Did not check out",
  unverifiable: "Could not check",
} as const;

export function repositoriesLabel(count: number): string {
  return count === 1 ? "1 repository" : `${count} repositories`;
}

/** The decision Lookout records for each finding action, with its button and prompt wording. */
export const DECISION_COPY = {
  accept: { label: "Accept", placeholder: "Why this is worth fixing" },
  dismiss: { label: "Dismiss", placeholder: "Why this is not a problem" },
  defer: { label: "Defer", placeholder: "Why this can wait" },
} as const;

export type LookoutReasonAction = keyof typeof DECISION_COPY;

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
