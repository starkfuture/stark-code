import { scopeThreadRef, scopedThreadKey } from "@starkfuture/client-runtime/environment";
import type { EnvironmentThreadShell } from "@starkfuture/client-runtime/state/models";
import { threadRuntimeIsActive } from "@starkfuture/client-runtime/state/models";
import { derivePendingThreadRequests } from "@starkfuture/client-runtime/state/thread-requests";
import { squashAtomCommandFailure } from "@starkfuture/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@starkfuture/contracts";
import { htmlRenderFromToolItem } from "@starkfuture/shared/toolOutput";
import { ArrowUpRightIcon, BookmarkIcon, SquareIcon, XIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { newMessageId, newThreadId } from "../../lib/utils";
import { derivePendingApprovals } from "../../session-logic";
import { useThreadProjection, useThreadShell, useThreadShells } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useNativeReplies } from "../../state/nativeReplies";
import { CappedReviewPanel } from "./CappedReviewPanel";
import { ChangesetCheckPanel } from "./ChangesetCheckPanel";
import { useComposerDraftStore } from "../../composerDraftStore";
import { ResponseVisualPanel } from "./ResponseVisualPanel";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { useTurnBookmarks } from "./useTurnBookmarks";
import { useThreadTurnIndex } from "./useThreadTurnIndex";
import {
  groupWorkspaceThreads,
  readSideWorkRecords,
  sideWorkContext,
  sideWorkPrompt,
  sideWorkStatus,
  sideWorkTurn,
  type SideWorkKind,
  type SideWorkRecord,
} from "./sideWork.logic";

type SideWorkTab = SideWorkKind | "bookmarks" | "agents" | "checks" | "review";

export function SideWorkButton(props: { open: boolean; onToggle: () => void }) {
  return (
    <Button variant="ghost" size="sm" aria-pressed={props.open} onClick={props.onToggle}>
      Conversation tools
    </Button>
  );
}

/** Mounted with the parent's scoped key: navigation cannot accidentally reuse another chat's context. */
export function SideWorkPanel(props: {
  parent: EnvironmentThreadShell;
  projection: OrchestrationV2ThreadProjection | null;
  workspaceRoot: string;
  nativeShellMode: boolean;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenTurn?: (entryId: string) => void;
  onClose: () => void;
  showHeader?: boolean;
}) {
  const { parent } = props;
  const storageKey = `stark-code:side-work:${scopedThreadKey(scopeThreadRef(parent.environmentId, parent.id))}`;
  const [records, setRecords] = useState(() => {
    try {
      return readSideWorkRecords(localStorage.getItem(storageKey));
    } catch {
      return [];
    }
  });
  const [selected, setSelected] = useState<SideWorkRecord | null>(null);
  const [tab, setTab] = useState<SideWorkTab>("question");
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const canOperate = useEnvironmentScope(parent.environmentId, AuthOrchestrationOperateScope);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const [responding, setResponding] = useState(false);
  const selectedRef = useMemo(
    () => (selected ? scopeThreadRef(parent.environmentId, selected.threadId) : null),
    [parent.environmentId, selected],
  );
  const selectedShell = useThreadShell(selectedRef);
  const selectedProjection = useThreadProjection(selectedRef)?.projection ?? null;
  const shells = useThreadShells(tab === "agents");
  const groups = useMemo(
    () => groupWorkspaceThreads(shells, parent, props.workspaceRoot),
    [shells, parent, props.workspaceRoot],
  );
  const isRunning = threadRuntimeIsActive(selectedShell?.runtime);
  const parentRef = scopeThreadRef(parent.environmentId, parent.id);
  const nativeReplies = useNativeReplies(parentRef, tab === "format" && props.nativeShellMode);
  const readerAnswers = props.nativeShellMode
    ? (nativeReplies.data ?? []).map((reply) => ({
        id: reply.id,
        text: reply.text,
        truncated: reply.truncated === true,
        label: `${reply.provider} · ${reply.text.replace(/\s+/g, " ").slice(0, 90)}`,
      }))
    : (props.projection?.messages ?? [])
        .filter(
          (message) => message.role === "assistant" && !message.streaming && message.text.trim(),
        )
        .map((message, index) => ({
          id: message.id,
          text: message.text,
          label: `${index + 1}. ${message.text.replace(/\s+/g, " ").slice(0, 90)}`,
        }));
  const approval = selectedProjection
    ? derivePendingApprovals(derivePendingThreadRequests(selectedProjection).approvals)[0]
    : undefined;
  const htmlRenders =
    selectedProjection?.turnItems.flatMap((item) => {
      if (item.type !== "dynamic_tool" || item.status !== "completed") return [];
      const render = htmlRenderFromToolItem(item);
      return render ? [render] : [];
    }) ?? [];

  function storeRecord(record: SideWorkRecord) {
    setSelected(record);
    setRecords((current) => {
      const next = [...current.filter((item) => item.threadId !== record.threadId), record].slice(
        -40,
      );
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* Server chat still persists when local storage is unavailable. */
      }
      return next;
    });
  }

  function switchTab(next: SideWorkTab) {
    setTab(next);
    setSelected(null);
    setRequest("");
    setError(null);
  }

  async function send() {
    if (sending.current || !canOperate || tab !== "question" || isRunning) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const kind = selected?.kind ?? tab;
      const prompt = selected
        ? request.trim()
        : sideWorkPrompt({
            kind,
            request,
            context: props.nativeShellMode ? [] : sideWorkContext(props.projection?.messages ?? []),
            response: "",
          });
      if (!prompt) throw new Error("Write a follow-up first.");
      const threadId = selected?.threadId ?? newThreadId();
      const title =
        selected?.title ??
        `${kind === "question" ? "Side question" : "Visual response"}: ${(kind === "question" ? request : parent.title).trim().slice(0, 90)}`;
      const result = await startTurn({
        environmentId: parent.environmentId,
        input: sideWorkTurn({
          parent: selectedShell ?? parent,
          threadId,
          messageId: newMessageId(),
          title,
          kind,
          prompt,
          createdAt: new Date().toISOString(),
          firstTurn: selected === null,
        }),
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        throw cause instanceof Error ? cause : new Error("Could not start the side chat.");
      }
      storeRecord({ threadId, kind, title });
      setRequest("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the side chat.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <aside
      aria-label="Conversation tools content"
      className="flex h-full min-h-0 min-w-0 flex-col border-l border-border bg-background"
    >
      {props.showHeader !== false ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="text-sm font-medium">Conversation tools</h2>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close conversation tools"
            onClick={props.onClose}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      <div
        className="flex flex-wrap gap-1 border-b border-border p-2"
        aria-label="Conversation tool views"
      >
        {(
          [
            ["question", "Side chat"],
            ["format", "Reader"],
            ["bookmarks", "Bookmarks"],
            ["agents", "Agents"],
            ["checks", "Checks"],
            ["review", "Review"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            variant={tab === value ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={tab === value}
            disabled={busy}
            onClick={() => switchTab(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {tab === "review" ? (
        <CappedReviewPanel
          key={storageKey}
          parent={parent}
          workspaceRoot={props.workspaceRoot}
          onOpenThread={props.onOpenThread}
        />
      ) : tab === "checks" ? (
        <ChangesetCheckPanel
          key={`${scopedThreadKey(parentRef)}:${parent.worktreePath ?? props.workspaceRoot}`}
          threadRef={parentRef}
          cwd={parent.worktreePath ?? props.workspaceRoot}
          onDraftFix={(prompt) => {
            const state = useComposerDraftStore.getState();
            const existing = state.getComposerDraft(parentRef)?.prompt ?? "";
            state.setPrompt(parentRef, existing ? `${existing}\n\n${prompt}` : prompt, "human");
            props.onClose();
          }}
        />
      ) : tab === "format" ? (
        <>
          {records.some((record) => record.kind === "format") ? (
            <details className="shrink-0 border-b p-3 text-xs">
              <summary className="cursor-pointer">Earlier formatting chats</summary>
              <div className="mt-2 flex flex-col items-start gap-1">
                {records
                  .filter((record) => record.kind === "format")
                  .map((record) => (
                    <Button
                      key={record.threadId}
                      variant="ghost"
                      size="sm"
                      onClick={() => props.onOpenThread(record.threadId)}
                    >
                      {record.title.slice(0, 65)} <ArrowUpRightIcon />
                    </Button>
                  ))}
              </div>
            </details>
          ) : null}
          {nativeReplies.error ? (
            <p role="alert" className="px-3 py-2 text-sm text-destructive">
              {nativeReplies.error}
            </p>
          ) : null}
          <ResponseVisualPanel
            environmentId={parent.environmentId}
            threadRef={parentRef}
            cwd={parent.worktreePath ?? props.workspaceRoot}
            answers={readerAnswers}
            emptyMessage={
              props.nativeShellMode
                ? "Completed native replies appear here after a new shell session starts. Codex may ask you to approve the capture hook first. You can also paste a reply."
                : undefined
            }
          />
        </>
      ) : tab === "bookmarks" ? (
        <BookmarkedTurns parent={parent} onOpenTurn={props.onOpenTurn} />
      ) : tab === "agents" ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <p className="mb-3 text-xs text-muted-foreground">
            {groups.length} workspace {groups.length === 1 ? "folder" : "folders"} ·{" "}
            {groups.reduce((sum, group) => sum + group.threads.length, 0)} chats
          </p>
          {groups.map((group) => (
            <section className="mb-5 min-w-0" key={group.path}>
              <h3 className="text-sm font-medium">
                {group.isMainWorkspace ? "Main folder" : "Worktree"}
              </h3>
              <p className="mb-2 break-all text-xs text-muted-foreground">{group.path}</p>
              <div className="space-y-2">
                {group.threads.map((thread) => (
                  <WorkspaceAgentRow
                    key={thread.id}
                    thread={thread}
                    canOperate={canOperate}
                    onOpen={() => props.onOpenThread(thread.id)}
                    onStop={async () => {
                      const result = await interruptTurn({
                        environmentId: parent.environmentId,
                        input: { threadId: thread.id },
                      });
                      if (result._tag === "Failure")
                        setError(String(squashAtomCommandFailure(result)));
                    }}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <>
          <div className="shrink-0 space-y-2 border-b border-border p-3">
            <p className="text-xs text-muted-foreground">
              Ask alongside the main conversation. Each side chat has its own history and starts in
              Plan with Manual permissions.
            </p>
            {props.nativeShellMode ? (
              <p className="text-xs text-muted-foreground">
                Terminal history is not copied. Paste the context or response you want to use.
              </p>
            ) : null}
            <label className="block text-xs">
              Saved side chats
              <select
                className="mt-1 block w-full rounded-md border border-input bg-background p-2 text-sm"
                value={selected?.threadId ?? ""}
                disabled={busy}
                onChange={(event) => {
                  setSelected(
                    records.find((record) => record.threadId === event.target.value) ?? null,
                  );
                  setRequest("");
                  setError(null);
                }}
              >
                <option value="">New side chat</option>
                {records
                  .filter((record) => record.kind === tab)
                  .map((record) => (
                    <option key={record.threadId} value={record.threadId}>
                      {record.title}
                    </option>
                  ))}
              </select>
            </label>
            {selected ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {selectedShell ? sideWorkStatus(selectedShell) : "Loading chat…"}
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => props.onOpenThread(selected.threadId)}
                >
                  Open chat <ArrowUpRightIcon />
                </Button>
                {isRunning ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={!canOperate}
                    onClick={() => {
                      void interruptTurn({
                        environmentId: parent.environmentId,
                        input: { threadId: selected.threadId },
                      }).then((result) => {
                        if (result._tag === "Failure")
                          setError(String(squashAtomCommandFailure(result)));
                      });
                    }}
                  >
                    Stop <SquareIcon />
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3" aria-live="polite">
            {selectedProjection?.messages
              .filter((message) => message.role !== "system")
              .map((message, index) =>
                message.role === "user" ? (
                  <details
                    key={message.id}
                    open={index > 0}
                    className="rounded-md border border-border p-2 text-xs"
                  >
                    <summary className="cursor-pointer font-medium">
                      {index === 0 ? "Starting request and context" : "Your follow-up"}
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap break-words">{message.text}</p>
                  </details>
                ) : (
                  <ChatMarkdown
                    key={message.id}
                    reader
                    text={message.text}
                    cwd={selectedShell?.worktreePath ?? props.workspaceRoot}
                    threadRef={selectedRef ?? undefined}
                    isStreaming={message.streaming}
                  />
                ),
              )}
            {htmlRenders.map((render) => (
              <HtmlRenderFrame
                key={render.attachmentId}
                environmentId={parent.environmentId}
                htmlRender={render}
                threadRef={selectedRef ?? undefined}
              />
            ))}
            {selectedShell?.runtime?.lastError ? (
              <p role="alert" className="text-sm text-destructive">
                {selectedShell.runtime.lastError}
              </p>
            ) : null}
            {selectedShell?.hasPendingUserInput ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => selected && props.onOpenThread(selected.threadId)}
              >
                Answer the agent in its chat
              </Button>
            ) : null}
            {selected === null && tab === "question" ? (
              <p className="text-xs text-muted-foreground">
                {props.nativeShellMode
                  ? "Include the context you need in your question. "
                  : "A recent excerpt of this conversation is included. "}
                Side chats use the same folder; they do not get an isolated worktree.
              </p>
            ) : null}
          </div>
          {approval ? (
            <div className="space-y-3 border-t border-border p-3">
              <ComposerPendingApprovalPanel approval={approval} pendingCount={1} />
              <ComposerPendingApprovalActions
                requestId={approval.requestId}
                options={approval.options}
                isResponding={responding}
                canRespond={canOperate && approval.responseCapability !== "not_resumable"}
                onRespondToApproval={async (requestId, decision) => {
                  if (!selected) return;
                  setResponding(true);
                  try {
                    const result = await respondToApproval({
                      environmentId: parent.environmentId,
                      input: { threadId: selected.threadId, requestId, decision },
                    });
                    if (result._tag === "Failure")
                      setError(String(squashAtomCommandFailure(result)));
                  } finally {
                    setResponding(false);
                  }
                }}
              />
            </div>
          ) : null}
          <form
            className="shrink-0 space-y-2 border-t border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Textarea
              aria-label={selected ? "Side chat follow-up" : "Side question"}
              placeholder={selected ? "Follow up…" : "Ask a side question…"}
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              disabled={!canOperate || busy}
            />
            <Button
              type="submit"
              size="sm"
              disabled={
                !canOperate ||
                busy ||
                isRunning ||
                !request.trim() ||
                (selected !== null && !request.trim())
              }
            >
              {busy ? "Starting…" : selected ? "Send follow-up" : "Ask in side chat"}
            </Button>
          </form>
        </>
      )}
      {error ? (
        <p role="alert" className="shrink-0 border-t border-border p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </aside>
  );
}

function BookmarkedTurns({
  parent,
  onOpenTurn,
}: {
  parent: EnvironmentThreadShell;
  onOpenTurn?: ((entryId: string) => void) | undefined;
}) {
  const ref = scopeThreadRef(parent.environmentId, parent.id);
  const { bookmarks, toggleBookmark } = useTurnBookmarks(scopedThreadKey(ref));
  const index = useThreadTurnIndex(ref, bookmarks.size > 0);
  const [visibleCount, setVisibleCount] = useState(100);
  const saved = index.items.filter((item) => bookmarks.has(item.entryId));
  const missing = index.complete
    ? [...bookmarks].filter((entryId) => !index.items.some((item) => item.entryId === entryId))
    : [];
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
      <p className="text-xs text-muted-foreground">
        Saved chat turns, kept on this device. Open a turn to return to it in Chat.
      </p>
      {index.error ? (
        <div role="status" className="text-sm text-muted-foreground">
          {index.error}{" "}
          <Button size="xs" variant="outline" onClick={index.retry}>
            Retry
          </Button>
        </div>
      ) : null}
      {index.loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading saved turns…
        </p>
      ) : null}
      {bookmarks.size === 0 ? (
        <p className="text-sm text-muted-foreground">
          No bookmarks yet. Open Turns beside the conversation and select the bookmark beside a turn
          to save it here.
        </p>
      ) : null}
      <ol className="space-y-1" aria-label="Bookmarked turns">
        {saved.slice(0, visibleCount).map((item) => (
          <li key={item.entryId} className="flex min-w-0 items-start gap-1">
            <div className="min-w-0 flex-1">
              <Button
                variant="ghost"
                size="sm-multiline"
                className="w-full justify-start"
                disabled={!onOpenTurn}
                onClick={() => onOpenTurn?.(item.entryId)}
              >
                <span className="block min-w-0 flex-1 py-1 text-left">
                  <span className="line-clamp-2 break-words">{item.userText || "Saved turn"}</span>
                  {item.assistantText ? (
                    <span className="mt-1 line-clamp-3 break-words text-xs font-normal text-muted-foreground">
                      {item.assistantText}
                    </span>
                  ) : null}
                </span>
              </Button>
            </div>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Remove bookmark from ${item.userText || "saved turn"}`}
              onClick={() => toggleBookmark(item.entryId)}
            >
              <BookmarkIcon aria-hidden="true" fill="currentColor" />
            </Button>
          </li>
        ))}
        {missing.map((entryId) => (
          <li key={entryId} className="flex items-center justify-between gap-2 py-2">
            <span className="text-xs text-muted-foreground">This saved turn is unavailable.</span>
            <Button
              size="xs"
              variant="ghost-muted"
              aria-label="Remove unavailable bookmark"
              onClick={() => toggleBookmark(entryId)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ol>
      {saved.length > visibleCount ? (
        <Button size="xs" variant="outline" onClick={() => setVisibleCount((count) => count + 100)}>
          Show more ({saved.length - visibleCount})
        </Button>
      ) : null}
    </div>
  );
}

function WorkspaceAgentRow(props: {
  thread: EnvironmentThreadShell;
  canOperate: boolean;
  onOpen: () => void;
  onStop: () => Promise<void>;
}) {
  const { thread } = props;
  const terminals = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const [stopping, setStopping] = useState(false);
  return (
    <div className="rounded-lg border border-border p-2">
      <button
        type="button"
        className="block w-full text-left text-sm font-medium break-words hover:underline"
        onClick={props.onOpen}
      >
        {thread.title}
      </button>
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {thread.runtime?.providerName ?? thread.providerInstanceId} · {sideWorkStatus(thread)}
        {thread.branch ? ` · ${thread.branch}` : ""}
      </p>
      {terminals.length ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {terminals.length} active terminal {terminals.length === 1 ? "session" : "sessions"}
        </p>
      ) : null}
      {thread.pendingBackgroundTasks.length ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {thread.pendingBackgroundTasks.length} background tasks
        </p>
      ) : null}
      {thread.lineage.parentThreadId ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {thread.lineage.relationshipToParent === "subagent" ? "Child agent" : "Related chat"}
        </p>
      ) : null}
      {threadRuntimeIsActive(thread.runtime) ? (
        <div className="mt-2">
          <Button
            variant="ghost"
            size="xs"
            disabled={!props.canOperate || stopping}
            onClick={() => {
              setStopping(true);
              void props.onStop().finally(() => setStopping(false));
            }}
          >
            {stopping ? "Stopping…" : "Stop agent"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
