import { Dialog } from "@base-ui/react/dialog";
import { Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { usePreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { cn } from "~/lib/utils";
import { isElectron } from "~/env";
import { StarkPagesSidebar } from "./StarkPagesSidebar";
import { PublishedStarkPages } from "./PublishedStarkPages";
import { Button } from "./ui/button";
import { RightPanelResizeHandle } from "./preview/RightPanelResizeHandle";

/** One mounted viewer survives docking, expansion and window-size changes. */
export function StarkPagesPanel({
  inline,
  ...props
}: ComponentProps<typeof StarkPagesSidebar> & { readonly inline: boolean }) {
  const [view, setView] = useState<"local" | "published">("local");
  const [expanded, setExpanded] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const overlay = expanded || !inline;
  const { width, handlers } = usePreviewPanelInlineSize(panel, {
    enabled: !overlay,
    container: portalHost?.parentElement,
    widthStorageKey: "starkcode:pages-panel-width",
    defaultWidth: 540,
  });
  useLayoutEffect(() => {
    if (overlay && portalHost && panel.current && !panel.current.contains(document.activeElement)) {
      expandButton.current?.focus({ preventScroll: true });
    }
  }, [overlay, portalHost]);
  const restorePanel = () => {
    setExpanded(false);
    expandButton.current?.focus({ preventScroll: true });
  };

  return (
    <Dialog.Root
      open
      modal={overlay}
      disablePointerDismissal={!overlay}
      onOpenChange={(open, details) => {
        if (open) return;
        // Escape restores the reading panel before a second Escape closes it.
        if (expanded) restorePanel();
        else if (overlay || details.reason === "escape-key") props.onClose();
      }}
    >
      {/* Keeping the portal's container fixed avoids reloading the iframe when
          it becomes a modal. display:contents keeps the dock in the flex row. */}
      <div ref={setPortalHost} className="contents" />
      {portalHost ? (
        <Dialog.Portal container={portalHost} className="contents">
          {overlay ? (
            <Dialog.Backdrop className="fixed inset-0 z-[60] bg-background/60 backdrop-blur-xs" />
          ) : null}
          <Dialog.Popup
            ref={panel}
            role={overlay ? "dialog" : "complementary"}
            aria-label="Stark Pages"
            aria-modal={overlay || undefined}
            initialFocus={false}
            data-pages-overlay={overlay ? "true" : undefined}
            data-pages-expanded={expanded ? "true" : "false"}
            className={cn(
              "flex min-h-0 min-w-0 flex-col bg-background text-foreground outline-none [-webkit-app-region:no-drag]",
              overlay
                ? "fixed inset-y-0 right-0 z-[60]"
                : "relative h-full shrink-0 border-l border-border",
              overlay && !expanded && isElectron && "top-(--workspace-topbar-height)",
              overlay &&
                (expanded
                  ? "left-0"
                  : "w-[min(540px,calc(100%-2rem))] border-l border-border shadow-lg"),
            )}
            style={overlay ? undefined : { width }}
          >
            {!overlay ? <RightPanelResizeHandle handlers={handlers} /> : null}
            <div
              className={cn(
                "flex shrink-0 flex-wrap items-center justify-between gap-1 border-b border-border p-2",
                expanded &&
                  isElectron &&
                  "drag-region min-h-(--workspace-topbar-height) pl-(--workspace-controls-left) wco:pr-(--workspace-native-controls-inset)",
              )}
            >
              <div className="flex flex-wrap gap-1" role="group" aria-label="Pages source">
                <Button
                  size="sm"
                  variant={view === "local" ? "secondary" : "ghost"}
                  aria-pressed={view === "local"}
                  onClick={() => setView("local")}
                >
                  This workspace
                </Button>
                <Button
                  size="sm"
                  variant={view === "published" ? "secondary" : "ghost"}
                  aria-pressed={view === "published"}
                  onClick={() => setView("published")}
                >
                  Published
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  ref={expandButton}
                  size="sm"
                  variant="ghost"
                  aria-label={expanded ? "Return Pages to side panel" : "Expand Pages"}
                  title={expanded ? "Return to side panel (Esc)" : "Expand Pages"}
                  onClick={() => (expanded ? restorePanel() : setExpanded(true))}
                >
                  {expanded ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
                  {expanded ? "Side panel" : "Full view"}
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Close Pages"
                  onClick={props.onClose}
                >
                  <XIcon aria-hidden />
                </Button>
              </div>
            </div>
            {view === "local" ? (
              <StarkPagesSidebar {...props} showHeader={false} />
            ) : (
              <PublishedStarkPages expanded={expanded} onExitExpanded={restorePanel} />
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  );
}
