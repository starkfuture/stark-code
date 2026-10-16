// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@starkfuture/client-runtime/environment";
import {
  ProviderInstanceId,
  RESPONSE_VISUALS_MODEL,
  RESPONSE_VISUALS_VERSION,
  type NativeAgentReply,
} from "@starkfuture/contracts";
import { makeThreadFixture } from "../test-fixtures";

const state = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
  escapes: 0,
  replies: [] as NativeAgentReply[],
  restart: vi.fn(),
  generate: vi.fn(),
  back: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../state/responseVisuals", () => ({
  responseVisualsEnvironment: { format: { permissionAtom: () => "visual-permission" } },
}));
vi.mock("../state/terminal", () => ({ terminalEnvironment: { restart: "restart" } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "restart" ? state.restart : state.generate),
}));
vi.mock("../state/nativeReplies", () => ({
  useNativeReplies: (_ref: unknown, enabled: boolean) => ({
    data: enabled ? state.replies : undefined,
    error: null,
  }),
}));
vi.mock("./ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div data-markdown>{text}</div>,
}));
vi.mock("./ThreadTerminalDrawer", () => ({
  TerminalViewport: () => {
    useEffect(() => {
      state.mounts++;
      return () => {
        state.unmounts++;
      };
    }, []);
    return (
      <input
        aria-label="CLI input"
        onKeyDown={(event) => {
          if (event.key === "Escape") state.escapes++;
        }}
      />
    );
  },
}));

import { NativeAgentShell } from "./NativeAgentShell";

let root: Root;
let container: HTMLDivElement;
const thread = makeThreadFixture();
const threadRef = scopeThreadRef(thread.environmentId, thread.id);
const instanceId = ProviderInstanceId.make("claude-reader");
const render = () =>
  act(() =>
    root.render(
      <NativeAgentShell
        threadRef={threadRef}
        providerInstanceId={instanceId}
        driver="claudeAgent"
        cwd="/work"
        worktreePath={null}
        keybindings={[]}
        onBackToChat={state.back}
      />,
    ),
  );
const button = (label: string) => {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
};
const click = (label: string) => act(async () => button(label).click());
const selectReply = (value: string) =>
  act(() => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Reply to read"]')!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
const escape = () =>
  act(() => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
const original = () =>
  container.querySelector('[aria-label="Original reply"] [data-markdown]')?.textContent;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  localStorage.clear();
  state.mounts = 0;
  state.unmounts = 0;
  state.escapes = 0;
  state.back.mockReset();
  state.restart.mockReset();
  state.generate.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      summary: "A saved overview.",
      table: null,
      mermaid: null,
      reason: null,
      model: RESPONSE_VISUALS_MODEL,
      formatterVersion: RESPONSE_VISUALS_VERSION,
      cacheHit: false,
      generationUsage: null,
    },
  });
  state.replies = ["First completed reply.", "Latest completed reply."].map((text, index) => ({
    id: `reply-${index}`,
    threadId: thread.id,
    terminalId: `native-agent-${instanceId}`,
    provider: "claude",
    sessionId: "native-session",
    turnId: null,
    text,
    capturedAt: "2026-10-17T00:00:00.000Z",
    sequence: index + 1,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps one terminal and its input while changing views and filling/restoring the window", async () => {
  await render();
  const input = container.querySelector<HTMLInputElement>('[aria-label="CLI input"]')!;
  input.value = "unfinished native command";
  await click("Reader");
  expect(original()).toBe("Latest completed reply.");
  await click("Both");
  await click("Fill window");
  expect(container.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
  await click("Terminal");
  await click("Return shell to workspace");
  await click("Both");
  expect(container.querySelector('[aria-label="CLI input"]')).toBe(input);
  expect(input.value).toBe("unfinished native command");
  expect(original()).toBe("Latest completed reply.");
  expect(state.mounts).toBe(1);
  expect(state.unmounts).toBe(0);
  expect(state.restart).not.toHaveBeenCalled();
  expect(state.generate).not.toHaveBeenCalled();
  expect(state.back).not.toHaveBeenCalled();
});

it("preserves the selected reply, reading position and generated overview when the terminal is shown", async () => {
  await render();
  await click("Reader");
  await selectReply("reply-0");
  expect(original()).toBe("First completed reply.");
  await click("Summarize");
  const reader = container.querySelector<HTMLElement>("[data-reply-reader]")!;
  reader.scrollTop = 240;
  await click("Terminal");
  await click("Fill window");
  await click("Both");
  await click("Return shell to workspace");
  await click("Reader");
  expect(container.querySelector("[data-reply-reader]")).toBe(reader);
  expect(reader.scrollTop).toBe(240);
  expect(original()).toBe("First completed reply.");
  expect(container.querySelector('[aria-label="AI overview"]')?.textContent).toContain(
    "A saved overview.",
  );
  expect(state.generate).toHaveBeenCalledTimes(1);
});

it("keeps pasted source through Reader, Both, Terminal and full-window transitions", async () => {
  await render();
  await click("Reader");
  await selectReply("paste");
  const source = container.querySelector<HTMLTextAreaElement>('[aria-label="Reply text"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      source,
      "My pasted reply.",
    );
    source.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(original()).toBe("My pasted reply.");
  await click("Both");
  await click("Fill window");
  await click("Terminal");
  await click("Return shell to workspace");
  await click("Reader");
  expect(container.querySelector('[aria-label="Reply text"]')).toBe(source);
  expect(source.value).toBe("My pasted reply.");
  expect(original()).toBe("My pasted reply.");
  expect(state.generate).not.toHaveBeenCalled();
});

it("delivers Escape to the native CLI, and restores full view only when focus is outside the terminal", async () => {
  await render();
  await click("Both");
  await click("Fill window");
  const input = container.querySelector<HTMLInputElement>('[aria-label="CLI input"]')!;
  await act(() => input.focus());
  await escape();
  expect(state.escapes).toBe(1);
  expect(container.querySelector('[data-native-shell-expanded="true"]')).not.toBeNull();
  await act(() => container.querySelector<HTMLElement>("[data-native-shell-expanded]")!.focus());
  await escape();
  expect(container.querySelector('[data-native-shell-expanded="true"]')).toBeNull();
  expect(document.activeElement).toBe(button("Fill window"));
  const workspaceControl = document.createElement("button");
  document.body.append(workspaceControl);
  try {
    await act(() => workspaceControl.focus());
    expect(document.activeElement).toBe(workspaceControl);
    await escape();
    expect(container.querySelector('[data-native-shell-expanded="false"]')).not.toBeNull();
  } finally {
    workspaceControl.remove();
  }
  expect(state.back).not.toHaveBeenCalled();
  expect(state.restart).not.toHaveBeenCalled();
});
