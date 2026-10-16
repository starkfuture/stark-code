import { useState } from "react";
import type { ServerProvider } from "@starkfuture/contracts";
import type { TimestampFormat } from "@starkfuture/contracts/settings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatShortTimestamp } from "../../timestampFormat";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";
import { formatComposerUsagePercent, selectComposerUsage } from "./ComposerUsageRing.logic";

const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });

export function ComposerUsageRing({
  provider,
  connected,
  size = "sm",
  timestampFormat = "locale",
}: {
  provider: ServerProvider | null;
  connected: boolean;
  size?: ComposerControlSize;
  timestampFormat?: TimestampFormat;
}) {
  const nowMinute = useNowMinute();
  const usage = selectComposerUsage(provider, connected, Date.parse(`${nowMinute}:00Z`));
  const [open, setOpen] = useState(false);
  if (!usage) return null;
  const percent = usage.window?.usedPercent;
  const title =
    percent !== undefined
      ? `${usage.label}: ${formatComposerUsagePercent(percent)} used`
      : "Subscription usage unavailable";
  const reset = usage.window?.resetsAt;
  const details = (
    <div className="space-y-1 text-sm">
      <p>{title}</p>
      {reset ? (
        <p className="text-muted-foreground">
          Resets {weekdayFormatter.format(new Date(reset))}{" "}
          {formatShortTimestamp(reset, timestampFormat)}
        </p>
      ) : usage.window ? (
        <p className="text-muted-foreground">Reset time not reported.</p>
      ) : null}
      {usage.message ? <p className="text-muted-foreground">{usage.message}</p> : null}
      <p className="text-xs text-muted-foreground">Selected profile: {usage.profile}</p>
    </div>
  );
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const color =
    percent !== undefined && percent >= 95
      ? "var(--color-error)"
      : percent !== undefined && percent >= 80
        ? "var(--color-warning)"
        : "var(--color-primary)";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <ComposerControl
                  size={size}
                  data-composer-usage-ring="true"
                  aria-label={`${title}. Selected profile: ${usage.profile}`}
                />
              }
            />
          }
        >
          <span className="relative flex size-5 items-center justify-center">
            <svg className="size-5 -rotate-90" viewBox="0 0 20 20" aria-hidden="true">
              <circle
                cx="10"
                cy="10"
                r={radius}
                fill="none"
                strokeWidth="2.5"
                className="stroke-muted-foreground/30"
              />
              {percent !== undefined && percent > 0 ? (
                <circle
                  cx="10"
                  cy="10"
                  r={radius}
                  fill="none"
                  stroke={color}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference * (1 - percent / 100)}
                />
              ) : null}
            </svg>
            {percent === undefined ? (
              <span aria-hidden="true" className="absolute text-xs text-muted-foreground">
                –
              </span>
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipPopup {...composerFloatingLayerProps} side="top" align="end">
          {details}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup
        {...composerFloatingLayerProps}
        width="sm"
        padding="compact"
        side="top"
        align="end"
        aria-label="Subscription usage"
      >
        {details}
      </PopoverPopup>
    </Popover>
  );
}
