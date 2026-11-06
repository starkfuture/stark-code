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

it("shows nudges, answers and your messages with quiet sources", async () => {
  await render();
  const text = container.textContent ?? "";
  expect(text).toContain("Watching");
  expect(text).toContain("Your rule");
  expect(text).toContain("Hard to undo");
  expect(text).toContain("Waiting on you");
  expect(text).toContain("CLAUDE.md:12");
  expect(text).toContain("what's waiting on me?");
  // A found quote carries no label; only a missing one says so.
  expect(text).not.toContain("Quote found");
  expect(text).not.toContain("Verified");
  // The answer's sources stay folded until asked for.
  expect(text).toContain("Sources (1)· 1 not found");
  expect(text).not.toContain("Should I");
  await click("Sources (1)· 1 not found");
  expect(container.textContent).toContain("The session·orders · deploy·2h ago");
  expect(container.textContent).toContain("Not found");
  // Only a nudge for a known session can go to that session.
  expect(card("merge only").textContent).toContain("Send to session");
});

it("keeps a nudge to its first source and folds the rest", async () => {
  bridge.chat.mockResolvedValue(
    ok({
      messages: [
        message(9, {
          state: "seen",
          text: "Two places say otherwise.",
          evidence: [
            { source: "rule", where: "/r/CLAUDE.md:3", quote: "first rule", found: true },
            { source: "memory", where: "/m/notes.md:8", quote: "second note", found: false },
            {
              source: "prompt",
              where: "shop · plan · 2026-11-06T08:00:00Z",
              quote: "third",
              found: true,
            },
          ],
        }),
      ],
      unread: 0,
    }),
  );
  await render();
  expect(card("Two places").textContent).toContain("first rule");
  expect(card("Two places").textContent).not.toContain("second note");
  expect(card("Two places").textContent).toContain("+2 sources· 1 not found");
  await click("+2 sources· 1 not found");
  expect(card("Two places").textContent).toContain("second note");
  expect(card("Two places").textContent).toContain("third");
  await click("Fewer sources");
  expect(card("Two places").textContent).not.toContain("second note");
});

it("keeps the newest open nudge's actions in view and the others on hover", async () => {
  await render();
  const actions = (text: string) =>
    card(text).querySelector("[data-pilot-actions]")?.getAttribute("data-pilot-actions");
  expect(actions("A session is still waiting")).toBe("pinned");
  expect(actions("drafts first")).toBe("hover");
  // A nudge that was acted on shows what happened instead of actions.
  bridge.chat.mockResolvedValue(
    ok({
      messages: [message(5, { text: "A session is still waiting.", state: "useful" })],
      unread: 0,
    }),
  );
  await render(false);
  await render(true);
  expect(card("A session is still waiting").querySelector("[data-pilot-actions]")).toBeNull();
  expect(card("A session is still waiting").textContent).toContain("Got it");
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
      .find((item) => item.getAttribute("aria-label") === "Got it")!
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

const engineTrigger = () =>
  container.querySelector<HTMLButtonElement>('[aria-label^="Engine for the next question"]');
const chooseEngine = async (label: string, check?: (menu: string) => void) => {
  await act(async () => engineTrigger()!.click());
  await settle();
  check?.(document.body.textContent ?? "");
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (candidate) => candidate.textContent?.startsWith(label),
  );
  if (!item) throw new Error(`Missing engine: ${label}`);
  await act(async () => item.click());
  await settle();
};
const answered = (text: string) =>
  ok({
    question: message(8, { role: "you", kind: "message", nudgeKind: null, text, engine: null }),
    answer: message(9, { kind: "answer", nudgeKind: null, text: "Done.", engine: "codex" }),
  });

it("tags only messages from the engine that is not the default", async () => {
  await render();
  const tags = [...container.querySelectorAll("[data-pilot-engine]")].map((tag) => tag.textContent);
  expect(tags).toEqual(["Codex"]);
  expect(card("merge only").querySelector("[data-pilot-engine]")).toBeNull();
});

it("shows the engine control from the first render, before Pilot reports its engines", async () => {
  bridge.settings.mockImplementation(() => new Promise(() => {}));
  await render();
  expect(engineTrigger()?.textContent).toBe("Claude");
  expect(engineTrigger()?.disabled).toBe(true);
});

it("sends one question to Codex, then returns to the default", async () => {
  bridge.ask.mockImplementation(async (input: { text: string }) => answered(input.text));
  await render();
  expect(engineTrigger()?.textContent).toBe("Claude");
  await chooseEngine("Codex", (menu) =>
    expect(menu).toContain("Uses your Codex plan · 37 runs left today"),
  );
  expect(engineTrigger()?.textContent).toBe("Codex");
  await typeQuestion("what did I ask yesterday?");
  expect(bridge.ask).toHaveBeenLastCalledWith({
    text: "what did I ask yesterday?",
    engine: "codex",
  });
  await settle();
  expect(engineTrigger()?.textContent).toBe("Claude");
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
  await act(async () => engineTrigger()!.click());
  await settle();
  const codex = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
    item.textContent?.startsWith("Codex"),
  )!;
  expect(codex.textContent).toContain("Signed out of Codex");
  expect(codex.getAttribute("aria-disabled")).toBe("true");
});

it("keeps the engine control quiet for a Pilot without engine settings", async () => {
  bridge.settings.mockResolvedValue({
    installed: true,
    ok: false,
    reason: "failed",
    error: 'unknown method "settings"',
  });
  await render();
  expect(engineTrigger()?.disabled).toBe(true);
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
  expect(engineTrigger()?.textContent).toBe("Codex");
});

it("marks a reminder Pilot sent on its own as seen while it still counts as unread", async () => {
  const sent = message(1, { text: "Merge only on merge #N.", state: "sent" });
  bridge.chat.mockImplementation(async (input: { since?: number }) =>
    ok({ messages: input.since === undefined ? [sent] : [], unread: 1 }),
  );
  bridge.nudge.mockResolvedValue(ok({ ok: true, message: sent }));
  await render();
  expect(bridge.nudge).toHaveBeenCalledWith({ id: 1, action: "seen" });
  expect(usePilotIndicator.getState().unread).toBe(0);
  // Seeing it keeps what happened to it.
  expect(card("merge #N").textContent).toContain("Sent to the session");

  // Once nothing is unread, a sent reminder is left alone.
  bridge.nudge.mockClear();
  bridge.chat.mockImplementation(async () => ok({ messages: [sent], unread: 0 }));
  await render(false);
  await render(true);
  expect(bridge.nudge).not.toHaveBeenCalled();
});
