import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { StarkPublishedPagesStatus } from "@starkfuture/contracts";

vi.mock("./ui/button", () => ({
  Button: (props: Record<string, unknown>) => <button {...props} />,
}));
vi.mock("./ui/input", () => ({ Input: (props: Record<string, unknown>) => <input {...props} /> }));
vi.mock("./ui/select", () => ({
  Select: (props: Record<string, unknown>) => <select {...props} />,
  SelectItem: (props: Record<string, unknown>) => <option {...props} />,
  SelectPopup: (props: Record<string, unknown>) => <div {...props} />,
  SelectTrigger: (props: Record<string, unknown>) => <button {...props} />,
  SelectValue: (props: Record<string, unknown>) => <span {...props} />,
}));
vi.mock("./PublishedPageContent", () => ({
  PublishedPageContent: ({ value }: { value: unknown }) => <p>{JSON.stringify(value)}</p>,
}));
import { PublishedStarkPages } from "./PublishedStarkPages";

let renderer: ReactTestRenderer | undefined;
let status: StarkPublishedPagesStatus;
let ticks: Set<() => void>;
const read = vi.fn();
const connect = vi.fn();
const disconnect = vi.fn();
const listTools = vi.fn();
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((item) => item.children.includes(label))!;
const shown = () => JSON.stringify(renderer!.toJSON());
const tick = () =>
  act(async () => {
    for (const callback of ticks) callback();
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  status = { state: "signed-out", message: null };
  ticks = new Set();
  for (const mock of [read, connect, disconnect, listTools]) mock.mockReset();
  connect.mockImplementation(
    async () => (status = { state: "connecting", message: "Finish sign-in in your browser." }),
  );
  disconnect.mockImplementation(async () => (status = { state: "signed-out", message: null }));
  listTools.mockResolvedValue([
    {
      name: "pages_list_projects",
      title: "Projects",
      description: "",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "pages_read_file",
      title: "Read",
      description: "",
      inputSchema: {
        type: "object",
        properties: { root: { type: "string" }, path: { type: "string" } },
        required: ["root", "path"],
      },
    },
  ]);
  read.mockResolvedValue({ content: [{ type: "text", text: "Workspace report" }], isError: false });
  vi.stubGlobal("window", {
    desktopBridge: {
      publishedPages: { status: async () => status, connect, disconnect, listTools, read },
    },
    setInterval: (callback: () => void) => {
      ticks.add(callback);
      return callback;
    },
    clearInterval: (callback: () => void) => ticks.delete(callback),
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  expect(ticks.size).toBe(0);
  vi.unstubAllGlobals();
});

it("opens sign-in only on a user click, waits for authentication, then reads projects", async () => {
  await act(async () => {
    renderer = create(<PublishedStarkPages />);
  });
  expect(connect).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  await act(async () => button("Connect Pages").props.onClick());
  expect(shown()).toContain("Finish sign-in");
  expect(read).not.toHaveBeenCalled();
  status = { state: "connected", message: null };
  await tick();
  expect(read).toHaveBeenCalledExactlyOnceWith({ tool: "pages_list_projects", arguments: {} });
  expect(shown()).toContain("Workspace report");
  await act(async () => button("Disconnect").props.onClick());
  expect(shown()).not.toContain("Workspace report");
  expect(shown()).toContain("Connect Pages");
});

it("collects actual required read fields before making a read and discards results on leaving", async () => {
  status = { state: "connected", message: null };
  await act(async () => {
    renderer = create(<PublishedStarkPages />);
  });
  await act(async () =>
    renderer!.root.findAllByType("select")[0]!.props.onValueChange("pages_read_file"),
  );
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(shown()).toContain("Enter root");
  expect(read).toHaveBeenCalledTimes(1);
  const inputs = renderer!.root.findAllByType("input");
  await act(async () => {
    inputs[0]!.props.onChange({ target: { value: "team" } });
    inputs[1]!.props.onChange({ target: { value: "report/index.html" } });
  });
  let resolve: (value: unknown) => void = () => {};
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(read).toHaveBeenLastCalledWith({
    tool: "pages_read_file",
    arguments: { root: "team", path: "report/index.html" },
  });
  await act(async () =>
    renderer!.root.findAllByType("select")[0]!.props.onValueChange("pages_list_projects"),
  );
  await act(async () =>
    resolve({ content: [{ type: "text", text: "Stale private page" }], isError: false }),
  );
  expect(shown()).not.toContain("Stale private page");
});

it("cancels browser sign-in without starting a page read", async () => {
  await act(async () => {
    renderer = create(<PublishedStarkPages />);
  });
  await act(async () => button("Connect Pages").props.onClick());
  await act(async () => button("Cancel sign-in").props.onClick());
  expect(disconnect).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  expect(shown()).toContain("Connect Pages");
});
