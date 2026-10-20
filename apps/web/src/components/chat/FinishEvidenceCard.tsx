import { ClipboardCheckIcon } from "lucide-react";
import type { FinishCommandEvidence, FinishEvidence } from "./finishEvidence";

function commandResult(command: FinishCommandEvidence): string {
  if (command.outcome === "tool-completed") return "Tool completed · exit code not reported";
  if (command.outcome === "unfinished") return "Still running or waiting";
  if (command.outcome === "failed")
    return command.exitCode === null
      ? "Failed or interrupted"
      : `Exit ${command.exitCode} · failure reported`;
  return command.exitCode === null ? "Exit code not reported" : `Exit ${command.exitCode}`;
}

/** Recorded evidence only; expanding the card never runs a command or calls a model. */
export function FinishEvidenceCard({ evidence }: { readonly evidence: FinishEvidence | null }) {
  if (!evidence) return null;
  const needsAttention =
    evidence.failedCount > 0 ||
    evidence.unknownCount > 0 ||
    evidence.staleChecks > 0 ||
    evidence.unknownTimingChecks > 0 ||
    evidence.unconfirmedFileChanges > 0 ||
    evidence.captureIncomplete === true;
  return (
    <section
      className="my-3 rounded-xl border border-border/70 bg-muted/20 text-sm"
      aria-label="Run evidence"
    >
      <details>
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-3 focus-visible:outline-2 focus-visible:outline-ring">
          <ClipboardCheckIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">Run evidence</span>
          <span className="text-xs text-muted-foreground">
            {evidence.commands.length} {evidence.commands.length === 1 ? "command" : "commands"} ·{" "}
            {evidence.files.length} reported {evidence.files.length === 1 ? "file" : "files"}
          </span>
          <span
            className={`ml-auto text-xs ${needsAttention ? "text-warning-foreground" : "text-muted-foreground"}`}
          >
            {evidence.failedCount
              ? `${evidence.failedCount} failed`
              : evidence.staleChecks
                ? "Edits after checks began"
                : evidence.unknownCount ||
                    evidence.unknownTimingChecks ||
                    evidence.unconfirmedFileChanges ||
                    evidence.captureIncomplete
                  ? "Incomplete evidence"
                  : evidence.zeroExitChecks
                    ? `${evidence.zeroExitChecks} check commands exited 0`
                    : evidence.completedToolChecks
                      ? `${evidence.completedToolChecks} check tools completed`
                      : "No check result recorded"}
          </span>
        </summary>
        <div className="space-y-3 border-t border-border/60 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {evidence.source === "native"
              ? "Recorded native tool results for this reply. Arguments and outputs are hidden. This snapshot does not cover every shell edit, child agent or changes made outside this turn. Tool completion alone does not prove tests passed."
              : "Recorded commands and reported edits for this turn. This does not verify the whole project or changes made outside this session."}
          </p>
          {evidence.captureIncomplete ? (
            <p className="text-xs text-warning-foreground">
              Some native records were unavailable or outside the capture limit. Missing results
              remain unknown.
            </p>
          ) : null}
          {evidence.runStatus !== "completed" ? (
            <p className="text-xs">Turn {evidence.runStatus}.</p>
          ) : null}
          {evidence.staleChecks ? (
            <p className="text-xs text-warning-foreground">
              Files changed after {evidence.staleChecks} completed check commands began. Their
              results may not cover the final edits.
            </p>
          ) : null}
          {evidence.unknownCount ? (
            <p className="text-xs text-muted-foreground">
              {evidence.unknownCount} commands have no confirmed final exit result.
            </p>
          ) : null}
          {evidence.unconfirmedFileChanges ? (
            <p className="text-xs text-muted-foreground">
              {evidence.unconfirmedFileChanges} file-change operations have no confirmed completion.
            </p>
          ) : null}
          <ol className="space-y-3">
            {evidence.commands.map((command) => (
              <li key={command.id} className="space-y-1">
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 text-xs">
                  <code>{command.command}</code>
                </pre>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{commandResult(command)}</span>
                  {command.startedAt ? (
                    <span>
                      Started{" "}
                      <time dateTime={command.startedAt}>
                        {new Date(command.startedAt).toLocaleTimeString()}
                      </time>
                    </span>
                  ) : (
                    <span>Start time not reported</span>
                  )}
                  {command.completedAt ? (
                    <span>
                      Finished{" "}
                      <time dateTime={command.completedAt}>
                        {new Date(command.completedAt).toLocaleTimeString()}
                      </time>
                    </span>
                  ) : null}
                </div>
                {command.isCheck &&
                (command.outcome === "exit-zero" || command.outcome === "tool-completed") &&
                command.freshness === "changed" ? (
                  <p className="break-all text-xs text-warning-foreground">
                    Later reported edits: {command.laterFiles.join(", ")}
                  </p>
                ) : null}
                {command.isCheck && command.freshness === "unknown" ? (
                  <p className="text-xs text-muted-foreground">
                    Cannot establish whether this command covered the reported edits.
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
          {evidence.files.length ? (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Reported files ({evidence.files.length})
              </summary>
              <ul className="mt-2 space-y-1 break-all font-mono text-xs">
                {evidence.files.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </details>
    </section>
  );
}
