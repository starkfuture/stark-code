import type {
  PilotEngine,
  PilotMessage,
  PilotNudgeAction,
  PilotQuote,
  TimestampFormat,
} from "@starkfuture/contracts";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { observeResize } from "~/lib/observeResize";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ENGINE_LABELS,
  NUDGE_KIND_BADGES,
  NUDGE_KIND_LABELS,
  nudgeOutcome,
  pendingQuestionShown,
  quoteSourceLabel,
  withKeys,
} from "./pilot.logic";

/** The question waiting for Pilot's answer, shown until the thread has it. */
export interface PilotPendingQuestion {
  readonly text: string;
  /** The newest message id when it was asked; Pilot stores the question after it. */
  readonly afterId: number | null;
  /** The engine asked for, when it was not the default. */
  readonly engine?: PilotEngine | null;
}

export type PilotNudgeAct = (message: PilotMessage, action: PilotNudgeAction) => void;

const NEAR_BOTTOM_PX = 48;

/** A file source shows its full path on hover; session sources already read in full. */
function SourceLabel({ quote }: { quote: PilotQuote }) {
  const label = quoteSourceLabel(quote);
  if ((quote.source !== "rule" && quote.source !== "memory") || label === quote.where)
    return <span className="min-w-0 break-words">{label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="min-w-0 break-words" />}>{label}</TooltipTrigger>
      <TooltipPopup side="top" positionMethod="fixed">
        {quote.where}
      </TooltipPopup>
    </Tooltip>
  );
}

function Quotes({ evidence }: { evidence: readonly PilotQuote[] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Quotes">
      {withKeys(evidence, (quote) => `${quote.source}:${quote.where}`).map(({ key, item }) => (
        <li key={key} className="flex min-w-0 flex-col gap-1">
          <blockquote className="border-l-2 border-border pl-2 text-xs whitespace-pre-wrap break-words">
            {item.quote}
          </blockquote>
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-2.5 text-xs text-muted-foreground">
            <SourceLabel quote={item} />
            {item.found ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-success-foreground">
                <CheckIcon aria-hidden className="size-3" />
                Quote found
              </span>
            ) : (
              <span className="inline-flex shrink-0 items-center gap-1 text-warning-foreground">
                <CircleAlertIcon aria-hidden className="size-3" />
                Not found
              </span>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Time({ at, timestampFormat }: { at: string; timestampFormat: TimestampFormat }) {
  const label = formatRelativeTimeLabel(at);
  if (!label) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time dateTime={at} className="shrink-0 text-xs tabular-nums text-muted-foreground" />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="top" positionMethod="fixed">
        {formatShortTimestamp(at, timestampFormat)}
      </TooltipPopup>
    </Tooltip>
  );
}

function NudgeCard({
  message,
  unseen,
  busy,
  error,
  timestampFormat,
  onAct,
}: {
  message: PilotMessage;
  /** Not seen by the person yet; marked seen once it is on screen. */
  unseen: boolean;
  busy: PilotNudgeAction | null;
  error: string | null;
  timestampFormat: TimestampFormat;
  onAct: PilotNudgeAct;
}) {
  const kind = message.nudgeKind;
  const outcome = nudgeOutcome(message.state);
  const action = (name: PilotNudgeAction, label: string, variant: "outline" | "ghost") => (
    <Button
      size="xs"
      variant={variant}
      disabled={busy !== null}
      onClick={() => onAct(message, name)}
    >
      {busy === name ? <Spinner aria-hidden /> : null}
      {label}
    </Button>
  );
  return (
    <article
      aria-label={kind ? NUDGE_KIND_LABELS[kind] : "Pilot"}
      data-unseen-nudge={unseen ? message.id : undefined}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        {kind ? (
          <Badge size="sm" variant={NUDGE_KIND_BADGES[kind]}>
            {NUDGE_KIND_LABELS[kind]}
          </Badge>
        ) : (
          <span />
        )}
        <Byline message={message} timestampFormat={timestampFormat} />
      </div>
      <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
      <Quotes evidence={message.evidence} />
      {message.sessionLabel ? (
        <p className="text-xs break-words text-muted-foreground">In {message.sessionLabel}</p>
      ) : null}
      {outcome ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <CheckIcon aria-hidden className="size-3" />
          {outcome}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          {message.session ? action("send", "Send to session", "outline") : null}
          {action("useful", "Got it", "ghost")}
          {action("not_useful", "Not useful", "ghost")}
        </div>
      )}
      {error ? (
        <p role="alert" className="text-xs break-words text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </article>
  );
}

/** The engine that wrote a Pilot message, then how long ago, both muted. */
function Byline({
  message,
  timestampFormat,
}: {
  message: PilotMessage;
  timestampFormat: TimestampFormat;
}) {
  const engine = message.engine ? ENGINE_LABELS[message.engine] : null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      {engine ? <span data-pilot-engine={message.engine}>{engine}</span> : null}
      {engine && formatRelativeTimeLabel(message.at) ? <span aria-hidden>·</span> : null}
      <Time at={message.at} timestampFormat={timestampFormat} />
    </span>
  );
}

function MessageRow({
  message,
  timestampFormat,
}: {
  message: PilotMessage;
  timestampFormat: TimestampFormat;
}) {
  if (message.role === "you") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-xl bg-message px-3 py-2 text-sm whitespace-pre-wrap break-words text-message-foreground">
          {message.text}
        </p>
      </div>
    );
  }
  if (message.kind === "note") {
    return (
      <p className="px-2 text-center text-xs break-words text-muted-foreground">{message.text}</p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
      <Quotes evidence={message.evidence} />
      <Byline message={message} timestampFormat={timestampFormat} />
    </div>
  );
}

/**
 * The Pilot thread, newest at the bottom. It follows new messages while the
 * person is at the bottom, and reports nudges the person has not seen once
 * they are on screen.
 */
export function PilotThread({
  messages,
  pending,
  askError,
  active,
  timestampFormat,
  busy,
  errors,
  empty,
  sentMayBeUnseen,
  onAct,
  onCancelAsk,
  onSeen,
}: {
  messages: readonly PilotMessage[];
  pending: PilotPendingQuestion | null;
  askError: string | null;
  active: boolean;
  timestampFormat: TimestampFormat;
  /** The action running for each nudge id. */
  busy: ReadonlyMap<number, PilotNudgeAction>;
  errors: ReadonlyMap<number, string>;
  empty: ReactNode;
  /**
   * Pilot sends some reminders to their session on its own; they stay unread
   * until the person sees them, but the message does not say whether they did.
   */
  sentMayBeUnseen: boolean;
  onAct: PilotNudgeAct;
  onCancelAsk: () => void;
  onSeen: (ids: readonly number[]) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const showPending = pending !== null && pendingQuestionShown(messages, pending);
  const documentVisible = useDocumentVisible();

  // Follow the bottom as the thread grows, the panel opens or the composer grows, unless the
  // person scrolled up.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !content.current) return;
    return observeResize([content.current, element], () => {
      if (followBottom.current) element.scrollTop = element.scrollHeight;
    });
  }, []);
  useLayoutEffect(() => {
    // A question just asked is always shown.
    if (pending) followBottom.current = true;
  }, [pending]);

  const isUnseen = (message: PilotMessage) =>
    message.kind === "nudge" &&
    (message.state === "new" || (sentMayBeUnseen && message.state === "sent"));
  const unseen = messages
    .filter(isUnseen)
    .map((message) => message.id)
    .join(",");
  const onSeenRef = useRef(onSeen);
  useLayoutEffect(() => {
    onSeenRef.current = onSeen;
  });
  useEffect(() => {
    const root = viewport.current;
    if (!root || !active || !documentVisible || !unseen) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (document.visibilityState !== "visible") return;
        const ids = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => Number(entry.target.getAttribute("data-unseen-nudge")))
          .filter((id) => Number.isInteger(id) && id > 0);
        if (ids.length > 0) onSeenRef.current(ids);
      },
      { root, threshold: 0.5 },
    );
    for (const element of root.querySelectorAll("[data-unseen-nudge]")) observer.observe(element);
    return () => observer.disconnect();
  }, [active, documentVisible, unseen]);

  return (
    <div
      ref={viewport}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      onScroll={(event) => {
        const element = event.currentTarget;
        followBottom.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
      }}
    >
      <div ref={content}>
        {messages.length === 0 && !pending ? (
          empty
        ) : (
          <ol className="flex min-w-0 flex-col gap-3 p-3" aria-label="Pilot conversation">
            {messages.map((message) => (
              <li key={message.id} className="min-w-0">
                {message.kind === "nudge" && message.role !== "you" ? (
                  <NudgeCard
                    message={message}
                    unseen={isUnseen(message)}
                    busy={busy.get(message.id) ?? null}
                    error={errors.get(message.id) ?? null}
                    timestampFormat={timestampFormat}
                    onAct={onAct}
                  />
                ) : (
                  <MessageRow message={message} timestampFormat={timestampFormat} />
                )}
              </li>
            ))}
            {pending && showPending ? (
              <li className="flex justify-end">
                <p className="max-w-[85%] rounded-xl bg-message px-3 py-2 text-sm whitespace-pre-wrap break-words text-message-foreground">
                  {pending.text}
                </p>
              </li>
            ) : null}
            {pending ? (
              <li className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                <Spinner size="xs" aria-hidden />
                <span>Pilot is thinking…</span>
                <Button size="xs" variant="ghost" onClick={onCancelAsk}>
                  Cancel
                </Button>
              </li>
            ) : askError ? (
              <li role="alert" className="text-xs break-words text-destructive-foreground">
                {askError}
              </li>
            ) : null}
          </ol>
        )}
      </div>
    </div>
  );
}

/** Whether this window is on screen; nudges count as seen only while it is. */
function useDocumentVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}
