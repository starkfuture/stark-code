import type { ComponentProps } from "react";
import { StarkPagesSidebar } from "./StarkPagesSidebar";
import { Sheet, SheetPopup, SheetTitle } from "./ui/sheet";

/** Keep the mirror usable when a narrow workspace has no room for two columns. */
export function StarkPagesPanel({
  inline,
  ...props
}: ComponentProps<typeof StarkPagesSidebar> & { readonly inline: boolean }) {
  if (inline) {
    return (
      <div className="min-h-0 w-96 shrink-0">
        <StarkPagesSidebar {...props} />
      </div>
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
        <StarkPagesSidebar {...props} />
      </SheetPopup>
    </Sheet>
  );
}
