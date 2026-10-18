import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@starkfuture/contracts";
const state = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: { mcpServers: () => ({}) } }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ refresh: state.refresh }) }));
import { useMcpServersQuery } from "./useMcpServersQuery";
let renderer: ReactTestRenderer | undefined;
function Subscriber({ interval, thread = "thread" }: { interval: number; thread?: string }) {
  useMcpServersQuery(EnvironmentId.make("env"), { threadId: ThreadId.make(thread) }, interval);
  return null;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.refresh.mockReset();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("polls each target once at the fastest visible subscriber interval and cleans up", async () => {
  await act(() => {
    renderer = create(
      <>
        <Subscriber interval={10_000} />
        <Subscriber interval={10_000} />
        <Subscriber interval={2_000} />
      </>,
    );
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await act(() => {
    vi.advanceTimersByTime(4_000);
  });
  expect(state.refresh).toHaveBeenCalledTimes(3);
  await act(() =>
    renderer!.update(
      <>
        <Subscriber interval={10_000} />
        <Subscriber interval={10_000} />
      </>,
    ),
  );
  await act(() => {
    vi.advanceTimersByTime(9_999);
  });
  expect(state.refresh).toHaveBeenCalledTimes(3);
  await act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(state.refresh).toHaveBeenCalledTimes(4);
  await act(() => renderer!.unmount());
  renderer = undefined;
  await act(() => {
    vi.advanceTimersByTime(20_000);
  });
  expect(state.refresh).toHaveBeenCalledTimes(4);
});
