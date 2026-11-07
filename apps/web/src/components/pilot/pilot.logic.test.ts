import type { PilotActivityRun, PilotInstallStatus, PilotMessage } from "@starkfuture/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  budgetLabel,
  describeEvent,
  describeRun,
  emptyThreadText,
  installAction,
  installBlocker,
  installDetails,
  installHeadline,
  pilotStatusLine,
  newestOpenNudgeId,
  quoteNamesSession,
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
      "You · billing · fix the invoice rounding · 2h ago",
    );
    expect(quoteSourceLabel({ source: "session", where })).toBe(
      "The session · billing · fix the invoice rounding · 2h ago",
    );
    // A time Pilot writes another way is kept as written.
    expect(quoteSourceLabel({ source: "prompt", where: "orders · deploy it · 14:32" })).toBe(
      "You · orders · deploy it · 14:32",
    );
    expect(quoteSourceLabel({ source: "nudge", where: "2026-11-06T10:30:00.000Z" })).toBe(
      "Pilot · 30m ago",
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

  it("reads Pilot's prompt checks and answers in plain words", () => {
    // Captured from `pilot api activity` after a trial with real model runs.
    const cases = [
      [
        {
          kind: "prompt-check",
          status: "nudge",
          trigger: "prompt",
          summary: "nudge #3 (pending, confidence 0.85)",
        },
        {
          title: "Checked a prompt in shop",
          detail: "Spoke up, after your prompt",
          summary: "Waiting on you",
        },
      ],
      [
        {
          kind: "prompt-check",
          status: "nudge",
          trigger: "prompt",
          summary: "nudge #1 (rule, confidence 0.90); queued for the session's next turn",
        },
        { summary: "Your rule, sent to the session" },
      ],
      [
        { kind: "prompt-check", status: "silent", trigger: "prompt", summary: "silent" },
        { detail: "Nothing to say, after your prompt", summary: null },
      ],
      [
        {
          kind: "prompt-check",
          status: "dropped",
          trigger: "prompt",
          summary: "dropped: repeats nudge #3",
        },
        { detail: "Held back, after your prompt", summary: "It had already said that" },
      ],
      [
        {
          kind: "chat-answer",
          status: "done",
          trigger: "question",
          summary: "answered by Codex (4/4 quotes found)",
        },
        {
          title: "Answered your question in shop",
          detail: "Done, for your question",
          summary: "With Codex · 4 of 4 quotes found",
        },
      ],
      [
        {
          kind: "chat-answer",
          status: "done",
          trigger: "question",
          summary: "answered by Claude (2/3 quotes found); today's 40 Codex runs are used up",
        },
        { summary: "With Claude · 2 of 3 quotes found · today's 40 Codex runs are used up" },
      ],
      [
        {
          kind: "prompt-check",
          status: "nudge",
          trigger: "prompt",
          summary: "nudge (risky, confidence 0.92) · Claude instead: Codex is signed out",
        },
        { summary: "Hard to undo · used Claude instead: Codex is signed out" },
      ],
      [
        {
          kind: "chat-answer",
          status: "failed",
          trigger: "question",
          summary: "failed: model timed out",
        },
        { detail: "Failed, for your question", summary: null },
      ],
    ] as const;
    for (const [input, expected] of cases) {
      const described = describeRun(run({ repo: "shop", ...input }));
      expect(described).toMatchObject(expected);
      expect(JSON.stringify(described)).not.toMatch(
        /confidence|#\d|queued for|prompt-check|chat-answer/,
      );
    }
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

describe("quiet cards", () => {
  it("names the session on the card only when the first quote does not", () => {
    const quote = (where: string) => ({
      source: "prompt" as const,
      where,
      quote: "x",
      found: true,
    });
    const label = "shop · review PR #42";
    expect(
      quoteNamesSession({
        sessionLabel: label,
        evidence: [quote(`${label} · 2026-11-06T09:00:00Z`)],
      }),
    ).toBe(true);
    expect(quoteNamesSession({ sessionLabel: label, evidence: [quote("/r/CLAUDE.md:4")] })).toBe(
      false,
    );
    expect(quoteNamesSession({ sessionLabel: null, evidence: [] })).toBe(true);
  });

  it("keeps actions in view on the newest nudge still waiting for the person", () => {
    expect(
      newestOpenNudgeId([
        message(1, { state: "new" }),
        message(2, { state: "seen" }),
        message(3, { state: "sent" }),
        message(4, { role: "you", kind: "message", state: "seen" }),
      ]),
    ).toBe(2);
    expect(newestOpenNudgeId([message(1, { state: "useful" })])).toBeNull();
  });
});

describe("installing Pilot", () => {
  const plugin = (overrides: Partial<PilotInstallStatus> = {}): PilotInstallStatus => ({
    state: "not-installed",
    bundledVersion: "0.4.0",
    installedVersion: null,
    profile: "~/.claude",
    target: "~/.pilot/plugin/0.4.0",
    replaces: [],
    installsCopy: true,
    claudeBin: null,
    carriedSettings: [],
    missingSettings: [],
    configFile: "~/.pilot/config.json",
    note: null,
    ...overrides,
  });
  const checkout = { id: "pilot@pilot", version: "0.3.0", source: "~/Desktop/work/dev-copilot" };
  const lookout = { id: "lookout@lookout", version: "0.2.0", source: null };

  it("offers Install, Update, Remove or nothing", () => {
    expect(installAction(null)).toBeNull();
    expect(installAction(plugin())).toBe("Install");
    expect(installAction(plugin({ state: "legacy", replaces: [checkout] }))).toBe("Install");
    expect(
      installAction(plugin({ state: "legacy", replaces: [lookout], installsCopy: false })),
    ).toBe("Remove");
    expect(installAction(plugin({ state: "update" }))).toBe("Update");
    expect(installAction(plugin({ state: "installed" }))).toBeNull();
    expect(installAction(plugin({ state: "unsupported" }))).toBeNull();
  });

  it("says what changes in one short line, without paths", () => {
    expect(installHeadline(plugin())).toBe("Pilot isn't installed in Claude Code.");
    expect(installHeadline(plugin({ state: "legacy", replaces: [lookout, checkout] }))).toBe(
      "Replaces the Pilot running from dev-copilot.",
    );
    expect(installHeadline(plugin({ state: "legacy", replaces: [lookout] }))).toBe(
      "Replaces Lookout.",
    );
    expect(
      installHeadline(plugin({ state: "legacy", replaces: [lookout], installsCopy: false })),
    ).toBe("Lookout still runs beside Pilot.");
    expect(installHeadline(plugin({ state: "update", installedVersion: "0.3.0" }))).toBe(
      "Pilot 0.4.0 is available.",
    );
  });

  it("keeps paths, the Claude command and carried settings in the details", () => {
    expect(
      installDetails(
        plugin({
          state: "legacy",
          replaces: [checkout],
          claudeBin: "/opt/claude-personal",
          carriedSettings: ["claude_bin"],
        }),
      ),
    ).toEqual([
      { label: "Claude Code", value: "~/.claude" },
      { label: "Copies to", value: "~/.pilot/plugin/0.4.0 (Pilot 0.4.0)" },
      { label: "Replaces", value: "pilot@pilot from ~/Desktop/work/dev-copilot" },
      { label: "Thinks with", value: "/opt/claude-personal" },
      { label: "Settings", value: "Carries claude_bin into ~/.pilot/config.json" },
    ]);
    expect(installDetails(plugin()).at(-2)).toEqual({
      label: "Thinks with",
      value: "claude from your PATH",
    });
  });

  it("waits only for settings it could not read", () => {
    expect(installBlocker(plugin())).toBeNull();
    expect(installBlocker(plugin({ missingSettings: ["claude_bin", "mode"] }))).toBe(
      "Add claude_bin and mode to ~/.pilot/config.json first.",
    );
  });
});

describe("pilotStatusLine", () => {
  const ok = {
    selftest: { ok: true, reason: "passed" },
    budget: { windowHours: 24, capCents: 1000, spentCents: 0, availableCents: 1000 },
  };
  const held = {
    ...ok,
    selftest: { ok: false, reason: "no local self-test recorded: run `pilot selftest`" },
  };
  const line = (overrides: Partial<Parameters<typeof pilotStatusLine>[0]>) =>
    pilotStatusLine({
      error: null,
      status: ok,
      watch: "watching",
      pluginInstalled: true,
      installedVersion: null,
      selftest: "idle",
      ...overrides,
    });

  it("shows one line, by priority, and never the raw self-test reason", () => {
    expect(line({})).toBeNull();
    expect(line({ watch: "not-running" })?.kind).toBe("not-running");
    expect(line({ status: held, watch: "not-running" })).toEqual({
      kind: "on-hold",
      text: "Pilot is on hold until it passes a self-test.",
    });
    expect(
      line({ status: held, watch: "not-running", error: "Could not reach Pilot." })?.kind,
    ).toBe("error");
    expect(line({ status: held, selftest: "failed" })?.text).toBe(
      "The self-test did not pass, so Pilot stays on hold.",
    );
    expect(line({ watch: "not-running", installedVersion: "0.4.0" })?.text).toBe(
      "Pilot 0.4.0 is installed. It starts with your next Claude Code session.",
    );
    expect(line({ status: { ...ok, budget: { ...ok.budget, availableCents: 0 } } })?.kind).toBe(
      "budget",
    );
  });
});
