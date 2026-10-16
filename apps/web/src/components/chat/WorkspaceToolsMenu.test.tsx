// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { WorkspaceToolsMenu } from "./WorkspaceToolsMenu";

let root: Root;
let container: HTMLDivElement;
const showPages = vi.fn();
const showFiles = vi.fn();
const showTerminal = vi.fn();

const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-label="Tools"]')!;
const item = (label: string) => {
  const element = document.querySelector<HTMLElement>(`[role="menuitem"][aria-label="${label}"]`);
  if (!element) throw new Error(`Missing tool: ${label}`);
  return element;
};
const open = () => act(() => trigger().click());
const render = () =>
  act(() =>
    root.render(
      <WorkspaceToolsMenu
        groups={[
          {
            label: "Read and explore",
            actions: [
              {
                id: "pages",
                label: "Pages",
                description: "Read company and folder pages",
                active: true,
                onSelect: showPages,
              },
            ],
          },
          {
            label: "Workspace",
            actions: [
              { id: "files", label: "Files", onSelect: showFiles },
              {
                id: "terminal",
                label: "Terminal",
                description: "Unavailable while reconnecting",
                disabled: true,
                onSelect: showTerminal,
              },
            ],
          },
        ]}
        connections={<button>Manage connections</button>}
      />,
    ),
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("opens tools from different groups and closes after a selection", async () => {
  await render();
  await open();
  expect(document.querySelector('[role="menu"]')?.textContent).toContain("Read and explore");
  expect(document.querySelector('[role="menu"]')?.textContent).toContain("Manage connections");
  await act(() => item("Files").click());
  expect(showFiles).toHaveBeenCalledOnce();
  expect(showPages).not.toHaveBeenCalled();
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  await open();
  await act(() => item("Pages").click());
  expect(showPages).toHaveBeenCalledOnce();
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
});

it("keeps unavailable tools visible without selecting them", async () => {
  await render();
  await open();
  expect(item("Terminal").textContent).toContain("Unavailable while reconnecting");
  await act(() => item("Terminal").click());
  expect(showTerminal).not.toHaveBeenCalled();
  expect(showFiles).not.toHaveBeenCalled();
  expect(showPages).not.toHaveBeenCalled();
});

it("dismisses with Escape and returns keyboard focus to Tools", async () => {
  await render();
  await open();
  await act(() => {
    item("Pages").focus();
    item("Pages").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger());
  expect(showPages).not.toHaveBeenCalled();
  expect(showFiles).not.toHaveBeenCalled();
});
