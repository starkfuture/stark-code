import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type McpServerStatusEntry } from "@starkfuture/contracts";
const state = vi.hoisted(() => ({
  query: {
    data: { servers: [] as McpServerStatusEntry[], live: true },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  },
  reconnect: vi.fn(),
  toggle: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  submit: vi.fn(),
  open: vi.fn(),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    mcpServers: () => ({}),
    reconnectMcpServer: state.reconnect,
    setMcpServerEnabled: state.toggle,
    signInMcpServer: state.signIn,
    signOutMcpServer: state.signOut,
    submitMcpServerCallback: state.submit,
  },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => state.query }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    presentation: {
      entry: { target: { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://localhost:5733" } },
    },
  }),
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: state.open } }),
}));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: "button" | "submit";
  }) => (
    <button disabled={disabled} type={type} onClick={onClick}>
      {children}
    </button>
  ),
}));
import { McpServerRows, McpServersPanel } from "./McpServersPanel";
let renderer: ReactTestRenderer | undefined;
const server = (patch: Partial<McpServerStatusEntry> = {}) =>
  ({
    name: "Drive",
    source: "claudeai",
    status: "needs-auth",
    tools: [{ name: "search", readOnly: true, destructive: false, openWorld: true }],
    authKind: "oauth",
    locked: false,
    canSubmitCallback: true,
    canSignOut: true,
    ...patch,
  }) satisfies McpServerStatusEntry;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("window", { setInterval, clearInterval, setTimeout, clearTimeout });
  state.query.data = { servers: [server()], live: true };
  for (const fn of [state.reconnect, state.toggle, state.signIn, state.signOut, state.submit])
    fn.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.open.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("keeps app servers locked and viewers status-only, then dispatches only an explicit row click", async () => {
  const action = vi.fn();
  const rows = (manage: boolean, entries: McpServerStatusEntry[]) => (
    <McpServerRows
      servers={entries}
      canReconnect={manage}
      canManage={manage}
      busy={false}
      onAction={action}
    />
  );
  await act(async () => {
    renderer = create(rows(true, [server({ name: "stark-code", locked: true })]));
  });
  expect(renderer!.root.findAllByType("button")).toHaveLength(0);
  await act(async () => renderer!.update(rows(false, [server()])));
  expect(renderer!.root.findAllByType("button")).toHaveLength(0);
  await act(async () =>
    renderer!.update(rows(true, [server({ source: "codex", status: "disabled" })])),
  );
  await act(async () => renderer!.root.findAllByType("button")[0]!.props.onClick());
  expect(action).toHaveBeenCalledWith(expect.objectContaining({ name: "Drive" }), "enable");
});
it("shows the authorization host before opening the system browser and validates a pasted callback", async () => {
  state.signIn.mockResolvedValue({
    _tag: "Success",
    value: {
      url: "https://auth.example.com/oauth",
      callbackExpected: true,
      redirectScheme: "localhost",
      callbackPort: 3333,
      state: "expected",
    },
  });
  const panel = () => (
    <McpServersPanel
      environmentId={EnvironmentId.make("env")}
      target={{ threadId: ThreadId.make("thread") }}
    />
  );
  await act(async () => {
    renderer = create(panel());
  });
  const button = (text: string) =>
    renderer!.root.findAllByType("button").find((entry) => entry.children.join("") === text)!;
  await act(async () => button("Sign in").props.onClick());
  expect(state.open).not.toHaveBeenCalled();
  expect(
    renderer!.root
      .findAllByType("p")
      .some((entry) => entry.children.join("") === "Opens auth.example.com in your browser."),
  ).toBe(true);
  const browserButton = renderer!.root
    .findAllByType("button")
    .find((entry) => entry.children.join("") === "Open auth.example.com in browser")!;
  await act(async () => browserButton.props.onClick());
  expect(state.open).toHaveBeenCalledWith("https://auth.example.com/oauth");
  const input = renderer!.root.findByType("input");
  await act(async () =>
    input.props.onChange({
      target: { value: "http://localhost:3333/callback?code=private&state=wrong" },
    }),
  );
  await act(async () =>
    renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} }),
  );
  expect(state.submit).not.toHaveBeenCalled();
  await act(async () =>
    input.props.onChange({
      target: { value: "http://localhost:3333/callback?code=private&state=expected" },
    }),
  );
  await act(async () =>
    renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} }),
  );
  expect(state.submit).toHaveBeenCalledWith({
    environmentId: "env",
    input: {
      threadId: "thread",
      name: "Drive",
      url: "http://localhost:3333/callback?code=private&state=expected",
    },
  });
  state.query.data = { servers: [server({ status: "connected" })], live: true };
  await act(async () => renderer!.update(panel()));
  expect(renderer!.root.findAllByType("input")).toHaveLength(0);
});
