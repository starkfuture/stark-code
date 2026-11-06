import type { PilotActivityRun, PilotMessage } from "@starkfuture/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  budgetLabel,
  describeEvent,
  describeRun,
  emptyThreadText,
  pilotWatchState,
  mergeMessages,
  pendingQuestionShown,
  plainRunSummary,
  quoteSourceLabel,
  repoForPath,
  withKeys,
} from "./pilot.logic";

const status = (overrides: { running?: boolean; paused?: boolean } = {}) =>
  ({
    installed: true,
    ok: true,
    value: {
      daemon: { running: overrides.running ?? true, pid: 1, heartbeatAt: null },
      paused: overrides.paused ?? false,
    },
  }) as never;

const message = (id: number, overrides: Partial<PilotMessage> = {}): PilotMessage => ({
  id,
  at: "2026-11-06T09:00:00.000Z",
  role: "pilot",
  kind: "nudge",
  nudgeKind: "rule",
  text: `message ${id}`,
  evidence: [],
  session: null,
  sessionLabel: null,
  repo: null,
  state: "new",
  ...overrides,
});

describe("pilotWatchState", () => {
  it("never says Watching for a stopped or paused Pilot", () => {
    expect(pilotWatchState(null)).toBe("unknown");
    expect(pilotWatchState({ installed: false, launcher: "/x" })).toBe("not-installed");
    expect(pilotWatchState({ installed: true, ok: false, reason: "timeout", error: "slow" })).toBe(
      "unknown",
    );
    expect(pilotWatchState(status())).toBe("watching");
    expect(pilotWatchState(status({ paused: true }))).toBe("paused");
    expect(pilotWatchState(status({ running: false, paused: true }))).toBe("not-running");
  });

  it("keeps the empty thread's promise in line with the status word", () => {
    expect(emptyThreadText("watching", 3)).toBe(
      "Watching 3 sessions. Pilot speaks up when you're about to forget something.",
    );
    expect(emptyThreadText("watching", 1)).toMatch(/^Watching 1 session\./);
    expect(emptyThreadText("watching", 0)).toMatch(/^Watching your Claude Code sessions\./);
    expect(emptyThreadText("not-running", 3)).toBe(
      "Pilot starts with your next Claude Code session.",
    );
    expect(emptyThreadText("not-running", 3)).not.toContain("Watching");
    expect(emptyThreadText("paused", 3)).not.toContain("Watching");
  });
});

describe("the thread", () => {
  it("merges newer copies by id and keeps id order", () => {
    const current = [message(1), message(3)];
    const merged = mergeMessages(current, [message(2), message(3, { state: "seen" })]);
    expect(merged.map((m) => [m.id, m.state])).toEqual([
      [1, "new"],
      [2, "new"],
      [3, "seen"],
    ]);
    expect(mergeMessages(current, [])).toBe(current);
  });

  it("drops the waiting question's bubble once Pilot has stored it", () => {
    const pending = { text: "what's waiting on me?", afterId: 3 };
    const thread = [message(3), message(1, { role: "you", kind: "message", text: pending.text })];
    // The same words asked before do not count.
    expect(pendingQuestionShown(thread, pending)).toBe(true);
    expect(
      pendingQuestionShown(
        [...thread, message(4, { role: "you", kind: "message", text: ` ${pending.text}\n` })],
        pending,
      ),
    ).toBe(false);
  });
});

describe("quoteSourceLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T11:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("names files by their base name and line", () => {
    expect(quoteSourceLabel({ source: "rule", where: "/Users/me/.claude/CLAUDE.md:12" })).toBe(
      "CLAUDE.md:12",
    );
    expect(quoteSourceLabel({ source: "memory", where: "/m/memory/feedback_no_merge.md:3" })).toBe(
      "feedback_no_merge.md:3",
    );
  });

  it("says who said it, in which session, and how long ago", () => {
    const where = "billing · fix the invoice rounding · 2026-11-06T09:00:00.000Z";
    expect(quoteSourceLabel({ source: "prompt", where })).toBe(
      "You, in billing · fix the invoice rounding ·\u00a02h\u00a0ago",
    );
    expect(quoteSourceLabel({ source: "session", where })).toBe(
      "The session said, in billing · fix the invoice rounding ·\u00a02h\u00a0ago",
    );
    // A time Pilot writes another way is kept as written.
    expect(quoteSourceLabel({ source: "prompt", where: "orders · deploy it · 14:32" })).toBe(
      "You, in orders · deploy it · 14:32",
    );
    expect(quoteSourceLabel({ source: "nudge", where: "2026-11-06T10:30:00.000Z" })).toBe(
      "Pilot said earlier ·\u00a030m\u00a0ago",
    );
  });
});

describe("activity in plain words", () => {
  const run = (overrides: Partial<PilotActivityRun>): PilotActivityRun => ({
    id: 1,
    kind: "checkpoint",
    status: "done",
    finishedAt: null,
    costCents: null,
    summary: "",
    repo: "billing",
    trigger: null,
    startedAt: null,
    ...overrides,
  });

  it("never shows Pilot's internal words", () => {
    const failed = describeRun(
      run({
        status: "timed_out",
        trigger: "changed-outside-edits",
        summary: "[checkpoint] interrupted (timeout)",
      }),
    );
    expect(failed).toEqual({
      title: "Reviewed changes in billing",
      detail: "Took too long, after files changed outside the session",
      summary: null,
    });
    const strange = describeRun(run({ kind: "probe_v2", status: "zombie", trigger: "x+y" }));
    expect(strange).toEqual({ title: "Pilot check in billing", detail: "", summary: null });
    for (const value of [failed, strange])
      expect(JSON.stringify(value)).not.toMatch(/timed_out|changed-outside-edits|\[checkpoint\]/);
  });

  it("rewrites run summaries for people", () => {
    expect(
      plainRunSummary("[checkpoint] 1 finding(s): rounding drifts\n[deep] 2 finding(s): retries"),
    ).toBe("1 finding: rounding drifts 2 findings: retries");
    expect(plainRunSummary("no change since last assessment (snap-4f9c)")).toBe(
      "No change since the last check",
    );
    expect(plainRunSummary("waiting (details: pilot runs)")).toBe("Waiting");
    expect(describeRun(run({ trigger: "stop+test", summary: "[intent] nothing new" }))).toEqual({
      title: "Reviewed changes in billing",
      detail: "Done, when a turn ended",
      summary: "Nothing new",
    });
  });

  it("describes session events without session ids", () => {
    const event = { at: "", repo: "billing", session: "5f0c2a9e", agentType: null };
    expect(describeEvent({ ...event, kind: "prompt" })).toBe("You sent a prompt");
    expect(describeEvent({ ...event, kind: "test", testStatus: "failed" })).toBe("Tests failed");
    expect(describeEvent({ ...event, kind: "edit", agentType: "Explore" })).toBe(
      "Changed a file (subagent)",
    );
  });
});

describe("labels", () => {
  it("formats the budget like a person would say it", () => {
    expect(
      budgetLabel({ windowHours: 24, capCents: 1000, spentCents: 120, availableCents: 880 }),
    ).toBe("$1.20 of $10 today");
    expect(
      budgetLabel({ windowHours: 12, capCents: 550, spentCents: 0, availableCents: 550 }),
    ).toBe("$0 of $5.50 in the last 12 h");
  });

  it("picks the deepest watched root that contains the folder", () => {
    const repos = [
      { key: "app", root: "/work/app" },
      { key: "app-wt", root: "/work/app/.worktrees/feature/" },
      { key: "application", root: "/work/application" },
    ];
    expect(repoForPath(repos, "/work/app/src")).toBe("app");
    expect(repoForPath(repos, "/work/app/.worktrees/feature/src")).toBe("app-wt");
    expect(repoForPath(repos, "/work/application-2")).toBeNull();
    expect(repoForPath(repos, null)).toBeNull();
  });

  it("keeps keys stable and unique for repeated items", () => {
    expect(withKeys(["x", "y", "x"], (v) => v).map(({ key }) => key)).toEqual(["x", "y", "x~1"]);
  });
});
