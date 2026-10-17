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
    usage.windows.length > 0
      ? usage.windows
          .map((entry) =>
            entry.window
              ? `${entry.label}: ${formatComposerUsagePercent(entry.window.usedPercent)} used`
              : `${entry.label}: unavailable`,
          )
          .join(". ")
      : "Subscription usage unavailable";
  const details = (
    <div className="space-y-3 text-sm">
      {usage.windows.length > 0 ? (
        usage.windows.map((entry) => {
          const reset = entry.window?.resetsAt;
          return (
            <div key={entry.id} className="space-y-1">
              <p>
                {entry.label}:{" "}
                {entry.window
                  ? `${formatComposerUsagePercent(entry.window.usedPercent)} used`
                  : "Not reported"}
              </p>
              {entry.window ? (
                <p className="text-muted-foreground">
                  {reset && Number.isFinite(Date.parse(reset)) ? (
                    <>
                      Resets {weekdayFormatter.format(new Date(reset))}{" "}
                      {formatShortTimestamp(reset, timestampFormat)}
                    </>
                  ) : (
                    "Reset time not reported."
                  )}
                </p>
              ) : entry.message !== "Not reported." ? (
                <p className="text-muted-foreground">{entry.message}</p>
              ) : null}
            </div>
          );
        })
      ) : (
        <>
          <p>{title}</p>
          {usage.message ? <p className="text-muted-foreground">{usage.message}</p> : null}
        </>
      )}
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
