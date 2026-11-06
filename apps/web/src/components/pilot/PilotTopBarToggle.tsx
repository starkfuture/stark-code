import { ScanEyeIcon } from "lucide-react";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usePilotIndicator } from "./pilotStore";

/**
 * Pilot's window-level button beside Tools: it opens and closes the Pilot
 * chat, and a dot marks nudges the person has not seen. Hidden until Pilot
 * is installed; Tools → Pilot still explains how to install it.
 */
export function PilotTopBarToggle({
  open,
  onToggle,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const installed = usePilotIndicator((state) => state.installed);
  const unread = usePilotIndicator((state) => state.unread);
  if (installed !== true && !open) return null;
  const hasUnread = unread > 0;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={open}
            onPressedChange={onToggle}
            aria-label={
              hasUnread ? `Pilot, ${unread} unread ${unread === 1 ? "nudge" : "nudges"}` : "Pilot"
            }
            variant="ghost"
            size="sm"
            data-pilot-unread={hasUnread ? unread : undefined}
          >
            <span className="relative grid size-4 place-items-center">
              <ScanEyeIcon className="size-4" />
              {hasUnread ? (
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-current ring-2 ring-background"
                />
              ) : null}
            </span>
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">Pilot</TooltipPopup>
    </Tooltip>
  );
}
