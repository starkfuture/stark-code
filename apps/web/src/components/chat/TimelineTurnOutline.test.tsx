// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { TimelineTurnOutline } from "./TimelineTurnOutline";
import type { TimelineMinimapItem } from "./timelineMinimapItems";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const items: TimelineMinimapItem[] = [
  { id: "first", rowIndex: 0, userText: "Inspect the app", assistantText: "Found the entry point" },
  { id: "second", rowIndex: 4, userText: "Fix navigation", assistantText: "Navigation is ready" },
];

it("opens prompt and answer previews, navigates by keyboard, and closes after a jump", async () => {
  const select = vi.fn();
  await act(() =>
    root.render(<TimelineTurnOutline items={items} currentId="first" onSelect={select} />),
  );
  expect(document.querySelector('[aria-label="Conversation turns"]')).toBeNull();
  await act(() => container.querySelector("button")!.click());
  const popup = document.querySelector('[aria-label="Conversation turns"]')!;
  expect(popup.textContent).toContain("Found the entry point");
  expect(popup.textContent).toContain("Navigation is ready");
  const turns = popup.querySelectorAll<HTMLButtonElement>("ol button");
  await act(() => turns[0]!.focus());
  await act(() =>
    turns[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  expect(document.activeElement).toBe(turns[1]);
  await act(() => turns[1]!.click());
  expect(select).toHaveBeenCalledExactlyOnceWith(items[1]);
  expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
});

it("loads earlier turns without claiming full history or losing the focused turn", async () => {
  const select = vi.fn();
  const load = vi.fn();
  const render = (loaded: TimelineMinimapItem[], hasMoreHistory: boolean, loading = false) =>
    root.render(
      <TimelineTurnOutline
        items={loaded}
        currentId="second"
        onSelect={select}
        history={{ hasMoreHistory, loading, error: null, onLoadEarlier: load }}
      />,
    );
  await act(() => render(items, true));
  await act(() => container.querySelector("button")!.click());
  const popup = () => document.querySelector('[aria-label="Conversation turns"]')!;
  expect(popup().textContent).toContain("2 loaded turns");
  const earlier = Array.from(popup().querySelectorAll("button")).find(
    (button) => button.textContent === "Load earlier turns",
  )!;
  await act(() => earlier.click());
  expect(load).toHaveBeenCalledOnce();
  await act(() => render(items, true, true));
  expect(earlier.disabled).toBe(true);
  const current = popup().querySelector<HTMLButtonElement>('[aria-current="step"]')!;
  await act(() => current.focus());
  const prepended = [
    { id: "older", rowIndex: 0, userText: "Earlier prompt", assistantText: "Earlier answer" },
    ...items.map((item) => ({ ...item, rowIndex: item.rowIndex + 2 })),
  ];
  await act(() => render(prepended, false));
  expect(document.activeElement).toBe(current);
  expect(popup().textContent).toContain("3 turns");
  expect(popup().textContent).not.toContain("Load earlier turns");
  await act(() => current.click());
  expect(select).toHaveBeenCalledExactlyOnceWith(prepended[2]);
});
