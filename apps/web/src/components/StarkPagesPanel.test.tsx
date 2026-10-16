// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/usePreviewPanelInlineSize", () => ({
  usePreviewPanelInlineSize: () => ({ width: 540, handlers: {} }),
}));
vi.mock("./StarkPagesSidebar", () => ({
  StarkPagesSidebar: () => <iframe title="Workspace page" sandbox="allow-same-origin" />,
}));
vi.mock("./PublishedStarkPages", () => ({
  PublishedStarkPages: () => {
    const [page, setPage] = useState(false);
    return page ? (
      <iframe title="Selected published page" sandbox="allow-same-origin" />
    ) : (
      <button onClick={() => setPage(true)}>Read project home</button>
    );
  },
}));
import { StarkPagesPanel } from "./StarkPagesPanel";

let root: Root;
let container: HTMLDivElement;
const close = vi.fn();
const render = (inline = true) =>
  act(() =>
    root.render(
      <StarkPagesPanel
        inline={inline}
        projectRoot="/project"
        agent="claude"
        canPublish={false}
        onPublishRequest={vi.fn()}
        onClose={close}
      />,
    ),
  );
const button = (label: string) => {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
  if (!element) throw new Error(`Missing ${label}`);
  return element;
};
const click = (label: string) => act(() => button(label).click());
const escape = () =>
  act(() => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  close.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("preserves the workspace iframe and scroll state through full view and responsive docking", async () => {
  await render();
  const frame = container.querySelector("iframe")!;
  const frameWindow = frame.contentWindow;
  frame.contentDocument!.body.innerHTML = '<main style="height:2000px">A workspace page</main>';
  frame.contentDocument!.documentElement.scrollTop = 280;
  await click("Expand Pages");
  expect(container.querySelector("iframe")).toBe(frame);
  expect(frame.contentWindow).toBe(frameWindow);
  expect(frame.contentDocument!.documentElement.scrollTop).toBe(280);
  expect(container.querySelector('[data-pages-expanded="true"]')).not.toBeNull();
  await render(false);
  await click("Return Pages to side panel");
  expect(container.querySelector("iframe")).toBe(frame);
  expect(frame.contentDocument!.body.textContent).toBe("A workspace page");
  await render(true);
  expect(container.querySelector("iframe")).toBe(frame);
  expect(close).not.toHaveBeenCalled();
  await click("Close Pages");
  expect(close).toHaveBeenCalledOnce();
});

it("keeps the published selection and restores the panel on Escape instead of closing Pages", async () => {
  await render();
  await click("Published");
  await click("Read project home");
  const frame = container.querySelector("iframe")!;
  await click("Expand Pages");
  button("Return Pages to side panel").focus();
  await escape();
  expect(container.querySelector('[data-pages-expanded="true"]')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  expect(container.querySelector('iframe[title="Selected published page"]')).toBe(frame);
  expect(document.activeElement).toBe(button("Expand Pages"));
  await render(false);
  expect(container.querySelector('iframe[title="Selected published page"]')).toBe(frame);
  await escape();
  expect(close).toHaveBeenCalledOnce();
});
