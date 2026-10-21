// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type McpServersListResult,
  type McpServerStatusEntry,
} from "@starkfuture/contracts";

const state = vi.hoisted(() => ({
  query: {
    data: undefined as McpServersListResult | undefined,
    error: null as string | null,
    refresh: vi.fn(),
    isPending: false,
  },
  signIn: vi.fn(),
  open: vi.fn(),
  mutate: vi.fn(),
  manage: true,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    mcpServers: () => ({}),
    signInMcpServer: state.signIn,
    reloadMcpServers: state.mutate,
    reconnectMcpServer: state.mutate,
    setMcpServerEnabled: state.mutate,
    signOutMcpServer: state.mutate,
    submitMcpServerCallback: state.mutate,
  },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => state.query }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_id: unknown, scope: string) =>
    scope === "providers:manage" ? state.manage : true,
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    presentation: {
      entry: { target: { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://localhost:5733" } },
    },
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: state.open } }),
}));

import { McpHealthBanner } from "./McpHealthBanner";
let root: Root;
let container: HTMLDivElement;
const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const server = (
  name: string,
  status: McpServerStatusEntry["status"],
  recovery?: McpServerStatusEntry["recovery"],
): McpServerStatusEntry => ({
  name,
  status,
  locked: false,
  tools: [],
  authKind: "oauth",
  ...(recovery ? { recovery } : {}),
});
const render = (busy = false, ref = threadRef) =>
  act(() => root.render(<McpHealthBanner threadRef={ref} sessionBusy={busy} />));
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === label || entry.getAttribute("aria-label") === label,
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.query.data = {
    live: true,
    reconnectScope: "server",
    servers: [
      server("Drive", "needs-auth"),
      server("Internal", "failed", { state: "vpn-off", attempts: 0 }),
      server("Healthy", "connected"),
    ],
  };
  state.query.error = null;
  state.query.refresh.mockReset();
  state.manage = true;
  state.signIn
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { url: "https://auth.example.com/oauth" } });
  state.open.mockReset().mockResolvedValue(undefined);
  state.mutate.mockReset().mockResolvedValue({ _tag: "Success" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows only live connection issues and opens guarded sign-in with one explicit click", async () => {
  await render();
  expect(container.textContent).toContain(
    "Your VPN is disconnected. Connect it, then check again.",
  );
  expect(container.textContent).not.toContain("Healthy");
  expect(state.signIn).not.toHaveBeenCalled();
  await act(async () => button("Sign in to Drive")!.click());
  expect(state.signIn).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env",
    input: { threadId: "thread", name: "Drive" },
  });
  expect(state.open).toHaveBeenCalledExactlyOnceWith("https://auth.example.com/oauth");
  expect(document.body.textContent).toContain("Waiting for sign-in to Drive");
  expect(state.mutate).not.toHaveBeenCalled();
});

it("offers review without sign-in permission and blocks changes during a turn", async () => {
  await render(true);
  expect(button("Sign in to Drive")?.disabled).toBe(true);
  await act(() => button("Sign in to Drive")!.click());
  expect(state.signIn).not.toHaveBeenCalled();
  state.manage = false;
  await render();
  expect(button("Sign in to Drive")).toBeUndefined();
  await act(() => button("Review connections")!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Connections");
  expect(state.signIn).not.toHaveBeenCalled();
});

it("does not mislabel an inactive or failed status query as a connector failure", async () => {
  state.query.data = { ...state.query.data!, live: false };
  await render();
  expect(container.textContent).toBe("");
  state.query.data = { ...state.query.data!, live: true };
  state.query.error = "Transport unavailable";
  await render();
  expect(container.textContent).toBe("");
});

it("shares status polling between banner and open panel and drops stale sign-in state on target changes", async () => {
  await render();
  expect(state.query.refresh).toHaveBeenCalledTimes(1);
  await act(() => button("Review connections")!.click());
  expect(state.query.refresh).toHaveBeenCalledTimes(1);
  expect(state.signIn).not.toHaveBeenCalled();
  await render(false, { ...threadRef, threadId: ThreadId.make("other") });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(state.query.refresh).toHaveBeenCalledTimes(2);
});

it("shows FortiClient disconnection as advisory while failed-server retries continue", async () => {
  state.query.data = {
    live: true,
    reconnectScope: "server",
    servers: [
      server("Public docs", "failed", {
        state: "network-unavailable",
        attempts: 2,
        vpnState: "forticlient-disconnected",
      }),
    ],
  };
  await render();
  expect(container.textContent).toContain("FortiClient is disconnected.");
  expect(container.textContent).toContain(
    "This server is unreachable; automatic retries continue.",
  );
  expect(container.textContent).not.toContain("Connect it, then check again");
  state.query.data = {
    live: true,
    reconnectScope: "server",
    servers: [server("Public docs", "failed", { state: "waiting", attempts: 2 })],
  };
  await render();
  expect(container.textContent).not.toContain("FortiClient");
  expect(container.textContent).toContain("Waiting for a safe moment to retry.");
});
