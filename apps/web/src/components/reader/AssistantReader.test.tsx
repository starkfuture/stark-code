// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AssistantReader } from "./AssistantReader";

const observers = new Set<() => void>();
vi.mock("../../lib/observeResize", () => ({
  observeResize: (_elements: unknown, callback: () => void) => {
    observers.add(callback);
    return () => observers.delete(callback);
  },
}));

let host: HTMLDivElement;
let root: Root;
let contentHeight = 800;
let viewportHeight = 500;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const scroll = vi.fn();
const source =
  "# First section\n\nThe first paragraph remains visible.\n\n## Second section\n\nThe second paragraph.\n\n## Third section\n\nThe final paragraph.";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  host.style.overflowY = "auto";
  document.body.append(host);
  Object.defineProperty(host, "clientHeight", { get: () => viewportHeight });
  contentHeight = 800;
  viewportHeight = 500;
  scroll.mockReset();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return new DOMRect(
      0,
      0,
      640,
      this.hasAttribute("data-assistant-reader-content") ? contentHeight : 0,
    );
  });
  vi.stubGlobal("innerHeight", 1000);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  expect(observers.size).toBe(0);
  expect(frames.size).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const measure = async () => {
  await act(async () => {
    for (const callback of observers) callback();
    for (const [id, callback] of frames) {
      frames.delete(id);
      callback(0);
    }
  });
};
const render = async (text = source, isStreaming = false) => {
  await act(async () =>
    root.render(
      <AssistantReader contentKey={text} isStreaming={isStreaming}>
        <div className="chat-markdown">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      </AssistantReader>,
    ),
  );
  await measure();
};
const contents = () => host.querySelector('nav[aria-label="Reply contents"]');

it("shows real section labels only when a completed reply exceeds its chat viewport", async () => {
  contentHeight = 500;
  await render();
  expect(contents()).toBeNull();
  contentHeight = 700; // Taller than the chat viewport, but shorter than the whole window.
  await measure();
  expect([...contents()!.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
    "First section",
    "Second section",
    "Third section",
  ]);
  viewportHeight = 900;
  await measure();
  expect(contents()).toBeNull();
  expect(host.textContent).toContain("The final paragraph.");
});

it("keeps the original DOM and scroll position stable while streaming and reveals contents on completion", async () => {
  const initial = "# First section\n\nThe first paragraph remains visible.";
  await render(initial, true);
  const original = host.querySelector(".chat-markdown p");
  await render(source, true);
  expect(contents()).toBeNull();
  expect(host.querySelector(".chat-markdown p")).toBe(original);
  await render(source, false);
  expect(contents()).not.toBeNull();
  expect(host.querySelector(".chat-markdown p")).toBe(original);
  expect(scroll).not.toHaveBeenCalled();
  expect(host.textContent).toContain("The first paragraph remains visible.");
});

it("recognizes standalone bold-label lines without treating inline emphasis, code or list labels as sections", async () => {
  await render(
    "**Overview:**\nFirst body.\n\n**Details:**\nSecond body.\n\n**Next steps:**\nThird body.\n\nText **Inline:** continues.\n\n**Not a section:** also continues.\n\n- **List label:**\n\n> # Quoted heading\n\n```md\n# Code heading\n**Code label:**\n```",
  );
  expect([...contents()!.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
    "Overview:",
    "Details:",
    "Next steps:",
  ]);
  expect(host.querySelector("pre")?.textContent).toContain("# Code heading");
});

it("does not invent contents for long responses with fewer than three sections", async () => {
  await render("# One section\n\nA long body.\n\n## Two sections\n\nMore body.");
  expect(contents()).toBeNull();
  expect(host.querySelectorAll(".chat-markdown h1, .chat-markdown h2")).toHaveLength(2);
});

it("navigates duplicate labels to their actual sections without changing the URL or hiding content", async () => {
  await render("## Same\n\nFirst.\n\n## Same\n\nSecond.\n\n## Last\n\nThird.");
  const heading = host.querySelectorAll<HTMLElement>(".chat-markdown h2")[1]!;
  const links = contents()!.querySelectorAll("a");
  expect(links[0]!.hash).not.toBe(links[1]!.hash);
  const hash = window.location.hash;
  await act(async () => links[1]!.click());
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "start", behavior: "auto" });
  expect(scroll.mock.contexts[0]).toBe(heading);
  expect(document.activeElement).toBe(heading);
  expect(window.location.hash).toBe(hash);
  expect(host.querySelector(".chat-markdown")?.textContent).toContain("First.");
});

it("replaces the outline when completed content changes and never navigates old sections", async () => {
  await render();
  await render("## New one\n\nFirst.\n\n## New two\n\nSecond.\n\n## New three\n\nThird.");
  expect([...contents()!.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
    "New one",
    "New two",
    "New three",
  ]);
  await act(async () => contents()!.querySelector("a")!.click());
  expect(document.activeElement?.textContent).toBe("New one");
});
