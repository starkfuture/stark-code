import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@starkfuture/contracts";
import { formatComposerUsagePercent, selectComposerUsage } from "./ComposerUsageRing.logic";

const now = Date.parse("2026-10-17T12:00:00Z");
const weekly: ServerProviderUsageWindow = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 67,
  resetsAt: "2026-10-19T18:00:00Z",
};
function provider(windows: readonly ServerProviderUsageWindow[] = [weekly]): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Stark Future 1",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "hidden@example.com" },
    checkedAt: "2026-10-17T12:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-10-17T11:55:00Z", windows },
  };
}
describe("selectComposerUsage", () => {
  it("prefers Claude's all-model week and excludes scoped buckets when falling back to the session", () => {
    const scoped = { ...weekly, id: "seven_day_opus", usedPercent: 99 };
    const session = { ...weekly, id: "five_hour", kind: "session" as const, usedPercent: 12 };
    expect(
      selectComposerUsage(provider([scoped, session, weekly]), true, now)?.window?.usedPercent,
    ).toBe(67);
    expect(selectComposerUsage(provider([scoped, session]), true, now)?.label).toBe(
      "Session · all models",
    );
    expect(selectComposerUsage(provider([scoped]), true, now)?.window).toBeNull();
  });
  it("prefers Codex's account week, then session, then monthly", () => {
    const session = { ...weekly, id: "primary", kind: "session" as const, usedPercent: 12 };
    const week = { ...weekly, id: "secondary", usedPercent: 48 };
    const codex = { ...provider([session, week]), driver: ProviderDriverKind.make("codex") };
    expect(selectComposerUsage(codex, true, now)?.window?.usedPercent).toBe(48);
    expect(
      selectComposerUsage(
        { ...codex, usageLimits: { ...codex.usageLimits!, windows: [session] } },
        true,
        now,
      )?.label,
    ).toBe("Session");
    expect(
      selectComposerUsage(
        {
          ...codex,
          usageLimits: { ...codex.usageLimits!, windows: [{ ...session, kind: "monthly" }] },
        },
        true,
        now,
      )?.label,
    ).toBe("Monthly");
    expect(
      selectComposerUsage(
        { ...codex, usageLimits: { ...codex.usageLimits!, windows: [{ ...week, id: "spark" }] } },
        true,
        now,
      )?.window,
    ).toBeNull();
  });
  it.each([0, 100])("keeps a reported percentage of %s distinct from unknown", (percent) => {
    const result = selectComposerUsage(provider([{ ...weekly, usedPercent: percent }]), true, now);
    expect(result?.window?.usedPercent).toBe(percent);
    expect(result?.message).toBeNull();
    expect(formatComposerUsagePercent(percent)).toBe(`${percent}%`);
  });
  it.each(["unsupported", "probeFailed"] as const)(
    "does not present old cached usage after %s",
    (reason) => {
      const value = provider();
      expect(
        selectComposerUsage(
          { ...value, usageLimits: { ...value.usageLimits!, unavailable: { reason } } },
          true,
          now,
        )?.window,
      ).toBeNull();
    },
  );
  it("expires usage after 15 minutes and after its reset, without assuming zero", () => {
    expect(selectComposerUsage(provider(), true, now + 9 * 60_000)?.window?.usedPercent).toBe(67);
    expect(selectComposerUsage(provider(), true, now + 10 * 60_000)?.message).toContain(
      "out of date",
    );
    expect(
      selectComposerUsage(provider([{ ...weekly, resetsAt: "2026-10-17T12:00:00Z" }]), true, now)
        ?.message,
    ).toContain("has reset");
  });
  it("keeps offline, signed-out and missing quota states neutral", () => {
    expect(selectComposerUsage(provider(), false, now)?.window).toBeNull();
    expect(
      selectComposerUsage({ ...provider(), auth: { status: "unauthenticated" } }, true, now)
        ?.window,
    ).toBeNull();
    expect(
      selectComposerUsage({ ...provider(), usageLimits: undefined }, true, now)?.window,
    ).toBeNull();
    expect(selectComposerUsage(provider([]), true, now)?.window).toBeNull();
  });
  it("does not render unsupported providers or absent selection", () => {
    expect(selectComposerUsage(null, true, now)).toBeNull();
    expect(
      selectComposerUsage({ ...provider(), driver: ProviderDriverKind.make("cursor") }, true, now),
    ).toBeNull();
  });
});
