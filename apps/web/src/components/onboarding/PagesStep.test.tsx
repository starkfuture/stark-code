// @vitest-environment jsdom
import type {
  StarkPublishedPagesBridge,
  StarkPublishedPagesReadResult,
  StarkPublishedPagesStatus,
} from "@starkfuture/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PagesStep } from "./PagesStep";

const status = vi.fn<StarkPublishedPagesBridge["status"]>();
const connect = vi.fn<StarkPublishedPagesBridge["connect"]>();
const disconnect = vi.fn<StarkPublishedPagesBridge["disconnect"]>();
const listTools = vi.fn<StarkPublishedPagesBridge["listTools"]>();
const read = vi.fn<StarkPublishedPagesBridge["read"]>();
const onContinue = vi.fn();
const signedOut = { state: "signed-out", message: null } as const;
const connected = { state: "connected", message: null } as const;
const connecting = { state: "connecting", message: null } as const;
let root: Root;
let container: HTMLDivElement;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function button(label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
const mount = () => act(async () => root.render(<PagesStep onContinue={onContinue} />));
const click = (label: string) => act(async () => button(label).click());
const tick = () => act(async () => vi.advanceTimersByTimeAsync(1_000));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  status.mockResolvedValue(signedOut);
  connect.mockResolvedValue(connecting);
  listTools.mockResolvedValue([
    {
      name: "pages_list_projects",
      title: "Projects",
      description: "",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  ]);
  read.mockResolvedValue({ content: [], structuredContent: { projects: [] }, isError: false });
  window.desktopBridge = {
    publishedPages: {
      status,
      connect,
      disconnect,
      listTools,
      read,
      openPage: vi.fn(),
    },
  } as unknown as NonNullable<Window["desktopBridge"]>;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Stark Pages onboarding", () => {
  it("allows skipping without opening sign-in or reading Pages content", async () => {
    await mount();
    expect(button("Connect Stark Pages").disabled).toBe(false);
    await tick();
    expect(status).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
    expect(listTools).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await click("Skip for now");
    expect(onContinue).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("deduplicates sign-in clicks and waits for live read access before becoming ready", async () => {
    const signingIn = deferred<StarkPublishedPagesStatus>();
    const checkingAccess = deferred<StarkPublishedPagesReadResult>();
    connect.mockReturnValue(signingIn.promise);
    read.mockReturnValue(checkingAccess.promise);
    await mount();
    const signIn = button("Connect Stark Pages");
    await act(async () => {
      signIn.click();
      signIn.click();
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(button("Signing in…").disabled).toBe(true);
    await act(async () => signingIn.resolve(connecting));
    status.mockResolvedValue(connected);
    await tick();
    expect(button("Checking…").disabled).toBe(true);
    expect(container.textContent).not.toContain("ready to open");
    expect(read).toHaveBeenCalledExactlyOnceWith({ tool: "pages_list_projects", arguments: {} });
    await act(async () =>
      checkingAccess.resolve({ content: [], structuredContent: { projects: [] }, isError: false }),
    );
    expect(container.textContent).toContain("ready to open");
    await click("Continue");
    expect(onContinue).toHaveBeenCalledOnce();
    const checks = status.mock.calls.length;
    await tick();
    expect(status).toHaveBeenCalledTimes(checks);
  });

  it("verifies saved credentials and does not display returned private content", async () => {
    status.mockResolvedValue(connected);
    read.mockResolvedValue({
      content: [{ type: "text", text: "Private launch roadmap" }],
      structuredContent: { projects: [{ name: "Private launch roadmap" }] },
      isError: false,
    });
    await mount();
    expect(listTools).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("ready to open");
    expect(container.textContent).not.toContain("Private launch roadmap");
    expect(connect).not.toHaveBeenCalled();
  });

  it("does not claim read access when the project tool is missing", async () => {
    status.mockResolvedValue(connected);
    listTools.mockResolvedValue([]);
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("verify read access");
    expect(container.textContent).not.toContain("ready to open");
    expect(read).not.toHaveBeenCalled();
    expect(button("Try again").disabled).toBe(false);
  });

  it("rejects tool errors, hides provider details, and retries only on request", async () => {
    status.mockResolvedValue(connected);
    read.mockResolvedValueOnce({
      content: [{ type: "text", text: "OAuth token=private-token-value" }],
      isError: true,
    });
    await mount();
    expect(container.textContent).not.toContain("ready to open");
    expect(container.textContent).not.toContain("private-token-value");
    await tick();
    expect(read).toHaveBeenCalledOnce();
    connect.mockResolvedValue(connected);
    await click("Try again");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("ready to open");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shows a safe retry state when IPC or sign-in fails", async () => {
    status.mockRejectedValueOnce(new Error("Authorization: Bearer do-not-display"));
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Check your connection",
    );
    expect(container.textContent).not.toContain("do-not-display");
    connect.mockResolvedValueOnce({ state: "error", message: "client_secret=also-private" });
    await click("Try again");
    expect(container.textContent).not.toContain("also-private");
    expect(button("Try again").disabled).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("resumes an existing browser sign-in after remount without opening a second flow", async () => {
    status.mockResolvedValue(connecting);
    await mount();
    expect(button("Signing in…").disabled).toBe(true);
    status.mockResolvedValue(connected);
    await tick();
    expect(container.textContent).toContain("ready to open");
    expect(connect).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
  });

  it("leaves an ongoing sign-in intact when going back or skipping", async () => {
    const signingIn = deferred<StarkPublishedPagesStatus>();
    connect.mockReturnValue(signingIn.promise);
    await mount();
    await click("Connect Stark Pages");
    await click("Skip for now");
    await act(async () => root.render(<p>Choose your main folder</p>));
    await act(async () => signingIn.resolve(connected));
    await tick();
    expect(disconnect).not.toHaveBeenCalled();
    expect(listTools).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(container.textContent).toBe("Choose your main folder");
    status.mockResolvedValue(connected);
    await mount();
    expect(container.textContent).toContain("ready to open");
    expect(connect).toHaveBeenCalledOnce();
  });

  it("stops read verification if the user leaves before the tool catalog returns", async () => {
    const catalog = deferred<Awaited<ReturnType<StarkPublishedPagesBridge["listTools"]>>>();
    status.mockResolvedValue(connected);
    listTools.mockReturnValue(catalog.promise);
    await mount();
    await act(async () => root.render(<p>Agents</p>));
    await act(async () => catalog.resolve([]));
    expect(read).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(container.textContent).toBe("Agents");
  });

  it("explains desktop-only availability without pretending to connect", async () => {
    delete window.desktopBridge;
    await mount();
    expect(container.textContent).toContain("available in the desktop app");
    expect(container.textContent).not.toContain("ready to open");
    expect(status).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    await click("Continue");
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
