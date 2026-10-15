import { useRef, useState } from "react";
import { ListIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import { resolveTimelineMinimapPreview, type TimelineMinimapItem } from "./timelineMinimapItems";

/** A keyboard and touch alternative when the conversation rail has no safe gutter. */
export function TimelineTurnOutline({
  items,
  currentId,
  history,
  onSelect,
  iconOnly = false,
}: {
  items: ReadonlyArray<TimelineMinimapItem>;
  currentId: string | null;
  history?: MessagesTimelineHistoryControls | undefined;
  onSelect: (item: TimelineMinimapItem) => void;
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={iconOnly ? "Conversation turns, earlier turns available" : undefined}
        render={<Button size={iconOnly ? "icon-xs" : "xs"} variant="ghost-muted" />}
      >
        <ListIcon aria-hidden="true" />
        {iconOnly ? null : "Turns"}
      </PopoverTrigger>
      <PopoverPopup
        aria-label="Conversation turns"
        side="bottom"
        align="start"
        width="lg"
        padding="compact"
        initialFocus={() => buttons.current.get(currentId ?? items[0]?.id ?? "") ?? true}
      >
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {items.length} {history?.hasMoreHistory ? "loaded turns" : "turns"}
          </p>
          {history?.hasMoreHistory ? (
            <Button
              size="xs"
              variant="outline"
              disabled={history.loading}
              onClick={() => history.onLoadEarlier()}
            >
              {history.loading ? "Loading earlier turns…" : "Load earlier turns"}
            </Button>
          ) : null}
          {history?.error ? <p role="status">{history.error}</p> : null}
          <ol
            className="max-h-[min(28rem,60vh)] space-y-1 overflow-y-auto"
            aria-label="Turns"
            onKeyDown={(event) => {
              const focusedIndex = items.findIndex(
                (item) => buttons.current.get(item.id) === event.target,
              );
              if (focusedIndex < 0) return;
              const nextIndex =
                event.key === "ArrowDown"
                  ? Math.min(items.length - 1, focusedIndex + 1)
                  : event.key === "ArrowUp"
                    ? Math.max(0, focusedIndex - 1)
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : null;
              if (nextIndex === null) return;
              event.preventDefault();
              const item = items[nextIndex];
              if (item) buttons.current.get(item.id)?.focus();
            }}
          >
            {items.map((item) => {
              const preview = resolveTimelineMinimapPreview(item)!;
              const current = currentId === item.id;
              return (
                <li key={item.id}>
                  <Button
                    variant="ghost"
                    size="sm-multiline"
                    className="w-full justify-start"
                    aria-current={current ? "step" : undefined}
                    ref={(button) => {
                      if (button) buttons.current.set(item.id, button);
                      else buttons.current.delete(item.id);
                    }}
                    onClick={() => {
                      onSelect(item);
                      setOpen(false);
                    }}
                  >
                    <span className="block min-w-0 flex-1 py-1 text-left">
                      {current ? (
                        <span className="block text-xs text-muted-foreground">Current turn</span>
                      ) : null}
                      <span className="line-clamp-2 break-words">
                        {preview.userText ?? "User message"}
                      </span>
                      {preview.assistantText ? (
                        <span className="mt-1 line-clamp-3 break-words text-xs font-normal text-muted-foreground">
                          {preview.assistantText}
                        </span>
                      ) : null}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ol>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
