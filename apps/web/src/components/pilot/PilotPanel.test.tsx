// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type {
  PilotBridge,
  PilotMessage,
  PilotResponse,
  PilotSettings,
  PilotStatus,
} from "@starkfuture/contracts";
import { PILOT_CHAT_POLL_MS, PilotContent } from "./PilotPanel";
import { usePilotIndicator } from "./pilotStore";

const STATUS: PilotStatus = {
  generatedAt: "2026-11-06T09:00:00.000Z",
  daemon: { running: true, pid: 4, heartbeatAt: "2026-11-06T09:00:00.000Z" },
  paused: false,
  profiles: ["/Users/me/.claude"],
  home: "/Users/me/.pilot",
  mode: "local",
  claudeBin: "claude",
  delivery: "session",
  selftest: { ok: true, reason: "passed" },
  budget: { windowHours: 24, capCents: 1000, spentCents: 120, availableCents: 880 },
  repos: [],
  unread: 2,
  sessions: 3,
  reviewWork: false,
  engine: "claude",
};

const SETTINGS: PilotSettings = {
  engine: "claude",
  engines: {
    claude: { available: true, note: null },
    codex: { available: true, note: null, runsLeftToday: 37 },
  },
};

const message = (id: number, overrides: Partial<PilotMessage> = {}): PilotMessage => ({
  id,
  at: "2026-11-06T08:00:00.000Z",
  role: "pilot",
  kind: "nudge",
  nudgeKind: "rule",
  text: `Nudge ${id}`,
  evidence: [],
  session: "5f0c2a9e-1b7d",
  sessionLabel: "billing · fix the invoice rounding",
  repo: "billing",
  state: "new",
  engine: "claude",
  ...overrides,
});

const THREAD = [
  message(1, {
    text: "Your rule says to merge only on merge #N.",
    evidence: [
      {
        source: "rule",
        where: "/Users/me/.claude/CLAUDE.md:12",
        quote: "Never merge a PR unless the user writes 'merge #<n>'",
        found: true,
      },
    ],
    state: "seen",
  }),
  message(2, {
    role: "you",
    kind: "message",
    nudgeKind: null,
    text: "what's waiting on me?",
    engine: null,
  }),
  message(3, {
    kind: "answer",
    nudgeKind: null,
    text: "A session asked which sandbox to use.",
    engine: "codex",
    evidence: [
      {
        source: "session",
        where: "orders · deploy · 2026-11-06T07:00:00.000Z",
        quote: "Should I use kciam or the w02283 sandbox?",
        found: false,
      },
    ],
    state: "seen",
  }),
  message(4, { nudgeKind: "risky", text: "This sends a PR comment; you asked for drafts first." }),
  message(5, { nudgeKind: "pending", text: "A session is still waiting on your answer." }),
];

const ok = <T,>(value: T): PilotResponse<T> => ({ installed: true, ok: true, value });

/** Reports every observed element as on screen, like an open panel would. */
class VisibleObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  disconnect() {}
  unobserve() {}
}

let root: Root;
let container: HTMLDivElement;
let bridge: { [K in keyof PilotBridge]: ReturnType<typeof vi.fn> };

const settle = () =>
  act(async () => {
    for (let index = 0; index < 10; index++) await Promise.resolve();
  });
const render = async (active = true) => {
  await act(async () =>
    root.render(
      <PilotContent
        bridge={bridge as unknown as PilotBridge}
        active={active}
        projectRoot="/work/orders/src"
        timestampFormat="24-hour"
      />,
    ),
  );
  await settle();
};
const button = (label: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const click = async (label: string) => {
  await act(async () => button(label).click());
  await settle();
};
const card = (text: string) =>
  [...container.querySelectorAll("article")].find((item) => item.textContent?.includes(text))!;
const typeQuestion = async (text: string) => {
  const field = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask Pilot"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  return field;
};
const advance = async (ms: number) => {
  await act(async () => vi.advanceTimersByTime(ms));
  await settle();
};

let defaultEngine: "claude" | "codex" = "claude";

beforeEach(() => {
  defaultEngine = "claude";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T09:00:00.000Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", VisibleObserver);
  // Spinners pause with reduced motion.
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  usePilotIndicator.setState({ installed: null, unread: 0 });
  bridge = {
    status: vi.fn(async () => ok(STATUS)),
    chat: vi.fn(async (input: { since?: number }) =>
      ok({ messages: input.since === undefined ? THREAD : [], unread: 2 }),
    ),
    nudge: vi.fn(async (input: { id: number; action: string }) =>
      ok({
        ok: true,
        message: {
          ...THREAD.find((item) => item.id === input.id)!,
          state: input.action === "useful" ? "useful" : "seen",
        },
      }),
    ),
    ask: vi.fn(),
    cancelAsk: vi.fn(async () => ({ cancelled: true })),
    // Pilot keeps the default engine it was last given.
    settings: vi.fn(async (input: { engine?: "claude" | "codex" }) => {
      defaultEngine = input.engine ?? defaultEngine;
      return ok({ ...SETTINGS, engine: defaultEngine });
    }),
    findings: vi.fn(),
    activity: vi.fn(async () => ok({ events: [], runs: [] })),
    decide: vi.fn(),
    pause: vi.fn(async () => ok({ ok: true, paused: true, scope: "all" })),
    resume: vi.fn(async () => ok({ ok: true, paused: false, scope: "all" })),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows nudges, answers and your messages with their quotes", async () => {
  await render();
  const text = container.textContent ?? "";
  expect(text).toContain("Watching");
  expect(text).toContain("Your rule");
  expect(text).toContain("Hard to undo");
  expect(text).toContain("Waiting on you");
  expect(text).toContain("CLAUDE.md:12");
  expect(text).toContain("Quote found");
  expect(text).toContain("The session said, in orders · deploy ·\u00a02h\u00a0ago");
  expect(text).toContain("Not found");
  expect(text).toContain("what's waiting on me?");
  expect(text).not.toContain("Verified");
  // Only a nudge for a known session can go to that session.
  expect(card("merge only").textContent).toContain("Send to session");
});

it("polls the thread every five seconds for new messages, and only while open", async () => {
  await render();
  expect(bridge.chat).toHaveBeenCalledWith({ limit: 200 });
  await advance(PILOT_CHAT_POLL_MS);
  expect(bridge.chat).toHaveBeenLastCalledWith({ since: 5 });
  expect(bridge.status).toHaveBeenCalledTimes(1);
  await advance(15_000);
  expect(bridge.status).toHaveBeenCalledTimes(2);

  const chats = bridge.chat.mock.calls.length;
  await render(false);
  await advance(30_000);
  expect(bridge.chat.mock.calls.length).toBe(chats);
  // Opening again reloads the whole thread.
  await render(true);
  expect(bridge.chat).toHaveBeenLastCalledWith({ limit: 200 });
});

it("never polls twice at once", async () => {
  let answer: (value: unknown) => void = () => {};
  await render();
  bridge.chat.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
  await advance(PILOT_CHAT_POLL_MS);
  const calls = bridge.chat.mock.calls.length;
  await advance(PILOT_CHAT_POLL_MS * 3);
  expect(bridge.chat.mock.calls.length).toBe(calls);
  await act(async () => answer(ok({ messages: [], unread: 0 })));
  await advance(PILOT_CHAT_POLL_MS);
  expect(bridge.chat.mock.calls.length).toBe(calls + 1);
});

it("marks nudges seen once they are on screen, each once, and clears the dot", async () => {
  await render();
  expect(bridge.nudge.mock.calls.map(([input]) => input)).toEqual([
    { id: 4, action: "seen" },
    { id: 5, action: "seen" },
  ]);
  expect(usePilotIndicator.getState().unread).toBe(0);
  await advance(PILOT_CHAT_POLL_MS);
  expect(bridge.nudge).toHaveBeenCalledTimes(2);
});

it("records Got it, and explains a session that ended", async () => {
  await render();
  await act(async () => {
    [...card("merge only").querySelectorAll("button")]
      .find((item) => item.textContent === "Got it")!
      .click();
  });
  await settle();
  expect(bridge.nudge).toHaveBeenLastCalledWith({ id: 1, action: "useful" });
  expect(card("merge only").textContent).toContain("Got it");
  expect(card("merge only").textContent).not.toContain("Not useful");

  bridge.nudge.mockResolvedValue({
    installed: true,
    ok: false,
    reason: "failed",
    error: "session ended",
  });
  await act(async () => {
    [...card("drafts first").querySelectorAll("button")]
      .find((item) => item.textContent === "Send to session")!
      .click();
  });
  await settle();
  expect(card("drafts first").textContent).toContain("That session has ended");
  expect(card("drafts first").textContent).toContain("Send to session");
});

it("asks with Enter, shows Pilot thinking, then the answer", async () => {
  let answer: (value: unknown) => void = () => {};
  bridge.ask.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
  await render();
  const field = await typeQuestion("what did I ask yesterday?");
  expect(bridge.ask).toHaveBeenCalledWith({ text: "what did I ask yesterday?" });
  expect(field.value).toBe("");
  expect(container.textContent).toContain("Pilot is thinking…");
  await act(async () =>
    answer(
      ok({
        question: message(6, {
          role: "you",
          kind: "message",
          nudgeKind: null,
          text: "what did I ask yesterday?",
          state: "seen",
        }),
        answer: message(7, {
          kind: "answer",
          nudgeKind: null,
          text: "You asked to keep the /v1 endpoints.",
          state: "seen",
        }),
      }),
    ),
  );
  await settle();
  expect(container.textContent).not.toContain("Pilot is thinking…");
  expect(container.textContent).toContain("You asked to keep the /v1 endpoints.");
  expect(container.textContent?.match(/what did I ask yesterday\?/g)).toHaveLength(1);
});

it("cancels a question without leaving it waiting", async () => {
  bridge.ask.mockImplementation(() => new Promise(() => {}));
  await render();
  await typeQuestion("what's waiting on me?");
  await click("Cancel");
  expect(bridge.cancelAsk).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain("Pilot is thinking…");
  // The question comes back to the composer and can be sent again at once.
  const field = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask Pilot"]')!;
  expect(field.value).toBe("what's waiting on me?");
  expect(button("Send").disabled).toBe(false);
  await typeQuestion("what's waiting on me?");
  expect(bridge.ask).toHaveBeenCalledTimes(2);
});

it("leaves a cancelled question in the thread when Pilot already kept it", async () => {
  bridge.ask.mockImplementation(() => new Promise(() => {}));
  await render();
  await typeQuestion("what's waiting on me now?");
  bridge.chat.mockResolvedValue(
    ok({
      messages: [
        message(6, {
          role: "you",
          kind: "message",
          nudgeKind: null,
          text: "what's waiting on me now?",
        }),
      ],
      unread: 0,
    }),
  );
  await advance(PILOT_CHAT_POLL_MS);
  await click("Cancel");
  const field = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask Pilot"]')!;
  expect(field.value).toBe("");
  expect(container.textContent?.match(/what's waiting on me now\?/g)).toHaveLength(1);
});

it("says plainly when Pilot is not running, without Watching", async () => {
  bridge.status.mockResolvedValue(
    ok({ ...STATUS, daemon: { running: false, pid: null, heartbeatAt: null } }),
  );
  bridge.chat.mockResolvedValue(ok({ messages: [], unread: 0 }));
  await render();
  expect(container.textContent).toContain("Not running");
  expect(container.textContent).toContain("Pilot starts with your next Claude Code session.");
  expect(container.textContent).not.toContain("Watching");
});

it("shows how many sessions it watches when nothing needs saying", async () => {
  bridge.chat.mockResolvedValue(ok({ messages: [], unread: 0 }));
  await render();
  expect(container.textContent).toContain(
    "Watching 3 sessions. Pilot speaks up when you're about to forget something.",
  );
});

it("asks an older Pilot to update instead of calling chat", async () => {
  const { unread: _unread, sessions: _sessions, reviewWork: _reviewWork, ...older } = STATUS;
  bridge.status.mockResolvedValue(ok(older));
  await render();
  expect(container.textContent).toContain("Update Pilot to chat");
  expect(bridge.chat).not.toHaveBeenCalled();
});

it("shows the install command when Pilot is missing", async () => {
  bridge.status.mockResolvedValue({ installed: false, launcher: "/Users/me/.pilot/bin/pilot" });
  await render();
  expect(container.textContent).toContain("Pilot isn't installed");
  expect(container.textContent).toContain("Not installed");
  expect(container.textContent).toContain("<path-to-pilot-checkout>/scripts/pilot install");
  expect(bridge.chat).not.toHaveBeenCalled();
  await click("Check again");
  expect(bridge.status).toHaveBeenCalledTimes(2);
});

const engineToggle = (label: string) =>
  [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Engine for the next question"] button',
    ),
  ].find((item) => item.textContent === label)!;
const answered = (text: string) =>
  ok({
    question: message(8, { role: "you", kind: "message", nudgeKind: null, text, engine: null }),
    answer: message(9, { kind: "answer", nudgeKind: null, text: "Done.", engine: "codex" }),
  });

it("tags each Pilot message with the engine that wrote it", async () => {
  await render();
  expect(card("merge only").querySelector("[data-pilot-engine]")?.textContent).toBe("Claude");
  const tags = [...container.querySelectorAll("[data-pilot-engine]")].map((tag) => tag.textContent);
  expect(tags).toContain("Codex");
  // The person's own messages carry no engine.
  expect(tags).toHaveLength(THREAD.filter((item) => item.engine).length);
});

it("sends one question to Codex, then returns to the default", async () => {
  bridge.ask.mockImplementation(async (input: { text: string }) => answered(input.text));
  await render();
  expect(engineToggle("Claude").getAttribute("aria-pressed")).toBe("true");
  await act(async () => engineToggle("Codex").click());
  expect(container.textContent).toContain("Uses your Codex plan · 37 runs left today");
  await typeQuestion("what did I ask yesterday?");
  expect(bridge.ask).toHaveBeenLastCalledWith({
    text: "what did I ask yesterday?",
    engine: "codex",
  });
  await settle();
  expect(engineToggle("Claude").getAttribute("aria-pressed")).toBe("true");
  await typeQuestion("and today?");
  expect(bridge.ask).toHaveBeenLastCalledWith({ text: "and today?" });
});

it("disables an engine that cannot run and says why", async () => {
  bridge.settings.mockResolvedValue(
    ok({
      ...SETTINGS,
      engines: {
        ...SETTINGS.engines,
        codex: { available: false, note: "Signed out of Codex", runsLeftToday: 40 },
      },
    }),
  );
  await render();
  expect(engineToggle("Codex").disabled).toBe(true);
  expect(container.textContent).toContain("Signed out of Codex");
});

it("shows no engine switch for a Pilot without engine settings", async () => {
  bridge.settings.mockResolvedValue({
    installed: true,
    ok: false,
    reason: "failed",
    error: 'unknown method "settings"',
  });
  await render();
  expect(container.querySelector('[aria-label="Engine for the next question"]')).toBeNull();
  expect(container.textContent).not.toContain('unknown method "settings"');
});

it("changes the default engine from the options menu", async () => {
  await render();
  await click("Pilot options");
  const codex = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
    item.textContent?.startsWith("Codex"),
  );
  expect(codex?.textContent).toContain("Uses your Codex plan");
  await act(async () => codex!.click());
  await settle();
  expect(bridge.settings).toHaveBeenCalledWith({ engine: "codex" });
  expect(engineToggle("Codex").getAttribute("aria-pressed")).toBe("true");
});
