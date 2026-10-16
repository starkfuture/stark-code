import { useState, type ComponentProps } from "react";
import { StarkPagesSidebar } from "./StarkPagesSidebar";
import { PublishedStarkPages } from "./PublishedStarkPages";
import { Button } from "./ui/button";
import { Sheet, SheetPopup, SheetTitle } from "./ui/sheet";
import { PreviewPanelShell } from "./preview/PreviewPanelShell";

/** Keep the mirror usable when a narrow workspace has no room for two columns. */
export function StarkPagesPanel({
  inline,
  ...props
}: ComponentProps<typeof StarkPagesSidebar> & { readonly inline: boolean }) {
  const [view, setView] = useState<"local" | "published">("local");
  const content = (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex shrink-0 flex-wrap gap-1 border-b border-border p-2"
        role="group"
        aria-label="Pages source"
      >
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
        {view === "published" ? (
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            Close
          </Button>
        ) : null}
      </div>
      {view === "local" ? <StarkPagesSidebar {...props} /> : <PublishedStarkPages />}
    </div>
  );
  if (inline) {
    return (
      <PreviewPanelShell
        mode="inline"
        widthStorageKey="starkcode:pages-panel-width"
        defaultWidth={540}
      >
        {content}
      </PreviewPanelShell>
    );
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <SheetPopup side="right" layer="dialog" showCloseButton={false} aria-describedby={undefined}>
        <div className="sr-only">
          <SheetTitle>Stark Pages</SheetTitle>
        </div>
        {content}
      </SheetPopup>
    </Sheet>
  );
}
