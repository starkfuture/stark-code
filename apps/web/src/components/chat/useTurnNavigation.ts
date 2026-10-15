import { useCallback, useEffect, useRef, useState } from "react";
import { toastManager } from "../ui/toast";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import type { TimelineMinimapItem } from "./timelineMinimapItems";

/** Materializes an indexed turn through existing history pages before asking the list to jump. */
export function useTurnNavigation({
  threadKey,
  items,
  history,
  historyCursor,
  onManualNavigation,
  scrollToTurn,
}: {
  threadKey: string;
  items: ReadonlyArray<TimelineMinimapItem>;
  history?: MessagesTimelineHistoryControls | undefined;
  historyCursor?: string | null | undefined;
  onManualNavigation: () => void;
  scrollToTurn: (rowIndex: number, animated: boolean) => void;
}) {
  const [target, setTarget] = useState<{ key: string; entryId: string } | null>(null);
  const requestedPages = useRef(new Set<string>());
  const selectItem = useCallback(
    (item: TimelineMinimapItem, animated = true) => {
      onManualNavigation();
      requestedPages.current.clear();
      if (item.rowIndex < 0) {
        setTarget({ key: threadKey, entryId: item.entryId ?? item.id });
      } else {
        setTarget(null);
        scrollToTurn(item.rowIndex, animated);
      }
    },
    [threadKey, onManualNavigation, scrollToTurn],
  );
  useEffect(() => {
    if (!target) return;
    if (target.key !== threadKey) {
      setTarget(null);
      return;
    }
    const item = items.find((item) => (item.entryId ?? item.id) === target.entryId);
    if (item) {
      scrollToTurn(item.rowIndex, false);
      setTarget(null);
      return;
    }
    if (history?.loading) return;
    if (history?.error || !history?.hasMoreHistory) {
      setTarget(null);
      toastManager.add({
        type: "warning",
        title: "Could not open this turn",
        description: history?.error ?? "This turn is no longer available in the conversation.",
      });
      return;
    }
    const cursor = historyCursor ?? items[0]?.id ?? "first";
    if (requestedPages.current.has(cursor)) return;
    requestedPages.current.add(cursor);
    history.onLoadEarlier(target.entryId);
  }, [target, threadKey, items, history, historyCursor, scrollToTurn]);
  const cancel = useCallback(() => setTarget(null), []);
  return { selectItem, pending: target?.key === threadKey, cancel };
}
