import type { LookoutActivity, LookoutRepo } from "@starkfuture/contracts";
import { PauseIcon, PlayIcon } from "lucide-react";
import type { ReactNode } from "react";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Spinner } from "../ui/spinner";
import { formatCents, withKeys } from "./lookout.logic";

const EVENT_LABELS = {
  prompt: "Prompt",
  edit: "Edit",
  test: "Test run",
  stop: "Turn ended",
} as const;

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{children}</h3>;
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-xs text-muted-foreground">{children}</p>;
}

/** Recent review runs and session events, newest first. Never prompt text or file contents. */
export function LookoutActivityView({ activity }: { activity: LookoutActivity | null }) {
  if (!activity) return <Quiet>Loading recent activity…</Quiet>;
  return (
    <div className="flex flex-col gap-2">
      <section>
        <Heading>Reviews</Heading>
        {activity.runs.length === 0 ? (
          <Quiet>No reviews yet.</Quiet>
        ) : (
          <ul className="flex flex-col">
            {activity.runs.map((run) => (
              <li key={`${run.repo}#${run.id}`} className="flex flex-col gap-0.5 px-2 py-1.5">
                <span className="flex items-baseline gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{run.repo}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {run.kind} · {run.status}
                      {run.trigger ? ` · ${run.trigger}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {run.costCents !== null ? `${formatCents(run.costCents)} · ` : ""}
                    {formatRelativeTimeLabel(run.finishedAt ?? run.startedAt ?? "")}
                  </span>
                </span>
                {run.summary ? (
                  <span className="line-clamp-2 text-xs text-muted-foreground">{run.summary}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <Heading>Session events</Heading>
        {activity.events.length === 0 ? (
          <Quiet>No session events yet.</Quiet>
        ) : (
          <ul className="flex flex-col">
            {withKeys(activity.events, (e) => `${e.at}:${e.kind}:${e.session}:${e.path}`).map(
              ({ key, item: event }) => (
                <li key={key} className="flex min-w-0 items-baseline gap-2 px-2 py-1 text-xs">
                  <span className="w-16 shrink-0 tabular-nums text-muted-foreground">
                    {formatRelativeTimeLabel(event.at)}
                  </span>
                  <span className="shrink-0 font-medium">{EVENT_LABELS[event.kind]}</span>
                  <span className="shrink-0 text-muted-foreground">{event.repo}</span>
                  {event.path ? (
                    <span className="flex min-w-0 flex-1 font-mono">
                      <MiddleTruncate value={event.path} className="min-w-0 flex-1" />
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {event.testStatus ?? ""}
                    </span>
                  )}
                  {event.session ? (
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {event.session}
                    </span>
                  ) : null}
                </li>
              ),
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

export function LookoutRepoList({
  repos,
  preferredRepoKey,
  pendingRepo,
  onSetPaused,
}: {
  repos: readonly LookoutRepo[];
  preferredRepoKey: string | null;
  pendingRepo: string | null;
  onSetPaused: (repo: LookoutRepo, paused: boolean) => void;
}) {
  return (
    <ul className="flex flex-col" aria-label="Watched repositories">
      {repos.map((repo) => (
        <li key={repo.key} className="flex items-start gap-2 px-2 py-2">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
              <span className="truncate font-medium">{repo.name}</span>
              {repo.key === preferredRepoKey ? (
                <Badge size="sm" variant="outline">
                  This folder
                </Badge>
              ) : null}
              {repo.paused ? (
                <Badge size="sm" variant="warning">
                  Paused
                </Badge>
              ) : null}
              {repo.excluded ? (
                <Badge size="sm" variant="secondary">
                  Excluded
                </Badge>
              ) : null}
            </span>
            <span className="flex min-w-0 font-mono text-xs text-muted-foreground">
              <MiddleTruncate value={repo.root} className="min-w-0 flex-1" />
            </span>
            <span className="text-xs text-muted-foreground">
              {repo.openFindings === 1 ? "1 open finding" : `${repo.openFindings} open findings`}
              {" · "}
              {repo.activeJob
                ? "reviewing now"
                : `last activity ${formatRelativeTimeLabel(repo.lastEventAt) || "never"}`}
            </span>
          </span>
          {repo.excluded ? null : (
            <Button
              size="xs"
              variant="ghost"
              disabled={pendingRepo === repo.key}
              aria-label={`${repo.paused ? "Resume" : "Pause"} reviews in ${repo.name}`}
              onClick={() => onSetPaused(repo, !repo.paused)}
            >
              {pendingRepo === repo.key ? (
                <Spinner aria-hidden />
              ) : repo.paused ? (
                <PlayIcon aria-hidden />
              ) : (
                <PauseIcon aria-hidden />
              )}
              {repo.paused ? "Resume" : "Pause"}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
