import type {
  PilotEngine,
  PilotMessage,
  PilotNudgeAction,
  PilotQuote,
  TimestampFormat,
} from "@starkfuture/contracts";
import { CheckIcon, ChevronRightIcon, CircleAlertIcon, ThumbsDownIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ENGINE_LABELS,
  NUDGE_KIND_LABELS,
  newestOpenNudgeId,
  nudgeOutcome,
  pendingQuestionShown,
  quoteNamesSession,
  quoteSource,
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

const keyOf = (quote: PilotQuote) => `${quote.source}:${quote.where}:${quote.quote}`;

/** A quiet "·" between parts of one meta line. */
function Dot() {
  return (
    <span aria-hidden className="shrink-0">
      ·
    </span>
  );
}

/** How long ago, on one line, with the exact time on hover. */
function Time({ at, timestampFormat }: { at: string; timestampFormat: TimestampFormat }) {
  const label = formatRelativeTimeLabel(at);
  if (!label) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<time dateTime={at} className="shrink-0 whitespace-nowrap tabular-nums" />}
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="top" positionMethod="fixed">
        {formatShortTimestamp(at, timestampFormat)}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * One quiet line under a quote: who said it, where (shortened, full text on
 * hover) and how long ago. Only a quote Pilot could not find says so.
 */
function SourceLine({ quote }: { quote: PilotQuote }) {
  const { who, place, time } = quoteSource(quote);
  return (
    <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      {who ? (
        <>
          <span className="shrink-0">{who}</span>
          {place ? <Dot /> : null}
        </>
      ) : null}
      {place ? (
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate" />}>{place}</TooltipTrigger>
          <TooltipPopup side="top" positionMethod="fixed">
            {quote.where}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {time ? (
        <>
          <Dot />
          <span className="shrink-0 whitespace-nowrap tabular-nums">{time}</span>
        </>
      ) : null}
      {quote.found ? (
        <span className="sr-only">, quote found</span>
      ) : (
        <span className="ml-1 inline-flex shrink-0 items-center gap-1 text-warning-foreground">
          <CircleAlertIcon aria-hidden className="size-3" />
          Not found
        </span>
      )}
    </p>
  );
}

function QuoteItem({ quote }: { quote: PilotQuote }) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <blockquote className="border-l-2 border-border pl-2 text-xs whitespace-pre-wrap break-words text-foreground/80">
        {quote.quote}
      </blockquote>
      <div className="pl-2.5">
        <SourceLine quote={quote} />
      </div>
    </li>
  );
}

/** A toggle for sources kept out of sight, with how many could not be found. */
function SourcesToggle({
  open,
  label,
  missing,
  onToggle,
}: {
  open: boolean;
  label: string;
  missing: number;
  onToggle: () => void;
}) {
  return (
    <Button size="micro" variant="quiet" aria-expanded={open} onClick={onToggle}>
      <ChevronRightIcon aria-hidden className={cn("transition-transform", open && "rotate-90")} />
      {label}
      {missing > 0 ? <span className="text-warning-foreground">· {missing} not found</span> : null}
    </Button>
  );
}

/** A nudge's first quote, with any others behind "+N sources". */
function NudgeQuotes({ evidence }: { evidence: readonly PilotQuote[] }) {
  const [open, setOpen] = useState(false);
  const [first, ...rest] = evidence;
  if (!first) return null;
  const missing = rest.filter((quote) => !quote.found).length;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <ul className="flex flex-col gap-2" aria-label="Sources">
        <QuoteItem quote={first} />
        {open
          ? withKeys(rest, keyOf).map(({ key, item }) => <QuoteItem key={key} quote={item} />)
          : null}
      </ul>
      {rest.length > 0 ? (
        <div>
          <SourcesToggle
            open={open}
            label={
              open ? "Fewer sources" : `+${rest.length} ${rest.length === 1 ? "source" : "sources"}`
            }
            missing={open ? 0 : missing}
            onToggle={() => setOpen((value) => !value)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The engine, only when it is not the one Pilot uses by default. */
function engineTag(message: PilotMessage, defaultEngine: PilotEngine): string | null {
  return message.engine && message.engine !== defaultEngine ? ENGINE_LABELS[message.engine] : null;
}

function NudgeCard({
  message,
  unseen,
  pinned,
  defaultEngine,
  busy,
  error,
  timestampFormat,
  onAct,
}: {
  message: PilotMessage;
  /** Not seen by the person yet; marked seen once it is on screen. */
  unseen: boolean;
  /** The newest open nudge keeps its actions in view; others show them on hover or focus. */
  pinned: boolean;
  defaultEngine: PilotEngine;
  busy: PilotNudgeAction | null;
  error: string | null;
  timestampFormat: TimestampFormat;
  onAct: PilotNudgeAct;
}) {
  const kind = message.nudgeKind;
  const risky = kind === "risky";
  const outcome = nudgeOutcome(message.state);
  const engine = engineTag(message, defaultEngine);
  const session = quoteNamesSession(message) ? null : message.sessionLabel;
  const iconAction = (name: PilotNudgeAction, label: string, icon: ReactNode) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            disabled={busy !== null}
            onClick={() => onAct(message, name)}
          />
        }
      >
        {busy === name ? <Spinner aria-hidden /> : icon}
      </TooltipTrigger>
      <TooltipPopup side="top" positionMethod="fixed">
        {label}
      </TooltipPopup>
    </Tooltip>
  );
  const actions = outcome ? null : (
    <div
      data-pilot-actions={pinned ? "pinned" : "hover"}
      className={cn(
        "flex items-center gap-0.5",
        !pinned &&
          "pointer-events-none absolute top-1.5 right-1.5 rounded-md bg-background p-0.5 opacity-0 shadow-xs ring-1 ring-border group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
      )}
    >
      {message.session ? (
        <Button
          size="xs"
          variant={pinned ? "outline" : "ghost"}
          disabled={busy !== null}
          onClick={() => onAct(message, "send")}
        >
          {busy === "send" ? <Spinner aria-hidden /> : null}
          Send to session
        </Button>
      ) : null}
      {iconAction("useful", "Got it", <CheckIcon aria-hidden />)}
      {iconAction("not_useful", "Not useful", <ThumbsDownIcon aria-hidden />)}
    </div>
  );
  return (
    <article
      aria-label={kind ? NUDGE_KIND_LABELS[kind] : "Pilot"}
      data-unseen-nudge={unseen ? message.id : undefined}
      className="group relative flex min-w-0 flex-col gap-2 rounded-lg bg-muted/40 px-3 py-2.5"
    >
      <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        {kind ? (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5",
              risky && "font-medium text-destructive-foreground",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                risky ? "bg-destructive" : "bg-muted-foreground/60",
              )}
            />
            {NUDGE_KIND_LABELS[kind]}
          </span>
        ) : null}
        {session ? (
          <>
            <Dot />
            <Tooltip>
              <TooltipTrigger render={<span className="min-w-0 truncate" />}>
                {session}
              </TooltipTrigger>
              <TooltipPopup side="top" positionMethod="fixed">
                {session}
              </TooltipPopup>
            </Tooltip>
          </>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          {engine ? (
            <>
              <span data-pilot-engine={message.engine}>{engine}</span>
              <Dot />
            </>
          ) : null}
          <Time at={message.at} timestampFormat={timestampFormat} />
        </span>
      </p>
      <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
      <NudgeQuotes evidence={message.evidence} />
      {outcome ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <CheckIcon aria-hidden className="size-3" />
          {outcome}
        </p>
      ) : (
        actions
      )}
      {error ? (
        <p role="alert" className="text-xs break-words text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </article>
  );
}

/** Pilot's answer as plain prose, its sources folded under one toggle. */
function Answer({
  message,
  defaultEngine,
  timestampFormat,
}: {
  message: PilotMessage;
  defaultEngine: PilotEngine;
  timestampFormat: TimestampFormat;
}) {
  const [open, setOpen] = useState(false);
  const engine = engineTag(message, defaultEngine);
  const missing = message.evidence.filter((quote) => !quote.found).length;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
        {message.evidence.length > 0 ? (
          <SourcesToggle
            open={open}
            label={`Sources (${message.evidence.length})`}
            missing={missing}
            onToggle={() => setOpen((value) => !value)}
          />
        ) : null}
        <span className="flex shrink-0 items-center gap-1">
          {message.evidence.length > 0 ? <Dot /> : null}
          {engine ? (
            <>
              <span data-pilot-engine={message.engine}>{engine}</span>
              <Dot />
            </>
          ) : null}
          <Time at={message.at} timestampFormat={timestampFormat} />
        </span>
      </div>
      {open ? (
        <ul className="flex flex-col gap-2 pt-1" aria-label="Sources">
          {withKeys(message.evidence, keyOf).map(({ key, item }) => (
            <QuoteItem key={key} quote={item} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The person's own message: a small bubble on the right. */
function YourMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-2xl bg-message px-3 py-1.5 text-sm whitespace-pre-wrap break-words text-message-foreground">
        {text}
      </p>
    </div>
  );
}

function MessageRow({
  message,
  defaultEngine,
  timestampFormat,
}: {
  message: PilotMessage;
  defaultEngine: PilotEngine;
  timestampFormat: TimestampFormat;
}) {
  if (message.role === "you") return <YourMessage text={message.text} />;
  if (message.kind === "note") {
    return (
      <p className="px-2 text-center text-xs break-words text-muted-foreground">{message.text}</p>
    );
  }
  return (
    <Answer message={message} defaultEngine={defaultEngine} timestampFormat={timestampFormat} />
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
  defaultEngine,
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
  /** Messages written by this engine carry no engine tag. */
  defaultEngine: PilotEngine;
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

  const pinnedId = newestOpenNudgeId(messages);
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
          <ol className="flex min-w-0 flex-col gap-4 p-3" aria-label="Pilot conversation">
            {messages.map((message) => (
              <li key={message.id} className="min-w-0">
                {message.kind === "nudge" && message.role !== "you" ? (
                  <NudgeCard
                    message={message}
                    unseen={isUnseen(message)}
                    pinned={message.id === pinnedId}
                    defaultEngine={defaultEngine}
                    busy={busy.get(message.id) ?? null}
                    error={errors.get(message.id) ?? null}
                    timestampFormat={timestampFormat}
                    onAct={onAct}
                  />
                ) : (
                  <MessageRow
                    message={message}
                    defaultEngine={defaultEngine}
                    timestampFormat={timestampFormat}
                  />
                )}
              </li>
            ))}
            {pending && showPending ? (
              <li>
                <YourMessage text={pending.text} />
              </li>
            ) : null}
            {pending ? (
              <li className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                <Spinner size="xs" aria-hidden />
                <span>Pilot is thinking…</span>
                <Button size="micro" variant="quiet" onClick={onCancelAsk}>
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
