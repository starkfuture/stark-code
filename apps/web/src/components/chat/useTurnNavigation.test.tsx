import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useTurnNavigation } from "./useTurnNavigation";
import { toastManager } from "../ui/toast";
import type { TimelineMinimapItem } from "./timelineMinimapItems";
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
let renderer: ReactTestRenderer | undefined;
let navigation: ReturnType<typeof useTurnNavigation>;
const load = vi.fn();
const scroll = vi.fn();
const manual = vi.fn();
const recent = {
  id: "recent",
  entryId: "recent",
  rowIndex: 10,
  userText: "Recent",
  assistantText: null,
};
const indexed = {
  id: "old",
  entryId: "old",
  rowIndex: -1,
  userText: "Old",
  assistantText: "Old answer",
};
const RECENT_ITEMS = [recent];
function Probe({
  items = RECENT_ITEMS,
  cursor = "page-1",
  loading = false,
  threadKey = "a",
  error = null,
}: {
  items?: TimelineMinimapItem[];
  cursor?: string;
  loading?: boolean;
  threadKey?: string;
  error?: string | null;
}) {
  const state = useTurnNavigation({
    threadKey,
    items,
    historyCursor: cursor,
    onManualNavigation: manual,
    scrollToTurn: scroll,
    history: { hasMoreHistory: true, loading, error, onLoadEarlier: load },
  });
  useLayoutEffect(() => {
    navigation = state;
  });
  return null;
}
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("loads only the selected turn's intervening history and jumps after its row exists", async () => {
  await act(() => {
    renderer = create(<Probe />);
  });
  await act(() => navigation.selectItem(indexed));
  expect(load).toHaveBeenCalledExactlyOnceWith("old");
  expect(scroll).not.toHaveBeenCalled();
  await act(() => renderer!.update(<Probe loading />));
  await act(() => renderer!.update(<Probe />));
  expect(load).toHaveBeenCalledOnce();
  await act(() => renderer!.update(<Probe cursor="page-2" />));
  expect(load).toHaveBeenCalledTimes(2);
  await act(() =>
    renderer!.update(<Probe cursor="page-3" items={[{ ...indexed, rowIndex: 0 }, recent]} />),
  );
  expect(scroll).toHaveBeenCalledExactlyOnceWith(0, false);
  expect(navigation.pending).toBe(false);
  expect(manual).toHaveBeenCalledOnce();
});

it("cancels pending jumps and does not scroll another conversation after a switch or history failure", async () => {
  await act(() => {
    renderer = create(<Probe />);
  });
  await act(() => navigation.selectItem(indexed));
  await act(() => navigation.cancel());
  await act(() => renderer!.update(<Probe items={[{ ...indexed, rowIndex: 0 }, recent]} />));
  expect(scroll).not.toHaveBeenCalled();
  await act(() => renderer!.update(<Probe />));
  await act(() => navigation.selectItem(indexed));
  await act(() => renderer!.update(<Probe threadKey="b" items={[{ ...indexed, rowIndex: 0 }]} />));
  expect(scroll).not.toHaveBeenCalled();
  expect(navigation.pending).toBe(false);
  await act(() => renderer!.update(<Probe threadKey="b" />));
  await act(() => navigation.selectItem(indexed));
  await act(() => renderer!.update(<Probe threadKey="b" error="Connection lost" />));
  expect(navigation.pending).toBe(false);
  expect(toastManager.add).toHaveBeenCalledWith(
    expect.objectContaining({ description: "Connection lost" }),
  );
});
