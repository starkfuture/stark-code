// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { StarkPublishedPageDocument, StarkPublishedPagesStatus } from "@starkfuture/contracts";

vi.mock("./PublishedPageContent", () => ({
  PublishedPageContent: ({
    document,
    onNavigate,
  }: {
    document: StarkPublishedPageDocument;
    onNavigate: (path: string) => void;
  }) => (
    <div>
      {document.source}
      <button onClick={() => onNavigate("next/index.html")}>Related page</button>
    </div>
  ),
}));
import { PublishedStarkPages } from "./PublishedStarkPages";

let root: Root;
let container: HTMLDivElement;
let status: StarkPublishedPagesStatus;
let ticks: Set<() => void>;
const read = vi.fn();
const openPage = vi.fn();
const openLink = vi.fn();
const connect = vi.fn();
const disconnect = vi.fn();
const listTools = vi.fn();
const projects = {
  content: [],
  isError: false,
  structuredContent: {
    projects: [
      {
        root: "team/release-notes",
        base_url: "https://pages.starkfuture.com/release-notes/",
        file_count: 12,
      },
      { root: "team/design", base_url: "https://pages.starkfuture.com/design/", file_count: 4 },
    ],
  },
};
const searchResults = {
  content: [],
  isError: false,
  structuredContent: {
    results: [
      {
        root: "team/release-notes",
        path: "launch/index.html",
        excerpt: { title: "Launch plan", text: "Schedule and owners" },
      },
      {
        root: "team/release-notes",
        path: "release/index.html",
        excerpt: { title: "Release notes", text: "What changed" },
      },
    ],
  },
};
const document: StarkPublishedPageDocument = {
  root: "team/release-notes",
  path: "launch/index.html",
  source: "A styled launch plan",
  mimeType: "text/html",
  assets: [],
  warnings: [],
  publicUrl: "https://pages.starkfuture.com/release-notes/launch/",
};
const button = (label: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const click = (label: string) => act(() => button(label).click());
const input = async (label: string, value: string) => {
  const element = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const shown = () => container.textContent;
const tick = () =>
  act(async () => {
    for (const callback of ticks) callback();
  });
const render = () => act(() => root.render(<PublishedStarkPages />));
async function selectProject() {
  status = { state: "connected", message: null };
  await render();
  await click("release notes12 published files");
}
async function searchPages() {
  await input("Search pages", "launch");
  await click("Search");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  status = { state: "signed-out", message: null };
  ticks = new Set();
  for (const mock of [read, openPage, openLink, connect, disconnect, listTools]) mock.mockReset();
  connect.mockImplementation(
    async () => (status = { state: "connecting", message: "Finish sign-in in your browser." }),
  );
  disconnect.mockImplementation(async () => (status = { state: "signed-out", message: null }));
  listTools.mockResolvedValue(
    ["pages_list_projects", "pages_search"].map((name) => ({
      name,
      title: name,
      description: "",
      inputSchema: { type: "object", properties: {} },
    })),
  );
  read.mockImplementation(async ({ tool }: { tool: string }) =>
    tool === "pages_list_projects" ? projects : searchResults,
  );
  openPage.mockResolvedValue(document);
  window.desktopBridge = {
    publishedPages: { status: async () => status, connect, disconnect, listTools, read, openPage },
    openStarkPagesLink: openLink,
  } as unknown as NonNullable<Window["desktopBridge"]>;
  vi.spyOn(window, "setInterval").mockImplementation(((callback: () => void) => {
    ticks.add(callback);
    return callback;
  }) as unknown as typeof window.setInterval);
  vi.spyOn(window, "clearInterval").mockImplementation(((callback: () => void) =>
    ticks.delete(callback)) as unknown as typeof window.clearInterval);
  container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  expect(ticks.size).toBe(0);
  delete window.desktopBridge;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("opens browser sign-in only on a click, then presents searchable projects and disconnects", async () => {
  await render();
  expect(connect).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  await click("Connect Pages");
  expect(shown()).toContain("Finish sign-in");
  expect(read).not.toHaveBeenCalled();
  status = { state: "connected", message: null };
  await tick();
  expect(read).toHaveBeenCalledExactlyOnceWith({ tool: "pages_list_projects", arguments: {} });
  expect(shown()).toContain("release notes");
  await input("Find a project", "design");
  expect(shown()).not.toContain("release notes");
  expect(shown()).toContain("design");
  await input("Find a project", "absent");
  expect(shown()).toContain("No projects match");
  await click("Disconnect");
  expect(shown()).not.toContain("design");
  expect(shown()).toContain("Connect Pages");
});

it("opens project home or scoped search results, follows page links and returns to the same results", async () => {
  await selectProject();
  expect(read).toHaveBeenCalledTimes(1);
  expect(button("Search").disabled).toBe(true);
  await searchPages();
  expect(read).toHaveBeenLastCalledWith({
    tool: "pages_search",
    arguments: { root: "team/release-notes", query: "launch", limit: 20 },
  });
  const panel = container.querySelector<HTMLElement>('section[aria-label="Published Pages"]')!;
  panel.scrollTop = 140;
  await click("Launch planSchedule and ownerslaunch/index.html");
  expect(panel.scrollTop).toBe(0);
  expect(openPage).toHaveBeenLastCalledWith({
    root: "team/release-notes",
    path: "launch/index.html",
    refresh: false,
  });
  expect(shown()).toContain("A styled launch plan");
  await click("Open in browser");
  expect(openLink).toHaveBeenCalledExactlyOnceWith(document.publicUrl);
  await click("Related page");
  expect(openPage).toHaveBeenLastCalledWith({
    root: "team/release-notes",
    path: "next/index.html",
    refresh: false,
  });
  await click("Back to pages");
  expect(panel.scrollTop).toBe(140);
  expect(shown()).toContain("2 results for “launch”");
  expect(container.querySelector<HTMLInputElement>('[aria-label="Search pages"]')?.value).toBe(
    "launch",
  );
  await click("Open project home");
  expect(openPage).toHaveBeenLastCalledWith({
    root: "team/release-notes",
    path: "index.html",
    refresh: false,
  });
  await click("Projects");
  expect(shown()).toContain("Your projects");
});

it("discards a late read after Back and a late search after selecting another project", async () => {
  await selectProject();
  let finishPage: (value: StarkPublishedPageDocument) => void = () => {};
  openPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPage = resolve;
      }),
  );
  await click("Open project home");
  expect(shown()).toContain("Opening page");
  await click("Back to pages");
  await act(() => finishPage(document));
  expect(shown()).not.toContain("A styled launch plan");
  let finishSearch: (value: typeof searchResults) => void = () => {};
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSearch = resolve;
      }),
  );
  await searchPages();
  await click("Projects");
  await click("design4 published files");
  await act(() => finishSearch(searchResults));
  expect(shown()).not.toContain("Launch plan");
  expect(shown()).toContain("Search by title or topic");
});

it("keeps empty lists useful and supports retrying catalog, search and page failures", async () => {
  status = { state: "connected", message: null };
  read.mockRejectedValueOnce(new Error("Temporarily unavailable"));
  await render();
  expect(shown()).toContain("Temporarily unavailable");
  await click("Retry projects");
  await click("release notes12 published files");
  read.mockResolvedValueOnce({ content: [], isError: false, structuredContent: { results: [] } });
  await searchPages();
  expect(shown()).toContain("No pages match “launch”");
  read.mockRejectedValueOnce(new Error("Search failed"));
  await click("Search");
  await click("Retry search");
  expect(shown()).toContain("Launch plan");
  openPage.mockRejectedValueOnce(new Error("Page unavailable"));
  await click("Launch planSchedule and ownerslaunch/index.html");
  expect(shown()).toContain("Page unavailable");
  await click("Retry page");
  expect(openPage).toHaveBeenLastCalledWith({
    root: "team/release-notes",
    path: "launch/index.html",
    refresh: true,
  });
  expect(shown()).toContain("A styled launch plan");
});

it("clears an in-flight private page when sign-in expires and ignores its late result", async () => {
  await selectProject();
  let finish: (value: StarkPublishedPageDocument) => void = () => {};
  openPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click("Open project home");
  status = { state: "signed-out", message: null };
  await tick();
  await act(() => finish(document));
  expect(shown()).toContain("Connect Pages");
  expect(shown()).not.toContain("A styled launch plan");
});

it("cancels browser sign-in without starting a page read", async () => {
  await render();
  await click("Connect Pages");
  await click("Cancel sign-in");
  expect(disconnect).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  expect(shown()).toContain("Connect Pages");
});

it("shows an empty account without exposing technical tool fields", async () => {
  status = { state: "connected", message: null };
  read.mockResolvedValueOnce({ content: [], isError: false, structuredContent: { projects: [] } });
  await render();
  expect(shown()).toContain("No published projects are available for this account yet.");
  expect(container.querySelector('[aria-label="Published Pages action"]')).toBeNull();
  expect(container.querySelector("form")).toBeNull();
  await click("Refresh");
  expect(shown()).toContain("release notes");
});

it("refreshes a cached page without hiding it during loading or a failed refresh", async () => {
  await selectProject();
  await click("Open project home");
  let finish: (value: StarkPublishedPageDocument) => void = () => {};
  openPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click("Refresh page");
  expect(openPage).toHaveBeenLastCalledWith({
    root: "team/release-notes",
    path: "index.html",
    refresh: true,
  });
  expect(shown()).toContain("A styled launch plan");
  expect(shown()).toContain("Refreshing page");
  expect(button("Refresh page").disabled).toBe(true);
  await act(() => finish({ ...document, source: "The refreshed plan" }));
  expect(shown()).toContain("The refreshed plan");
  expect(shown()).not.toContain("A styled launch plan");
  openPage.mockRejectedValueOnce(new Error("Refresh unavailable"));
  await click("Refresh page");
  expect(shown()).toContain("Refresh unavailable");
  expect(shown()).toContain("The refreshed plan");
  expect(button("Refresh page").disabled).toBe(false);
});
