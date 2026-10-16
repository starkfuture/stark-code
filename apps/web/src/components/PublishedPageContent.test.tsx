// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { StarkPublishedPageDocument } from "@starkfuture/contracts";
import { PublishedPageContent } from "./PublishedPageContent";

const page: StarkPublishedPageDocument = {
  root: "demo",
  path: "guide/index.html",
  source: '<h1>Guide</h1><a href="../next.html">Next</a>',
  mimeType: "text/html",
  assets: [],
  warnings: [],
  publicUrl: "https://pages.starkfuture.com/demo/guide/index.html",
};
let container: HTMLDivElement;
let root: Root;
const exit = vi.fn();
const navigate = vi.fn();
const openLink = vi.fn();
const render = (expanded: boolean) =>
  act(() =>
    root.render(
      <PublishedPageContent
        document={page}
        expanded={expanded}
        onExitExpanded={exit}
        onNavigate={navigate}
      />,
    ),
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of [exit, navigate, openLink]) mock.mockReset();
  window.desktopBridge = {
    openStarkPagesLink: openLink,
  } as unknown as NonNullable<Window["desktopBridge"]>;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.unstubAllGlobals();
});

it("preserves the document and iframe reading position when expanding and returning to the panel", async () => {
  await render(false);
  const frame = container.querySelector("iframe")!;
  const childWindow = frame.contentWindow;
  const source = frame.srcdoc;
  const scroll = frame.contentDocument!.documentElement;
  scroll.scrollTop = 230;
  await render(true);
  expect(container.querySelector("iframe")).toBe(frame);
  expect(frame.contentWindow).toBe(childWindow);
  expect(frame.srcdoc).toBe(source);
  expect(scroll.scrollTop).toBe(230);
  await render(false);
  expect(container.querySelector("iframe")).toBe(frame);
  expect(frame.contentWindow).toBe(childWindow);
  expect(frame.srcdoc).toBe(source);
  expect(scroll.scrollTop).toBe(230);
});

it("accepts Escape only from the displayed opaque-origin frame while expanded and keeps link routing", async () => {
  await render(true);
  const frame = container.querySelector("iframe")!;
  const send = (
    data: unknown,
    origin = "null",
    source: MessageEventSource | null = frame.contentWindow,
  ) => act(() => window.dispatchEvent(new MessageEvent("message", { data, origin, source })));
  const escape = { source: "stark-published-page", type: "exit-expanded" };
  await send(escape, window.location.origin);
  await send(escape, "null", window);
  await send({ source: "other-page", type: "exit-expanded" });
  expect(exit).not.toHaveBeenCalled();
  await send(escape);
  expect(exit).toHaveBeenCalledOnce();
  await send({ source: "stark-published-page", type: "open-link", url: "../next.html" });
  expect(navigate).toHaveBeenCalledExactlyOnceWith("next.html");
  await send({ source: "stark-published-page", type: "open-link", url: "https://example.com" });
  expect(openLink).toHaveBeenCalledExactlyOnceWith("https://example.com/");
  await send({ source: "stark-published-page", type: "unknown", url: "../ignored.html" });
  expect(navigate).toHaveBeenCalledOnce();
  await render(false);
  await send(escape);
  expect(exit).toHaveBeenCalledOnce();
});
