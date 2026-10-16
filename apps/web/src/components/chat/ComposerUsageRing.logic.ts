import type { ServerProvider, ServerProviderUsageWindow } from "@starkfuture/contracts";

const USAGE_STALE_AFTER_MS = 15 * 60_000;

/** Select only the chosen profile's account quota, never a model-specific allowance. */
export function selectComposerUsage(
  provider: ServerProvider | null,
  connected: boolean,
  nowMs: number,
) {
  if (!provider || (provider.driver !== "claudeAgent" && provider.driver !== "codex")) {
    return null;
  }
  const profile = provider.displayName ?? (provider.driver === "claudeAgent" ? "Claude" : "Codex");
  const unknown = (message: string) => ({ profile, window: null, label: null, message });
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
  let window: ServerProviderUsageWindow | undefined;
  if (provider.driver === "claudeAgent") {
    window =
      limits.windows.find((entry) => entry.id === "seven_day") ??
      limits.windows.find((entry) => entry.id === "five_hour");
  } else {
    // Codex's adapter exposes its main allowance as primary/secondary only.
    const accountWindows = limits.windows.filter(
      (entry) => entry.id === "primary" || entry.id === "secondary",
    );
    window = ["weekly", "session", "monthly"].flatMap((kind) =>
      accountWindows.filter((entry) => entry.kind === kind),
    )[0];
  }
  if (!window || !Number.isFinite(window.usedPercent)) {
    return unknown("No account usage window has been reported yet.");
  }
  if (window.resetsAt && Date.parse(window.resetsAt) <= nowMs) {
    return unknown("The usage window has reset. Waiting for an update.");
  }
  const kind =
    window.kind === "weekly" ? "Weekly" : window.kind === "monthly" ? "Monthly" : "Session";
  return {
    profile,
    window,
    label: provider.driver === "claudeAgent" ? `${kind} · all models` : kind,
    message: null,
  };
}

export function formatComposerUsagePercent(percent: number): string {
  return `${Number(percent.toFixed(1))}%`;
}
