import type { ServerProvider, ServerProviderUsageWindow } from "@starkfuture/contracts";

const USAGE_STALE_AFTER_MS = 15 * 60_000;

type ComposerUsageWindow = {
  id: "session" | "weekly" | "monthly";
  label: string;
  window: ServerProviderUsageWindow | null;
  message: string | null;
};

/** Keep each account quota separate; the ring reflects the most-used current window. */
export function selectComposerUsage(
  provider: ServerProvider | null,
  connected: boolean,
  nowMs: number,
) {
  if (!provider || (provider.driver !== "claudeAgent" && provider.driver !== "codex")) {
    return null;
  }
  const profile = provider.displayName ?? (provider.driver === "claudeAgent" ? "Claude" : "Codex");
  const unknown = (message: string) => ({
    profile,
    window: null,
    label: null,
    message,
    windows: [] as ComposerUsageWindow[],
  });
  if (!connected) return unknown("Reconnect to see current usage.");
  if (!provider.enabled || !provider.installed || provider.availability === "unavailable") {
    return unknown("This profile is not available.");
  }
  if (provider.auth.status !== "authenticated") {
    return unknown("Sign in to see subscription usage.");
  }
  const limits = provider.usageLimits;
  if (!limits) return unknown("Usage has not been reported yet.");
  if (limits.unavailable?.reason === "unsupported") {
    return unknown("This account does not report subscription usage.");
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return unknown("Usage could not be refreshed. Waiting for an update.");
  }
  const checkedAt = Date.parse(limits.checkedAt);
  if (!Number.isFinite(checkedAt) || nowMs - checkedAt >= USAGE_STALE_AFTER_MS) {
    return unknown("Usage is out of date. Waiting for an update.");
  }
  const accountWindows = limits.windows.filter((entry) =>
    provider.driver === "claudeAgent"
      ? entry.id === "five_hour" || entry.id === "seven_day"
      : entry.id === "primary" || entry.id === "secondary",
  );
  const kinds: ComposerUsageWindow["id"][] = ["session", "weekly"];
  if (accountWindows.some((entry) => entry.kind === "monthly")) kinds.push("monthly");
  const windows = kinds.map((kind): ComposerUsageWindow => {
    // Codex's primary/secondary identifiers describe positions, not durations.
    const reported = accountWindows.find((entry) => entry.kind === kind);
    const name = kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Session";
    const label = provider.driver === "claudeAgent" ? `${name} · all models` : name;
    if (!reported || !Number.isFinite(reported.usedPercent))
      return { id: kind, label, window: null, message: "Not reported." };
    if (reported.resetsAt && Date.parse(reported.resetsAt) <= nowMs)
      return {
        id: kind,
        label,
        window: null,
        message: "The usage window has reset. Waiting for an update.",
      };
    return { id: kind, label, window: reported, message: null };
  });
  const dominant = windows.reduce<ComposerUsageWindow | null>((current, entry) => {
    if (!entry.window) return current;
    if (
      !current?.window ||
      entry.window.usedPercent > current.window.usedPercent ||
      (entry.window.usedPercent === current.window.usedPercent && entry.id === "weekly")
    )
      return entry;
    return current;
  }, null);
  return {
    profile,
    window: dominant?.window ?? null,
    label: dominant?.label ?? null,
    message: dominant
      ? null
      : (windows.find((entry) => entry.message?.includes("has reset"))?.message ??
        "No account usage window has been reported yet."),
    windows,
  };
}

export function formatComposerUsagePercent(percent: number): string {
  return `${Number(percent.toFixed(1))}%`;
}

/** A missing window is unknown, never an implicit zero or a full allowance. */
export function formatComposerUsageSummary(
  usage: NonNullable<ReturnType<typeof selectComposerUsage>>,
): string {
  const windows =
    usage.windows.length > 0
      ? usage.windows
      : [
          { id: "session", window: null },
          { id: "weekly", window: null },
        ];
  return windows
    .map((entry) => {
      const label =
        entry.id === "weekly" ? "Weekly" : entry.id === "monthly" ? "Monthly" : "Session";
      return `${label} ${entry.window ? formatComposerUsagePercent(entry.window.usedPercent) : "—"}`;
    })
    .join(" · ");
}
