import type { PilotActivity, PilotRepo } from "@starkfuture/contracts";
import { PauseIcon, PlayIcon } from "lucide-react";
import type { ReactNode } from "react";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Spinner } from "../ui/spinner";
import { describeEvent, describeRun, formatDollars, withKeys } from "./pilot.logic";

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">{children}</h3>;
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="px-3 py-1 text-xs text-muted-foreground">{children}</p>;
}

/** What Pilot checked and what happened in the sessions it watches, newest first, in plain words. */
export function PilotActivityView({ activity }: { activity: PilotActivity | null }) {
  if (!activity) return <Quiet>Loading recent activity…</Quiet>;
  return (
    <div className="flex flex-col pb-3">
      <section>
        <Heading>Pilot's checks</Heading>
        {activity.runs.length === 0 ? (
          <Quiet>No checks yet.</Quiet>
        ) : (
          <ul className="flex flex-col">
            {activity.runs.map((run) => {
              const { title, detail, summary } = describeRun(run);
              const when = formatRelativeTimeLabel(run.finishedAt ?? run.startedAt ?? "");
              return (
                <li key={`${run.repo}#${run.id}`} className="flex flex-col gap-0.5 px-3 py-1.5">
                  <span className="flex min-w-0 items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 break-words">{title}</span>
                    {when ? (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {when}
                      </span>
                    ) : null}
                  </span>
                  {detail || run.costCents ? (
                    <span className="text-xs text-muted-foreground">
                      {[detail, run.costCents ? formatDollars(run.costCents) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  ) : null}
                  {summary ? (
                    <span className="text-xs break-words text-muted-foreground">{summary}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section>
        <Heading>In your sessions</Heading>
        {activity.events.length === 0 ? (
          <Quiet>Nothing yet.</Quiet>
        ) : (
          <ul className="flex flex-col">
            {withKeys(activity.events, (e) => `${e.at}:${e.kind}:${e.session}:${e.path}`).map(
              ({ key, item: event }) => (
                <li key={key} className="flex min-w-0 flex-col gap-0.5 px-3 py-1">
                  <span className="flex min-w-0 items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 break-words">
                      {describeEvent(event)}
                      <span className="text-muted-foreground"> in {event.repo}</span>
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {formatRelativeTimeLabel(event.at)}
                    </span>
                  </span>
                  {event.path ? (
                    <span className="flex min-w-0 font-mono text-xs text-muted-foreground">
                      <MiddleTruncate value={event.path} className="min-w-0 flex-1" />
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

export function PilotRepoList({
  repos,
  preferredRepoKey,
  pendingRepo,
  onSetPaused,
}: {
  repos: readonly PilotRepo[];
  preferredRepoKey: string | null;
  pendingRepo: string | null;
  onSetPaused: (repo: PilotRepo, paused: boolean) => void;
}) {
  if (repos.length === 0)
    return (
      <Quiet>
        No repositories yet. Pilot starts watching a repository the first time a Claude Code session
        works in it.
      </Quiet>
    );
  return (
    <ul className="flex flex-col py-1" aria-label="Watched repositories">
      {repos.map((repo) => {
        // Pilot reports a repository with no events yet as the epoch.
        const lastActivity =
          Date.parse(repo.lastEventAt) > 0 ? formatRelativeTimeLabel(repo.lastEventAt) : "";
        return (
          <li key={repo.key} className="flex min-w-0 items-start gap-2 px-3 py-2">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                <span className="min-w-0 break-words font-medium">{repo.name}</span>
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
                    Not watched
                  </Badge>
                ) : null}
              </span>
              <span className="flex min-w-0 font-mono text-xs text-muted-foreground">
                <MiddleTruncate value={repo.root} className="min-w-0 flex-1" />
              </span>
              <span className="text-xs text-muted-foreground">
                {repo.activeJob
                  ? "Checking now"
                  : lastActivity
                    ? `Last active ${lastActivity}`
                    : "No activity yet"}
              </span>
            </span>
            {repo.excluded ? null : (
              <Button
                size="xs"
                variant="ghost"
                disabled={pendingRepo === repo.key}
                aria-label={`${repo.paused ? "Resume" : "Pause"} Pilot in ${repo.name}`}
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
        );
      })}
    </ul>
  );
}
