// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  MessageId,
  ThreadId,
  RESPONSE_VISUALS_MODEL,
  RESPONSE_VISUALS_VERSION,
  type NativeAgentReply,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
} from "@starkfuture/contracts";
import type { EnvironmentThreadShell } from "@starkfuture/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@starkfuture/client-runtime/environment";
import * as DateTime from "effect/DateTime";
import { makeThreadFixture, makeThreadProjectionFixture } from "../../test-fixtures";

const state = vi.hoisted(() => ({
  allowed: true,
  start: vi.fn(),
  interrupt: vi.fn(),
  approve: vi.fn(),
  visual: vi.fn(),
  nativeReplies: [] as NativeAgentReply[],
  child: null as EnvironmentThreadShell | null,
  projection: null as OrchestrationV2ThreadProjection | null,
  shells: [] as EnvironmentThreadShell[],
  turnIndex: {
    items: [] as { entryId: string; runId: null; userText: string; assistantText: string | null }[],
    complete: true,
    loading: false,
    error: null as string | null,
    retry: vi.fn(),
  },
}));
vi.mock("./useThreadTurnIndex", () => ({ useThreadTurnIndex: () => state.turnIndex }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../../state/responseVisuals", () => ({
  responseVisualsEnvironment: { format: { permissionAtom: () => "visual-permission" } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.visual }));
vi.mock("../../state/nativeReplies", () => ({
  useNativeReplies: () => ({ data: state.nativeReplies, error: null }),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.allowed }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    startTurn: "start",
    interruptTurn: "interrupt",
    respondToApproval: "approve",
  },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: "start" | "interrupt" | "approve") => state[command],
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref?.threadId === state.child?.id ? state.child : null,
  useThreadProjection: (ref: { threadId: string } | null) =>
    ref?.threadId === state.child?.id && state.projection ? { projection: state.projection } : null,
  useThreadShells: () => state.shells,
}));
vi.mock("../../state/terminalSessions", () => ({
  useThreadRunningTerminalIds: () => ["native-claude"],
}));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("./HtmlRenderFrame", () => ({
  HtmlRenderFrame: ({ htmlRender }: { htmlRender: { title: string } }) => (
    <div aria-label="HTML result">{htmlRender.title}</div>
  ),
}));

import { SideWorkPanel } from "./SideWorkPanel";

let root: Root;
let container: HTMLDivElement;
const parent = makeThreadFixture({ runtimeMode: "full-access" });
const onOpen = vi.fn();
const onOpenTurn = vi.fn();
const now = DateTime.makeUnsafe("2026-10-15T00:00:00Z");
function answer(text: string, threadId = parent.id): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make("answer"),
    threadId,
    runId: null,
    nodeId: null,
    role: "assistant",
    text,
    attachments: [],
    streaming: false,
    createdBy: "agent",
    creationSource: "provider",
    createdAt: now,
    updatedAt: now,
  };
}
const projection = {
  ...makeThreadProjectionFixture(),
  messages: [answer("Main answer to visualize")],
};
async function render(nativeShellMode = false, messages = projection.messages) {
  await act(() =>
    root.render(
      <SideWorkPanel
        parent={parent}
        projection={{ ...projection, messages }}
        workspaceRoot="/work"
        nativeShellMode={nativeShellMode}
        onOpenThread={onOpen}
        onOpenTurn={onOpenTurn}
        onClose={() => undefined}
      />,
    ),
  );
}
function button(text: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function type(label: string, value: string) {
  const input = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  expect(input).not.toBeNull();
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(text: string) {
  await act(() => button(text).click());
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  state.allowed = true;
  state.child = null;
  state.nativeReplies = [];
  state.projection = null;
  state.shells = [parent];
  state.turnIndex = { items: [], complete: true, loading: false, error: null, retry: vi.fn() };
  state.start.mockReset().mockResolvedValue({ _tag: "Success" });
  state.interrupt.mockReset().mockResolvedValue({ _tag: "Success" });
  state.approve.mockReset().mockResolvedValue({ _tag: "Success" });
  state.visual.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      summary: "A visual overview.",
      table: null,
      mermaid: null,
      reason: null,
      model: RESPONSE_VISUALS_MODEL,
      formatterVersion: RESPONSE_VISUALS_VERSION,
      cacheHit: false,
      generationUsage: null,
    },
  });
  onOpen.mockClear();
  onOpenTurn.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("starts an independent side question and shows its live response without navigating the main chat", async () => {
  await type("Side question", "Why is this approach useful?");
  await click("Ask in side chat");
  const call = state.start.mock.calls[0]![0];
  expect(call.input.threadId).not.toBe(parent.id);
  expect(call.input.runtimeMode).toBe("approval-required");
  expect(call.input.message.text).toContain("Main answer to visualize");
  expect(onOpen).not.toHaveBeenCalled();
  state.child = makeThreadFixture({
    id: ThreadId.make(call.input.threadId),
    title: "Side question",
  });
  state.projection = {
    ...makeThreadProjectionFixture(),
    messages: [answer("Independent answer", state.child.id)],
  };
  await render();
  expect(container.textContent).toContain("Independent answer");
  expect(container.querySelector("select")?.value).toBe(call.input.threadId);
  await click("Open chat");
  expect(onOpen).toHaveBeenCalledWith(call.input.threadId);
});

it("lists completed replies and makes a visual of the selected answer without starting a chat", async () => {
  await render(false, [
    { ...answer("First completed answer"), id: MessageId.make("first") },
    { ...answer("Second completed answer"), id: MessageId.make("second") },
    { ...answer("Still streaming"), id: MessageId.make("streaming"), streaming: true },
    { ...answer("User prompt"), id: MessageId.make("prompt"), role: "user", createdBy: "user" },
  ]);
  await click("Reader");
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Reply to read"]')!;
  expect([...select.options].map((option) => option.value)).toEqual([
    "latest",
    "second",
    "first",
    "paste",
  ]);
  expect(select.value).toBe("latest");
  await act(() => {
    select.value = "first";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const original = container.querySelector('[aria-label="Original reply"]')!;
  expect(original.textContent).toBe("First completed answer");
  const generate = container.querySelector<HTMLButtonElement>("[data-reply-reader] button")!;
  await act(() => generate.click());
  expect(state.visual).toHaveBeenCalledExactlyOnceWith({
    environmentId: parent.environmentId,
    input: { threadId: parent.id, answer: "First completed answer", visualRequest: "auto" },
  });
  expect(container.querySelector('[aria-label="AI overview"]')?.textContent).toContain(
    "A visual overview.",
  );
  expect(original.textContent).toContain("First completed answer");
  expect(state.start).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
});

it("shows native capture's empty state without substituting chat history or starting an agent", async () => {
  await render(true);
  await click("Reader");
  expect(container.textContent).toContain("Completed native replies appear here");
  expect(container.textContent).not.toContain("Main answer to visualize");
  expect(container.querySelector("[data-reply-reader]")).toBeNull();
  expect(state.visual).not.toHaveBeenCalled();
  expect(state.start).not.toHaveBeenCalled();
});

it("reads a captured shell reply without starting a side chat", async () => {
  state.nativeReplies = [
    {
      id: "native-1",
      threadId: parent.id,
      terminalId: "native-claude",
      provider: "claude",
      sessionId: "session",
      turnId: null,
      text: "Captured native answer",
      capturedAt: "2026-10-15T00:00:00Z",
      sequence: 1,
      truncated: true,
    },
  ];
  await render(true);
  await click("Reader");
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toContain(
    "Captured native answer",
  );
  expect(container.textContent).toContain("This captured reply was shortened");
  expect(container.textContent).not.toContain("Main answer to visualize");
  expect(state.start).not.toHaveBeenCalled();
  expect(state.visual).not.toHaveBeenCalled();
});

it("opens and removes the existing chat bookmarks without starting an agent or duplicating storage", async () => {
  const storageKey = `stark-code:turn-bookmarks:${scopedThreadKey(scopeThreadRef(parent.environmentId, parent.id))}`;
  localStorage.setItem(storageKey, JSON.stringify(["old", "unavailable"]));
  state.turnIndex.items = [
    {
      entryId: "old",
      runId: null,
      userText: "Earlier architecture",
      assistantText: "A saved answer",
    },
    { entryId: "recent", runId: null, userText: "Unbookmarked turn", assistantText: null },
  ];
  await click("Bookmarks");
  const list = container.querySelector('[aria-label="Bookmarked turns"]')!;
  expect(list.textContent).toContain("Earlier architecture");
  expect(list.textContent).not.toContain("Unbookmarked turn");
  expect(list.textContent).toContain("This saved turn is unavailable.");
  await act(() => list.querySelector<HTMLButtonElement>("button")!.click());
  expect(onOpenTurn).toHaveBeenCalledExactlyOnceWith("old");
  expect(state.start).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
  await act(() =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Remove bookmark from Earlier architecture"]')!
      .click(),
  );
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(["unavailable"]);
  expect(list.textContent).not.toContain("Earlier architecture");
  await click("Remove");
  expect(container.textContent).toContain("No bookmarks yet.");
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual([]);
});

it("keeps side work unavailable to a connection without thread permissions", async () => {
  state.allowed = false;
  await render();
  expect(button("Ask in side chat").disabled).toBe(true);
  await act(() =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(state.start).not.toHaveBeenCalled();
});

it("shows worktrees and native terminal activity together without presenting a terminal stop as an agent stop", async () => {
  const worktree = makeThreadFixture({
    id: ThreadId.make("other"),
    title: "Other agent",
    worktreePath: "/work/other",
  });
  state.shells = [parent, worktree];
  await click("Agents");
  expect(container.textContent).toContain("2 workspace folders · 2 chats");
  expect(container.textContent).toContain("/work/other");
  expect(container.textContent).toContain("active terminal session");
  expect(container.textContent).not.toContain("Stop agent");
  await click("Other agent");
  expect(onOpen).toHaveBeenCalledWith(worktree.id);
  expect(state.interrupt).not.toHaveBeenCalled();
});
