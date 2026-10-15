import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("./ui/button", () => ({
  Button: (props: Record<string, unknown>) => <button {...props} />,
}));
import { StarkPagesSidebar } from "./StarkPagesSidebar";

let renderer: ReactTestRenderer | undefined;
let listeners: Set<(event: MessageEvent) => void>;
let intervals: Set<() => void>;
let timeouts: Set<() => void>;
const frameWindow = { postMessage: vi.fn() };
const findMirror = vi.fn();
const openFollow = vi.fn();
const openLink = vi.fn();
const publish = vi.fn();
const props = (root = "/project", canPublish = true) => ({
  projectRoot: root,
  agent: "claude" as const,
  canPublish,
  onPublishRequest: publish,
  onClose: vi.fn(),
});
const panel = (root = "/project", canPublish = true) => (
  <StarkPagesSidebar {...props(root, canPublish)} />
);
const message = async (data: unknown, options: { source?: unknown; origin?: string } = {}) => {
  await act(async () => {
    const event = {
      data,
      source: options.source ?? frameWindow,
      origin: options.origin ?? "http://127.0.0.1:4317",
    } as MessageEvent;
    for (const listener of listeners) listener(event);
  });
};
const ready = (root = "/project") =>
  message({ v: 1, source: "stark-pages", type: "ready", root, port: 4317 });
const request = {
  v: 1,
  source: "stark-pages",
  type: "publish-request",
  page: { slug: "decision-one", title: "Decision" },
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listeners = new Set();
  intervals = new Set();
  timeouts = new Set();
  for (const mock of [findMirror, openFollow, openLink, publish, frameWindow.postMessage])
    mock.mockReset();
  findMirror.mockImplementation(async (root: string) => ({ root, port: 4317 }));
  openFollow.mockResolvedValue(true);
  openLink.mockResolvedValue(true);
  vi.stubGlobal("window", {
    desktopBridge: {
      getStarkPagesMirror: findMirror,
      openStarkPagesExternal: openFollow,
      openStarkPagesLink: openLink,
    },
    setInterval: (callback: () => void) => {
      intervals.add(callback);
      return callback;
    },
    clearInterval: (callback: () => void) => intervals.delete(callback),
    setTimeout: (callback: () => void) => {
      timeouts.add(callback);
      return callback;
    },
    clearTimeout: (callback: () => void) => timeouts.delete(callback),
    addEventListener: (_name: string, callback: (event: MessageEvent) => void) =>
      listeners.add(callback),
    removeEventListener: (_name: string, callback: (event: MessageEvent) => void) =>
      listeners.delete(callback),
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  expect(intervals.size).toBe(0);
  expect(timeouts.size).toBe(0);
  expect(listeners.size).toBe(0);
  vi.unstubAllGlobals();
});
const mount = async () => {
  await act(async () => {
    renderer = create(panel(), {
      createNodeMock: (element) =>
        element.type === "iframe" ? { contentWindow: frameWindow } : null,
    });
  });
};

it("starts Pages on open, waits for readiness, then polls without relaunching", async () => {
  let complete!: (mirror: { root: string; port: number }) => void;
  const ensure = vi.fn(
    () =>
      new Promise<{ root: string; port: number }>((resolve) => {
        complete = resolve;
      }),
  );
  window.desktopBridge!.ensureStarkPagesMirror = ensure;
  await mount();
  expect(renderer!.root.findAllByType("iframe")).toHaveLength(0);
  expect(
    renderer!.root
      .findAllByType("p")
      .flatMap((node) => node.children)
      .join(" "),
  ).toContain("Starting Pages");
  await act(async () => {
    for (const check of intervals) check();
  });
  expect(ensure).toHaveBeenCalledExactlyOnceWith("/project");
  expect(findMirror).not.toHaveBeenCalled();
  await act(async () => {
    complete({ root: "/project", port: 4317 });
  });
  expect(renderer!.root.findByType("iframe").props.src).toBe("http://127.0.0.1:4317/panel");
  await act(async () => {
    for (const check of intervals) check();
  });
  expect(findMirror).toHaveBeenCalledExactlyOnceWith("/project");
  expect(ensure).toHaveBeenCalledTimes(1);
});

it("shows a recoverable startup failure and retries only when requested", async () => {
  const ensure = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ root: "/project", port: 4317 });
  window.desktopBridge!.ensureStarkPagesMirror = ensure;
  findMirror.mockResolvedValue(null);
  await mount();
  expect(renderer!.root.findByProps({ role: "status" }).children.join(" ")).toContain(
    "Pages could not start",
  );
  await act(async () => {
    for (const check of intervals) check();
  });
  expect(ensure).toHaveBeenCalledTimes(1);
  const retryButton = renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Retry Pages"))!;
  await act(async () => retryButton.props.onClick());
  expect(ensure).toHaveBeenCalledTimes(2);
  expect(renderer!.root.findAllByProps({ role: "status" })).toHaveLength(0);
  expect(renderer!.root.findAllByType("iframe")).toHaveLength(1);
});

it("accepts requests only from its own ready frame, then updates capabilities when the active thread changes", async () => {
  await mount();
  await message(request);
  expect(publish).not.toHaveBeenCalled();
  await message(
    { v: 1, source: "stark-pages", type: "ready", root: "/project", port: 4317 },
    { source: {} },
  );
  await message(request);
  expect(publish).not.toHaveBeenCalled();
  await ready();
  expect(frameWindow.postMessage).toHaveBeenLastCalledWith(
    { v: 1, source: "stark-host", type: "host", canPublish: true, agent: "claude" },
    "http://127.0.0.1:4317",
  );
  await message(request, { origin: "http://127.0.0.1:4318" });
  expect(publish).not.toHaveBeenCalled();
  await message(request);
  expect(publish).toHaveBeenCalledExactlyOnceWith("decision-one", "Decision");
  await act(async () => renderer!.update(panel("/project", false)));
  expect(frameWindow.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ canPublish: false }),
    "http://127.0.0.1:4317",
  );
  await message(request);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain(
    "Stark plugin",
  );
});

it("rechecks the project on switching and refuses a foreign ready root", async () => {
  await mount();
  await ready();
  await act(async () => renderer!.update(panel("/other")));
  await message(request);
  expect(publish).not.toHaveBeenCalled();
  await ready("/project");
  await message(request);
  expect(publish).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain(
    "different project",
  );
  await ready("/other");
  await message(request);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(findMirror).toHaveBeenLastCalledWith("/other");
});

it("validates follower and source links before opening the external browser", async () => {
  await mount();
  await ready();
  const send = (type: string, url: string) => message({ v: 1, source: "stark-pages", type, url });
  await send("open-external", "http://127.0.0.1:4318/follow?slug=decision-one");
  await send("open-external", "https://example.com/follow?slug=decision-one");
  await send("open-link", "javascript:alert(1)");
  await send("open-link", "https://user:password@example.com");
  expect(openFollow).not.toHaveBeenCalled();
  expect(openLink).not.toHaveBeenCalled();
  await send("open-external", "http://127.0.0.1:4317/follow?slug=decision-one");
  expect(openFollow).toHaveBeenCalledExactlyOnceWith({
    projectRoot: "/project",
    url: "http://127.0.0.1:4317/follow?slug=decision-one",
  });
  await send("open-link", "https://starkfuture.com/source");
  expect(openLink).toHaveBeenCalledExactlyOnceWith("https://starkfuture.com/source");
});

it("shows the empty state when a mirror stops and resets trust when it returns", async () => {
  await mount();
  await ready();
  findMirror.mockResolvedValue(null);
  await act(async () => {
    for (const check of intervals) check();
  });
  expect(renderer!.root.findAllByType("iframe")).toHaveLength(0);
  expect(
    renderer!.root
      .findAllByType("p")
      .flatMap((node) => node.children)
      .join(" "),
  ).toContain("No pages yet");
  findMirror.mockResolvedValue({ root: "/project", port: 4317 });
  await act(async () => {
    for (const check of intervals) check();
  });
  await message(request);
  expect(publish).not.toHaveBeenCalled();
  await ready();
  await message(request);
  expect(publish).toHaveBeenCalledTimes(1);
});

it("keeps publishing disabled for Codex even if the caller requests it", async () => {
  await mount();
  await act(async () => renderer!.update(<StarkPagesSidebar {...props()} agent="codex" />));
  await ready();
  expect(frameWindow.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ canPublish: false, agent: "codex" }),
    "http://127.0.0.1:4317",
  );
  await message(request);
  expect(publish).not.toHaveBeenCalled();
});

it("explains a missing handshake and retries with a fresh, untrusted frame", async () => {
  await mount();
  await act(async () => {
    for (const timeout of timeouts) timeout();
  });
  expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain(
    "did not connect",
  );
  const retry = renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Retry Pages"));
  await act(async () => retry!.props.onClick());
  expect(findMirror).toHaveBeenCalledTimes(2);
  expect(renderer!.root.findAllByProps({ role: "status" })).toHaveLength(0);
  await message(request);
  expect(publish).not.toHaveBeenCalled();
  await ready();
  await message(request);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(timeouts.size).toBe(0);
});

it("reports a failed browser open without an unhandled rejection", async () => {
  await mount();
  await ready();
  openLink.mockRejectedValue(new Error("Browser unavailable"));
  await message({ v: 1, source: "stark-pages", type: "open-link", url: "https://starkfuture.com" });
  expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain(
    "Could not open this link",
  );
});
