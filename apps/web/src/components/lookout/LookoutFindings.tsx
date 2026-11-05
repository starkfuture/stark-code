import type { LookoutDecideAction, LookoutFinding, TimestampFormat } from "@starkfuture/contracts";
import { ChevronRightIcon, MessageSquareQuoteIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { formatShortTimestamp } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import {
  DECISION_COPY,
  EVIDENCE_CHECK_LABELS,
  evidenceLocation,
  findingStatusLabel,
  isFindingOpen,
  severityBadge,
  speechLine,
  withKeys,
  type LookoutReasonAction,
} from "./lookout.logic";

export type LookoutDecide = (input: {
  readonly ref: string;
  readonly action: LookoutDecideAction;
  readonly note?: string;
}) => Promise<boolean>;

const CHECK_BADGE = { verified: "success", failed: "error", unverifiable: "secondary" } as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
}

/** Accept, dismiss and defer ask for a short reason inline: Lookout shows it to later reviews. */
function DecisionForm({
  action,
  busy,
  onCancel,
  onSubmit,
}: {
  action: LookoutReasonAction;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const copy = DECISION_COPY[action];
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (note.trim()) onSubmit(note.trim());
      }}
    >
      <Textarea
        size="sm"
        aria-label={`Reason to ${action}`}
        placeholder={copy.placeholder}
        value={note}
        maxLength={2000}
        autoFocus
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="flex items-center justify-end gap-1">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="xs" variant="outline" disabled={busy || !note.trim()}>
          {busy ? <Spinner aria-hidden /> : null}
          {copy.label}
        </Button>
      </div>
    </form>
  );
}

function FindingRow({
  finding,
  inThisFolder,
  timestampFormat,
  busy,
  onDecide,
  onQuote,
}: {
  finding: LookoutFinding;
  inThisFolder: boolean;
  timestampFormat: TimestampFormat;
  busy: boolean;
  onDecide: LookoutDecide;
  onQuote?: ((text: string, label: string) => boolean) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [reasonFor, setReasonFor] = useState<LookoutReasonAction | null>(null);
  const severity = severityBadge(finding.severity);
  const speech = speechLine(finding, (iso) => formatShortTimestamp(iso, timestampFormat));
  const stillOpen = isFindingOpen(finding);
  const decide = async (action: LookoutDecideAction, note?: string) => {
    const done = await onDecide({ ref: finding.ref, action, ...(note ? { note } : {}) });
    if (done) setReasonFor(null);
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        aria-label={`${severity.label}: ${finding.title}`}
        className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex shrink-0 pt-0.5">
          <Badge size="sm" variant={severity.variant}>
            {severity.label}
          </Badge>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium leading-snug">{finding.title}</span>
          <span className="text-xs text-muted-foreground">
            {finding.ref}
            {inThisFolder ? " · this folder" : ""}
            {finding.status !== "open" ? ` · ${findingStatusLabel(finding.status)}` : ""}
          </span>
          {speech ? <span className="text-xs text-muted-foreground">{speech}</span> : null}
        </span>
        <ChevronRightIcon
          aria-hidden
          className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground", open && "rotate-90")}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col gap-3 px-2 pt-1 pb-3 text-sm">
          <p>{finding.statement}</p>
          {finding.failureCase ? (
            <Section title="What goes wrong">
              <p>{finding.failureCase}</p>
            </Section>
          ) : null}
          <Section title="Why it matters">
            <p>{finding.whyItMatters}</p>
          </Section>
          {finding.evidence.length > 0 ? (
            <Section title="Evidence">
              <ul className="flex flex-col gap-2">
                {withKeys(finding.evidence, (e) => `${e.type}:${evidenceLocation(e)}`).map(
                  ({ key, item }) => {
                    const location = evidenceLocation(item);
                    return (
                      <li key={key} className="flex flex-col gap-1">
                        <span className="flex min-w-0 items-center gap-2">
                          {location ? (
                            <span className="flex min-w-0 flex-1 font-mono text-xs">
                              <MiddleTruncate value={location} className="min-w-0 flex-1" />
                            </span>
                          ) : (
                            <span className="flex-1 text-xs text-muted-foreground">
                              Session event
                            </span>
                          )}
                          {item.check ? (
                            <Badge size="sm" variant={CHECK_BADGE[item.check]}>
                              {EVIDENCE_CHECK_LABELS[item.check]}
                            </Badge>
                          ) : null}
                        </span>
                        {item.quote || item.outputExcerpt ? (
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
                            {item.quote ?? item.outputExcerpt}
                          </pre>
                        ) : null}
                      </li>
                    );
                  },
                )}
              </ul>
            </Section>
          ) : null}
          {finding.nextAction ? (
            <Section title="Next step">
              <p>{finding.nextAction}</p>
            </Section>
          ) : null}
          {finding.decisionNote && !stillOpen ? (
            <Section title="Your note">
              <p>{finding.decisionNote}</p>
            </Section>
          ) : null}
          {reasonFor ? (
            <DecisionForm
              action={reasonFor}
              busy={busy}
              onCancel={() => setReasonFor(null)}
              onSubmit={(note) => void decide(reasonFor, note)}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              {stillOpen ? (
                (Object.keys(DECISION_COPY) as LookoutReasonAction[]).map((action) => (
                  <Button
                    key={action}
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setReasonFor(action)}
                  >
                    {DECISION_COPY[action].label}
                  </Button>
                ))
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void decide("reopen")}
                >
                  {busy ? <Spinner aria-hidden /> : null}
                  Reopen
                </Button>
              )}
              {finding.handoffPrompt && onQuote ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => onQuote(finding.handoffPrompt ?? "", `Lookout · ${finding.ref}`)}
                >
                  <MessageSquareQuoteIcon aria-hidden />
                  Add to chat
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function LookoutFindingList({
  findings,
  preferredRepoKey,
  timestampFormat,
  pendingRef,
  onDecide,
  onQuote,
}: {
  findings: readonly LookoutFinding[];
  preferredRepoKey: string | null;
  timestampFormat: TimestampFormat;
  pendingRef: string | null;
  onDecide: LookoutDecide;
  onQuote?: ((text: string, label: string) => boolean) | undefined;
}) {
  return (
    <ul className="flex flex-col gap-0.5" aria-label="Findings">
      {findings.map((finding) => (
        <li key={finding.ref}>
          <FindingRow
            finding={finding}
            inThisFolder={finding.repoKey === preferredRepoKey}
            timestampFormat={timestampFormat}
            busy={pendingRef === finding.ref}
            onDecide={onDecide}
            onQuote={onQuote}
          />
        </li>
      ))}
    </ul>
  );
}
