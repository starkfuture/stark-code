// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
} from "@starkfuture/contracts";
import type { EnvironmentThreadShell } from "@starkfuture/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { makeThreadFixture, makeThreadProjectionFixture } from "../../test-fixtures";

const state = vi.hoisted(() => ({
  allowed: true,
  start: vi.fn(),
  interrupt: vi.fn(),
  approve: vi.fn(),
  child: null as EnvironmentThreadShell | null,
  projection: null as OrchestrationV2ThreadProjection | null,
  shells: [] as EnvironmentThreadShell[],
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
async function render(nativeShellMode = false) {
  await act(() =>
    root.render(
      <SideWorkPanel
        parent={parent}
        projection={projection}
        workspaceRoot="/work"
        nativeShellMode={nativeShellMode}
        onOpenThread={onOpen}
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
  state.projection = null;
  state.shells = [parent];
  state.start.mockReset().mockResolvedValue({ _tag: "Success" });
  state.interrupt.mockReset().mockResolvedValue({ _tag: "Success" });
  state.approve.mockReset().mockResolvedValue({ _tag: "Success" });
  onOpen.mockClear();
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

it("formats the reviewed response in a separate Manual chat", async () => {
  await click("Format");
  expect(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Response to format"]')?.value,
  ).toBe("Main answer to visualize");
  await type("Formatting instructions", "Use a compact comparison table");
  await click("Format in separate chat");
  const call = state.start.mock.calls[0]![0];
  expect(call.input.threadId).not.toBe(parent.id);
  expect(call.input.message.text).toContain("Use a compact comparison table");
  expect(call.input.message.text).toContain("html_render");
  expect(call.input.runtimeMode).toBe("approval-required");
  expect(call.input.interactionMode).toBe("default");
  expect(onOpen).not.toHaveBeenCalled();
  state.child = makeThreadFixture({ id: ThreadId.make(call.input.threadId) });
  state.projection = {
    ...makeThreadProjectionFixture(),
    turnItems: [false, true].map((failed, ordinal) => ({
      id: TurnItemId.make(`render-${ordinal}`),
      threadId: state.child!.id,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "dynamic_tool",
      toolName: "mcp__stark-code__html_render",
      input: {},
      output: {
        isError: failed,
        structuredContent: {
          htmlRender: {
            attachmentId: `render-${ordinal}-html`,
            title: failed ? "Failed page" : "Comparison table",
            height: 320,
          },
        },
      },
    })),
  };
  await render();
  expect(container.querySelector('[aria-label="HTML result"]')?.textContent).toBe(
    "Comparison table",
  );
  expect(container.textContent).not.toContain("Failed page");
});

it("never fabricates terminal history for the formatter", async () => {
  await render(true);
  await click("Format");
  expect(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Response to format"]')?.value,
  ).toBe("");
  await click("Format in separate chat");
  expect(state.start).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("paste the text");
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
