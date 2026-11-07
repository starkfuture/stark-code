import {
  PILOT_ASK_MAX_LENGTH,
  type PilotActivity,
  type PilotBridge,
  type PilotEngine,
  type PilotInstallStatus,
  type PilotMessage,
  type PilotNudgeAction,
  type PilotRepo,
  type PilotResponse,
  type PilotSettings,
  type PilotStatus,
  type TimestampFormat,
} from "@starkfuture/contracts";
import {
  ActivityIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  InfoIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  ScanEyeIcon,
  Trash2Icon,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "~/lib/utils";
import { ConversationToolsPanel } from "../chat/ConversationToolsPanel";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PilotActivityView, PilotRepoList } from "./PilotActivity";
import { PilotEngineMenu, PilotEngineMenuGroup } from "./PilotEngine";
import { PilotThread, type PilotPendingQuestion } from "./PilotThread";
import {
  WATCH_STATE_LABELS,
  budgetLabel,
  chatSupported,
  emptyThreadText,
  installAction,
  installBlocker,
  installDetails,
  installHeadline,
  pilotStatusLine,
  pilotWatchState,
  mergeMessages,
  newestMessageId,
  nudgeErrorText,
  pendingQuestionShown,
  repoForPath,
  type PilotWatchState,
} from "./pilot.logic";
import {
  PILOT_STATUS_POLL_MS,
  notePilotSeen,
  notePilotStatus,
  notePilotUnread,
  usePilotIndicator,
  usePoll,
} from "./pilotStore";

/** The thread refreshes this often while the panel is open; the status as often as the top bar's. */
export const PILOT_CHAT_POLL_MS = 5000;
/** Engine availability changes rarely: on open, after a change, then this often. */
const SETTINGS_POLL_MS = 60_000;
/** How many messages the panel loads when it opens. */
const THREAD_LIMIT = 200;
const UNREACHABLE = "Could not reach Pilot. Try again.";
/** Reading Claude Code's plugins runs `claude` twice, so an open panel rechecks at most this often. */
const INSTALL_RECHECK_MS = 5 * 60_000;

type PilotView = "chat" | "activity" | "repos";

const DOT_CLASS: Record<PilotWatchState, string> = {
  watching: "bg-success",
  paused: "bg-warning",
  "not-running": "bg-muted-foreground",
  "not-installed": "bg-muted-foreground",
  unknown: "bg-muted-foreground/50",
};

/** Pilot's status and thread while the panel is open, with every way to act on them. */
function usePilotChat(bridge: PilotBridge, active: boolean) {
  const [status, setStatus] = useState<PilotResponse<PilotStatus> | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [messages, setMessages] = useState<readonly PilotMessage[]>([]);
  const [threadError, setThreadError] = useState<string | null>(null);
  // The newest message the last thread check returned. Answers and nudge replies never move it,
  // so a nudge stored between two checks is still fetched.
  const since = useRef<number | null>(null);

  const refreshStatus = usePoll(
    async (isCurrent) => {
      try {
        const next = await bridge.status();
        if (!isCurrent()) return;
        setStatus(next);
        setUnreachable(false);
        notePilotStatus(next);
      } catch {
        if (isCurrent()) setUnreachable(true);
      }
    },
    PILOT_STATUS_POLL_MS,
    active,
  );

  const canChat = status?.installed === true && status.ok && chatSupported(status.value);
  const chatEnabled = active && canChat;
  useEffect(() => {
    // Reopening reloads the whole thread, so changes made elsewhere show up.
    if (!chatEnabled) since.current = null;
  }, [chatEnabled]);

  const refreshThread = usePoll(
    async (isCurrent) => {
      const after = since.current;
      try {
        const next = await bridge.chat(after === null ? { limit: THREAD_LIMIT } : { since: after });
        if (!isCurrent()) return;
        if (!next.installed) {
          setThreadError("Pilot is no longer installed.");
          return;
        }
        if (!next.ok) {
          setThreadError(next.error);
          return;
        }
        setThreadError(null);
        setMessages((current) => mergeMessages(after === null ? [] : current, next.value.messages));
        const newest = Math.max(after ?? 0, ...next.value.messages.map((message) => message.id));
        since.current = newest;
        notePilotUnread(next.value.unread);
      } catch {
        if (isCurrent()) setThreadError(UNREACHABLE);
      }
    },
    PILOT_CHAT_POLL_MS,
    chatEnabled,
  );

  const applyMessages = useCallback((incoming: readonly PilotMessage[]) => {
    setMessages((current) => mergeMessages(current, incoming));
  }, []);

  return {
    status,
    unreachable,
    messages,
    threadError,
    canChat,
    refreshStatus,
    refreshThread,
    applyMessages,
  };
}

/** Claude Code's Pilot plugin: checked when the panel opens, and installed, updated or removed on request. */
function usePilotInstall(bridge: PilotBridge, active: boolean, onChanged: () => void) {
  const [status, setStatus] = useState<PilotInstallStatus | null>(null);
  const [checked, setChecked] = useState(false);
  /** Why Claude Code's plugins could not be read, such as a missing `claude` command. */
  const [checkError, setCheckError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"install" | "uninstall" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The version just installed from this panel, for one quiet confirmation. */
  const [installed, setInstalled] = useState<string | null>(null);
  const lastCheck = useRef(0);

  const check = useCallback(async () => {
    if (!bridge.installStatus) return;
    lastCheck.current = Date.now();
    try {
      const next = await bridge.installStatus();
      setStatus(next.ok ? next.value : null);
      setCheckError(next.ok ? null : next.error);
    } catch {
      setStatus(null);
      setCheckError(null);
    } finally {
      setChecked(true);
    }
  }, [bridge]);

  useEffect(() => {
    if (active && Date.now() - lastCheck.current > INSTALL_RECHECK_MS) void check();
  }, [active, check]);

  const change = async (kind: "install" | "uninstall") => {
    const call = kind === "install" ? bridge.install : bridge.uninstall;
    if (!call || busy) return;
    setBusy(kind);
    setError(null);
    try {
      const result = await call();
      if (!result.ok) setError(result.error);
      else {
        setStatus(result.value);
        setInstalled(
          kind === "install" && result.value.state === "installed"
            ? (result.value.installedVersion ?? result.value.bundledVersion)
            : null,
        );
      }
    } catch {
      setError(`Stark Code could not ${kind} Pilot. Try again.`);
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  return {
    supported: bridge.installStatus !== undefined && bridge.install !== undefined,
    canUninstall:
      bridge.uninstall !== undefined &&
      (status?.state === "installed" || status?.state === "update" || status?.state === "legacy"),
    checked,
    checkError,
    status,
    busy,
    error,
    installed,
    check,
    install: () => change("install"),
    uninstall: () => change("uninstall"),
  };
}

type PilotInstall = ReturnType<typeof usePilotInstall>;

function InstallButton({ install, label }: { install: PilotInstall; label: string }) {
  const blocked = install.status ? installBlocker(install.status) !== null : false;
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={install.busy !== null || blocked}
      onClick={() => void install.install()}
    >
      {install.busy === "install" ? `${label === "Update" ? "Updating" : "Installing"}…` : label}
    </Button>
  );
}

/** Where Pilot goes and what it replaces, folded away until asked for. */
function InstallDetails({ status }: { status: PilotInstallStatus }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button size="micro" variant="quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRightIcon aria-hidden className={cn("transition-transform", open && "rotate-90")} />
        Details
      </Button>
      {open ? (
        <dl className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-left text-xs text-muted-foreground">
          {installDetails(status).map((row) => (
            <Fragment key={`${row.label}:${row.value}`}>
              <dt className="whitespace-nowrap">{row.label}</dt>
              <dd className="break-all text-foreground/80">{row.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/** One quiet row above the thread when Claude Code runs Lookout, a checkout, an older Pilot or none. */
function InstallRow({ install }: { install: PilotInstall }) {
  const action = installAction(install.status);
  if (!install.status || !action) return null;
  const blocker = installBlocker(install.status);
  return (
    <div className="flex flex-col gap-1 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 break-words text-muted-foreground">
          {installHeadline(install.status)}
        </p>
        <InstallButton install={install} label={action} />
      </div>
      {blocker ? <p className="break-words text-warning-foreground">{blocker}</p> : null}
      <InstallDetails status={install.status} />
    </div>
  );
}

/** Asks once before removing Pilot from Claude Code; Pilot's own data stays. */
function UninstallRow({ install, onDone }: { install: PilotInstall; onDone: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs">
      <p className="min-w-0 flex-1 break-words text-muted-foreground">
        Remove Pilot from Claude Code? Its history and settings stay.
      </p>
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={install.busy !== null}
        onClick={() => void install.uninstall().then(onDone)}
      >
        {install.busy === "uninstall" ? "Uninstalling…" : "Uninstall"}
      </Button>
      <Button size="xs" variant="ghost" disabled={install.busy !== null} onClick={onDone}>
        Cancel
      </Button>
    </div>
  );
}

function StatusWord({ state }: { state: PilotWatchState }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[state])} />
      {WATCH_STATE_LABELS[state]}
    </span>
  );
}

function CenteredState({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>;
}

function NotInstalled({
  launcher,
  install,
  onCheck,
}: {
  launcher: string;
  install: PilotInstall;
  onCheck: () => void;
}) {
  const plugin = install.status;
  const action = installAction(plugin);
  const blocker = plugin ? installBlocker(plugin) : null;
  // The plugin is in Claude Code, but no session has started Pilot yet.
  if (plugin?.state === "installed" && install.busy === null)
    return (
      <CenteredState>
        <Empty size="compact">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScanEyeIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Pilot {plugin.installedVersion} is installed</EmptyTitle>
            <EmptyDescription>It starts with your next Claude Code session.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="xs" variant="outline" onClick={onCheck}>
              Check again
            </Button>
          </EmptyContent>
        </Empty>
      </CenteredState>
    );
  return (
    <CenteredState>
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ScanEyeIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            {plugin && plugin.state !== "not-installed" && action
              ? installHeadline(plugin)
              : "Pilot isn't installed"}
          </EmptyTitle>
          {blocker ? <p className="text-sm text-warning-foreground">{blocker}</p> : null}
        </EmptyHeader>
        <EmptyContent>
          {plugin && action ? (
            <>
              <InstallButton install={install} label={action} />
              {install.error ? (
                <p role="alert" className="text-xs break-words text-destructive-foreground">
                  {install.error}
                </p>
              ) : null}
              <InstallDetails status={plugin} />
            </>
          ) : install.supported && !install.checked ? (
            <p className="text-xs text-muted-foreground">Checking Claude Code's plugins…</p>
          ) : (
            <>
              {(plugin?.note ?? install.checkError) ? (
                <p className="text-xs break-words text-muted-foreground">
                  {plugin?.note ?? install.checkError}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">Install it from a Pilot checkout:</p>
              <code className="w-full rounded-md bg-muted px-2 py-1.5 text-left font-mono text-xs break-words select-all">
                &lt;path-to-pilot-checkout&gt;
                <wbr />
                /scripts/pilot install
              </code>
              <p className="text-xs break-all text-muted-foreground">
                Stark Code looks for {launcher}
              </p>
              <Button size="xs" variant="outline" onClick={onCheck}>
                Check again
              </Button>
            </>
          )}
        </EmptyContent>
      </Empty>
    </CenteredState>
  );
}

/** One quiet line above the thread: why Pilot may stay silent, or what just failed. */
function ThreadNotice({
  tone = "muted",
  action,
  children,
}: {
  tone?: "muted" | "warning" | "error";
  /** One button for the one thing to do about it. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-center gap-1.5 px-3 py-2 text-xs break-words",
        tone === "muted" && "text-muted-foreground",
        tone === "warning" && "text-warning-foreground",
        tone === "error" && "text-destructive-foreground",
      )}
    >
      <InfoIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** Enter sends, Shift+Enter adds a line; the field stays editable while Pilot answers. */
function Composer({
  draft,
  disabled,
  asking,
  engine,
  onDraftChange,
  onSend,
}: {
  draft: string;
  disabled: boolean;
  asking: boolean;
  /** The engine control beside Send, when Pilot thinks with more than one engine. */
  engine: ReactNode;
  onDraftChange: (value: string) => void;
  onSend: () => void;
}) {
  const canSend = !disabled && !asking && draft.trim().length > 0;
  return (
    <form
      className="flex shrink-0 items-end gap-1 border-t border-border p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      <Textarea
        size="compact"
        className="min-w-0 flex-1"
        rows={1}
        aria-label="Ask Pilot"
        placeholder="Ask Pilot…"
        value={draft}
        maxLength={PILOT_ASK_MAX_LENGTH}
        disabled={disabled}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (canSend) onSend();
        }}
      />
      <div className="flex shrink-0 items-center gap-0.5 pb-0.5">
        {engine}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="submit"
                size="icon-sm"
                variant="outline"
                aria-label="Send"
                disabled={!canSend}
              />
            }
          >
            <ArrowUpIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="top" positionMethod="fixed">
            Send (Enter)
          </TooltipPopup>
        </Tooltip>
      </div>
    </form>
  );
}

/** Heading controls above the body, for use outside the docked frame. */
const stacked = (heading: ReactNode, body: ReactNode) => (
  <>
    <div className="flex items-center gap-2 p-2">{heading}</div>
    {body}
  </>
);

/**
 * Pilot as a chat: its nudges and answers, newest at the bottom, a composer
 * to ask about your own sessions, and the watched repositories and activity
 * behind the "…" menu. `frame` places the heading controls and the body; by
 * default they render one after the other.
 */
export function PilotContent({
  bridge,
  active,
  projectRoot,
  timestampFormat,
  frame = stacked,
}: {
  bridge: PilotBridge;
  active: boolean;
  /** The conversation's folder; its repository is marked in Watched repos. */
  projectRoot: string | null;
  timestampFormat: TimestampFormat;
  frame?: (heading: ReactNode, body: ReactNode) => ReactNode;
}) {
  const chat = usePilotChat(bridge, active);
  const { status, messages, refreshStatus, refreshThread, applyMessages } = chat;
  const install = usePilotInstall(bridge, active, () => refreshStatus());
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [selftestRun, setSelftestRun] = useState<"idle" | "running" | "failed">("idle");
  /** Runs Pilot's self-test (one model run, about a minute), then rereads the status. */
  const runSelftest = async () => {
    if (!bridge.selftest || selftestRun === "running") return;
    setSelftestRun("running");
    setActionError(null);
    let outcome: "idle" | "failed" = "idle";
    try {
      const result = await bridge.selftest();
      if (!result.installed) setActionError("Pilot is no longer installed.");
      else if (!result.ok) setActionError(result.error);
      else if (!result.value.passed) outcome = "failed";
    } catch {
      setActionError(UNREACHABLE);
    } finally {
      setSelftestRun(outcome);
      refreshStatus();
    }
  };
  const [view, setView] = useState<PilotView>("chat");
  const [activity, setActivity] = useState<PilotResponse<PilotActivity> | null>(null);
  const [pendingRepo, setPendingRepo] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const unread = usePilotIndicator((state) => state.unread);
  const [settings, setSettings] = useState<PilotSettings | null>(null);
  // The engine for the next question when it differs from the default; null follows the default.
  const [nextEngine, setNextEngine] = useState<PilotEngine | null>(null);
  const [pending, setPending] = useState<PilotPendingQuestion | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const askToken = useRef(0);
  const [busy, setBusy] = useState<ReadonlyMap<number, PilotNudgeAction>>(new Map());
  const [nudgeErrors, setNudgeErrors] = useState<ReadonlyMap<number, string>>(new Map());
  const seenAsked = useRef(new Set<number>());
  const seenQueue = useRef<number[]>([]);
  const seenRunning = useRef(false);
  // Nudges already taken off the top bar's count, so seeing and acting on one counts once.
  const counted = useRef(new Set<number>());
  const countSeen = (message: Pick<PilotMessage, "id" | "state">) => {
    if ((message.state !== "new" && message.state !== "sent") || counted.current.has(message.id))
      return;
    counted.current.add(message.id);
    notePilotSeen(1);
  };
  const latestMessages = useRef(messages);
  useLayoutEffect(() => {
    latestMessages.current = messages;
  });

  const statusOk = status?.installed === true && status.ok;
  const refreshSettings = usePoll(
    async (isCurrent) => {
      try {
        const next = await bridge.settings({});
        // A Pilot without engine settings shows no switch.
        if (isCurrent()) setSettings(next.installed && next.ok ? next.value : null);
      } catch {
        if (isCurrent()) setSettings(null);
      }
    },
    SETTINGS_POLL_MS,
    active && chat.canChat,
  );
  // The status names the default engine before Pilot reports which engines can run.
  const defaultEngine = settings?.engine ?? (statusOk ? status.value.engine : undefined) ?? null;
  const chosenEngine = nextEngine ?? defaultEngine;
  const chooseNextEngine = (engine: PilotEngine) =>
    setNextEngine(engine === defaultEngine ? null : engine);
  const setDefaultEngine = async (engine: PilotEngine) => {
    setActionError(null);
    try {
      const result = await bridge.settings({ engine });
      if (!result.installed) setActionError("Pilot is no longer installed.");
      else if (!result.ok) setActionError(result.error);
      else {
        setSettings(result.value);
        setNextEngine(null);
      }
    } catch {
      setActionError(UNREACHABLE);
    } finally {
      refreshStatus();
      refreshSettings();
    }
  };
  usePoll(
    async (isCurrent) => {
      try {
        const next = await bridge.activity({ limit: 50 });
        if (isCurrent()) setActivity(next);
      } catch {
        if (isCurrent())
          setActivity({ installed: true, ok: false, reason: "failed", error: UNREACHABLE });
      }
    },
    PILOT_STATUS_POLL_MS,
    active && statusOk && view === "activity",
  );

  /** Runs one change to Pilot, shows its refusal, then refreshes the status. */
  const change = async (key: string, call: () => Promise<PilotResponse<unknown>>) => {
    setPendingRepo(key);
    setActionError(null);
    try {
      const result = await call();
      if (!result.installed) setActionError("Pilot is no longer installed.");
      else if (!result.ok) setActionError(result.error);
    } catch {
      setActionError(UNREACHABLE);
    } finally {
      setPendingRepo(null);
      refreshStatus();
    }
  };

  const withEntry = <T,>(map: ReadonlyMap<number, T>, id: number, value: T | undefined) => {
    const next = new Map(map);
    if (value === undefined) next.delete(id);
    else next.set(id, value);
    return next;
  };

  const actOnNudge = async (message: PilotMessage, action: PilotNudgeAction) => {
    setBusy((current) => withEntry(current, message.id, action));
    setNudgeErrors((current) => withEntry(current, message.id, undefined));
    try {
      const result = await bridge.nudge({ id: message.id, action });
      if (!result.installed) throw new Error("Pilot is no longer installed.");
      if (!result.ok) throw new Error(nudgeErrorText(result.error));
      applyMessages([result.value.message ?? { ...message, state: stateAfter(action) }]);
      countSeen(message);
    } catch (error) {
      const text = error instanceof Error && error.message ? error.message : UNREACHABLE;
      setNudgeErrors((current) => withEntry(current, message.id, text));
    } finally {
      setBusy((current) => withEntry(current, message.id, undefined));
    }
  };

  /** Marks nudges seen one at a time, in the order they came on screen. */
  const markSeen = (ids: readonly number[]) => {
    for (const id of ids) {
      if (seenAsked.current.has(id)) continue;
      seenAsked.current.add(id);
      seenQueue.current.push(id);
    }
    if (seenRunning.current) return;
    seenRunning.current = true;
    void (async () => {
      try {
        while (seenQueue.current.length > 0) {
          const id = seenQueue.current.shift()!;
          try {
            const result = await bridge.nudge({ id, action: "seen" });
            if (result.installed && result.ok) {
              const shown = latestMessages.current.find((message) => message.id === id);
              if (result.value.message) applyMessages([result.value.message]);
              else if (shown) applyMessages([{ ...shown, state: "seen" }]);
              if (shown) countSeen(shown);
            } else {
              seenAsked.current.delete(id);
            }
          } catch {
            seenAsked.current.delete(id);
          }
        }
      } finally {
        seenRunning.current = false;
      }
    })();
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || pending) return;
    const token = ++askToken.current;
    const engine = nextEngine;
    setDraft("");
    setNextEngine(null);
    setAskError(null);
    setPending({ text, afterId: newestMessageId(messages), engine });
    const restore = () => {
      setDraft((current) => (current.trim() ? current : text));
      setNextEngine((current) => current ?? engine);
    };
    try {
      const result = await bridge.ask(engine ? { text, engine } : { text });
      if (askToken.current !== token) return;
      if (!result.installed) {
        setAskError("Pilot is no longer installed.");
        restore();
      } else if (!result.ok) {
        if (result.reason !== "cancelled") {
          setAskError(`Pilot did not answer: ${result.error}`);
          restore();
        }
      } else {
        applyMessages([result.value.question, result.value.answer]);
      }
    } catch {
      if (askToken.current === token) {
        setAskError(UNREACHABLE);
        restore();
      }
    } finally {
      if (askToken.current === token) {
        setPending(null);
        refreshThread();
        // Codex runs left today, and whether an engine fell back, change with each answer.
        refreshSettings();
      }
    }
  };

  const cancelAsk = () => {
    if (!pending) return;
    askToken.current++;
    const { text } = pending;
    // Pilot may already have kept the question in the thread; otherwise it goes back to the composer.
    const kept = !pendingQuestionShown(messages, pending);
    setPending(null);
    if (!kept) {
      setDraft((current) => (current.trim() ? current : text));
      setNextEngine((current) => current ?? pending.engine ?? null);
    }
    void bridge.cancelAsk().catch(() => undefined);
    refreshThread();
  };

  // Claude Code has the plugin, but no session has started Pilot yet: it is not running, not missing.
  const watch =
    pilotWatchState(status) === "not-installed" && install.status?.state === "installed"
      ? "not-running"
      : pilotWatchState(status);
  const state = statusOk ? status.value : null;

  const heading = (
    <>
      {status === null && !chat.unreachable ? (
        <StatusWord state="unknown" />
      ) : watch !== "unknown" ? (
        <StatusWord state={watch} />
      ) : null}
      {state ? (
        <Menu>
          <MenuTrigger
            render={<Button size="icon-sm" variant="ghost" aria-label="Pilot options" />}
          >
            <MoreHorizontalIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="start" positionMethod="fixed">
            <div className="w-56 max-w-[calc(100vw-3rem)]">
              <MenuItem
                disabled={pendingRepo === "all"}
                onClick={() =>
                  void change("all", () => (state.paused ? bridge.resume({}) : bridge.pause({})))
                }
              >
                {state.paused ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
                {state.paused ? "Resume Pilot" : "Pause Pilot"}
              </MenuItem>
              <MenuItem onClick={() => setView("repos")}>
                <FolderGit2Icon aria-hidden />
                Watched repos
              </MenuItem>
              <MenuItem onClick={() => setView("activity")}>
                <ActivityIcon aria-hidden />
                Activity
              </MenuItem>
              {settings ? (
                <>
                  <MenuSeparator />
                  <PilotEngineMenuGroup
                    settings={settings}
                    onChoose={(engine) => void setDefaultEngine(engine)}
                  />
                </>
              ) : null}
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>Budget: {budgetLabel(state.budget)}</MenuGroupLabel>
              </MenuGroup>
              {install.canUninstall ? (
                <>
                  <MenuSeparator />
                  <MenuItem
                    disabled={install.busy !== null}
                    onClick={() => {
                      setView("chat");
                      setConfirmUninstall(true);
                    }}
                  >
                    <Trash2Icon aria-hidden />
                    Uninstall Pilot…
                  </MenuItem>
                </>
              ) : null}
            </div>
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );

  const body = (() => {
    if (status === null) {
      return (
        <CenteredState>
          {chat.unreachable ? (
            <Notice title="Pilot did not answer">{UNREACHABLE}</Notice>
          ) : (
            <Notice title="Checking Pilot">One moment.</Notice>
          )}
        </CenteredState>
      );
    }
    if (!status.installed)
      return (
        <NotInstalled
          launcher={status.launcher}
          install={install}
          onCheck={() => {
            refreshStatus();
            void install.check();
          }}
        />
      );
    if (!status.ok) {
      return (
        <div className="p-3">
          <Alert variant="error">
            <AlertTitle>Pilot did not answer</AlertTitle>
            <AlertDescription>{status.error}</AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" onClick={() => refreshStatus()}>
                Try again
              </Button>
            </AlertAction>
          </Alert>
        </div>
      );
    }
    const value = status.value;
    if (view !== "chat") {
      const activityValue = activity?.installed && activity.ok ? activity.value : null;
      const activityError = activity?.installed && !activity.ok ? activity.error : null;
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
            <Button size="xs" variant="ghost" onClick={() => setView("chat")}>
              <ChevronLeftIcon aria-hidden />
              Chat
            </Button>
            <h3 className="text-sm font-medium">
              {view === "activity" ? "Activity" : "Watched repos"}
            </h3>
          </div>
          {actionError ? (
            <div className="shrink-0 px-3 pt-2">
              <Alert variant="error">
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {view === "activity" ? (
              activityError ? (
                <div className="p-3">
                  <Alert variant="error">
                    <AlertDescription>{activityError}</AlertDescription>
                  </Alert>
                </div>
              ) : (
                <PilotActivityView activity={activityValue} />
              )
            ) : (
              <PilotRepoList
                repos={value.repos}
                preferredRepoKey={repoForPath(value.repos, projectRoot)}
                pendingRepo={pendingRepo}
                onSetPaused={(repo: PilotRepo, paused) =>
                  void change(repo.key, () =>
                    (paused ? bridge.pause : bridge.resume)({ repo: repo.key }),
                  )
                }
              />
            )}
          </div>
        </div>
      );
    }
    if (!chat.canChat) {
      return (
        <CenteredState>
          <Notice title="Update Pilot to chat">
            This version of Pilot has no chat. Run its install command again from an updated Pilot
            checkout.
          </Notice>
        </CenteredState>
      );
    }
    // At most one action row and one status line, by priority.
    const line = pilotStatusLine({
      error:
        install.error ?? actionError ?? chat.threadError ?? (chat.unreachable ? UNREACHABLE : null),
      status: value,
      watch,
      pluginInstalled: install.status?.state !== "not-installed",
      installedVersion: installAction(install.status) ? null : install.installed,
      selftest: selftestRun,
    });
    const notices = [
      confirmUninstall ? (
        <UninstallRow key="uninstall" install={install} onDone={() => setConfirmUninstall(false)} />
      ) : installAction(install.status) ? (
        <InstallRow key="install" install={install} />
      ) : null,
      line ? (
        <ThreadNotice
          key="status"
          tone={line.kind === "error" ? "error" : line.kind === "on-hold" ? "warning" : "muted"}
          action={
            line.kind === "on-hold" && bridge.selftest ? (
              <Button
                size="xs"
                variant="outline"
                disabled={selftestRun === "running"}
                onClick={() => void runSelftest()}
              >
                {selftestRun === "running" ? "Running…" : "Run self-test"}
              </Button>
            ) : null
          }
        >
          {line.text}
        </ThreadNotice>
      ) : null,
    ].filter(Boolean);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {notices.length > 0 ? (
          <div className="flex shrink-0 flex-col border-b border-border">{notices}</div>
        ) : null}
        <PilotThread
          messages={messages}
          pending={pending}
          askError={askError}
          active={active}
          timestampFormat={timestampFormat}
          busy={busy}
          errors={nudgeErrors}
          defaultEngine={defaultEngine ?? "claude"}
          sentMayBeUnseen={
            unread >
            messages.filter((message) => message.kind === "nudge" && message.state === "new").length
          }
          empty={
            <Notice title="Nothing to remind you of">
              {emptyThreadText(watch, value.sessions)}
            </Notice>
          }
          onAct={(message, action) => void actOnNudge(message, action)}
          onCancelAsk={cancelAsk}
          onSeen={markSeen}
        />
        <Composer
          draft={draft}
          disabled={false}
          asking={pending !== null}
          engine={
            chosenEngine ? (
              <PilotEngineMenu
                settings={settings}
                chosen={chosenEngine}
                onChoose={chooseNextEngine}
              />
            ) : null
          }
          onDraftChange={setDraft}
          onSend={() => void send()}
        />
      </div>
    );
  })();

  return frame(heading, body);
}

const stateAfter = (action: PilotNudgeAction): PilotMessage["state"] =>
  action === "send"
    ? "sent"
    : action === "dismiss"
      ? "dismissed"
      : action === "useful"
        ? "useful"
        : action === "not_useful"
          ? "not_useful"
          : "seen";

/** Pilot in the docked tool frame beside the chat, like Pages and Conversation tools. */
export function PilotPanel({
  active,
  inline,
  onClose,
  tools,
  ...content
}: {
  readonly active: boolean;
  readonly inline: boolean;
  readonly onClose: () => void;
  readonly tools?: ReactNode;
  readonly projectRoot: string | null;
  readonly timestampFormat: TimestampFormat;
}) {
  const bridge = window.desktopBridge?.pilot;
  const panel = (heading: ReactNode, body: ReactNode) => (
    <ConversationToolsPanel
      active={active}
      inline={inline}
      onClose={onClose}
      tools={tools}
      title="Pilot"
      name="Pilot"
      widthStorageKey="starkcode:pilot-panel-width"
      heading={heading}
    >
      {body}
    </ConversationToolsPanel>
  );
  return bridge ? (
    <PilotContent bridge={bridge} active={active} frame={panel} {...content} />
  ) : (
    panel(null, null)
  );
}
