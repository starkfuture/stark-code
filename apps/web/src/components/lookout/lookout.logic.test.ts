import { describe, expect, it } from "vite-plus/test";
import {
  budgetLabel,
  lookoutWatchState,
  orderFindings,
  repoForPath,
  severityBadge,
  speechLine,
  withKeys,
} from "./lookout.logic";

const status = (overrides: { running?: boolean; paused?: boolean } = {}) =>
  ({
    installed: true,
    ok: true,
    value: {
      daemon: { running: overrides.running ?? true, pid: 1, heartbeatAt: null },
      paused: overrides.paused ?? false,
    },
  }) as never;

describe("lookoutWatchState", () => {
  it("names what Lookout is doing, with not installed and errors kept apart", () => {
    expect(lookoutWatchState(null)).toBe("unknown");
    expect(lookoutWatchState({ installed: false, launcher: "/x" })).toBe("not-installed");
    expect(
      lookoutWatchState({ installed: true, ok: false, reason: "timeout", error: "slow" }),
    ).toBe("unknown");
    expect(lookoutWatchState(status())).toBe("watching");
    expect(lookoutWatchState(status({ paused: true }))).toBe("paused");
    // A stopped daemon reads as not running even when the pause flag is set.
    expect(lookoutWatchState(status({ running: false, paused: true }))).toBe("not-running");
  });
});

describe("speechLine", () => {
  const time = (iso: string) => iso.slice(11, 16);
  it("says when Lookout told the session, or why it kept quiet", () => {
    expect(
      speechLine(
        {
          deliveredAt: "2026-11-05T14:32:00.000Z",
          speech: { action: "speak", why: "risky", toldSession: true },
        },
        time,
      ),
    ).toBe("Told the session at 14:32");
    expect(
      speechLine(
        {
          deliveredAt: null,
          speech: { action: "inbox", why: "low severity", toldSession: false },
        },
        time,
      ),
    ).toBe("Kept quiet: low severity");
    expect(speechLine({ deliveredAt: null, speech: null }, time)).toBeNull();
  });
});

describe("repoForPath", () => {
  const repos = [
    { key: "app", root: "/work/app" },
    { key: "app-wt", root: "/work/app/.worktrees/feature/" },
    { key: "application", root: "/work/application" },
  ];
  it("picks the deepest watched root that contains the folder", () => {
    expect(repoForPath(repos, "/work/app")).toBe("app");
    expect(repoForPath(repos, "/work/app/src")).toBe("app");
    expect(repoForPath(repos, "/work/app/.worktrees/feature/src")).toBe("app-wt");
    // A shared name prefix is not containment.
    expect(repoForPath(repos, "/work/application-2")).toBeNull();
    expect(repoForPath(repos, "/work/application/")).toBe("application");
    expect(repoForPath(repos, null)).toBeNull();
  });
});

describe("orderFindings", () => {
  it("moves this folder's findings first and keeps Lookout's order otherwise", () => {
    const findings = [
      { ref: "a#1", repoKey: "a" },
      { ref: "b#2", repoKey: "b" },
      { ref: "a#3", repoKey: "a" },
      { ref: "b#4", repoKey: "b" },
    ];
    expect(orderFindings(findings, "b").map((f) => f.ref)).toEqual(["b#2", "b#4", "a#1", "a#3"]);
    expect(orderFindings(findings, null).map((f) => f.ref)).toEqual(["a#1", "b#2", "a#3", "b#4"]);
  });
});

describe("labels", () => {
  it("pairs every severity colour with a word", () => {
    expect(severityBadge("critical")).toEqual({ label: "Critical", variant: "error" });
    expect(severityBadge(null)).toEqual({ label: "Unrated", variant: "outline" });
  });

  it("formats the review budget in dollars", () => {
    expect(
      budgetLabel({ windowHours: 24, capCents: 1000, spentCents: 37, availableCents: 963 }),
    ).toBe("$0.37 of $10.00 used in 24 h");
  });

  it("keeps keys stable and unique for repeated items", () => {
    expect(withKeys(["x", "y", "x"], (v) => v).map(({ key }) => key)).toEqual(["x", "y", "x~1"]);
  });
});
