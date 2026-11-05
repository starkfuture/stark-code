import type {
  LookoutActivity,
  LookoutBridge,
  LookoutFindings,
  LookoutRepo,
  LookoutResponse,
  LookoutStatus,
  TimestampFormat,
} from "@starkfuture/contracts";
import { ChevronDownIcon, PauseIcon, PlayIcon, ScanEyeIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LookoutActivityView, LookoutRepoList } from "./LookoutActivity";
import { LookoutFindingList, type LookoutDecide } from "./LookoutFindings";
import {
  WATCH_STATE_LABELS,
  budgetLabel,
  lookoutWatchState,
  orderFindings,
  repoForPath,
  repositoriesLabel,
  type LookoutWatchState,
} from "./lookout.logic";

/** Lookout state changes slowly; poll only while the panel is open and visible. */
export const LOOKOUT_POLL_INTERVAL_MS = 5000;
const VIEW_KEY = "starkcode:lookout-view";
type LookoutView = "findings" | "activity" | "repos";

function initialView(): LookoutView {
  try {
    const stored = window.localStorage.getItem(VIEW_KEY);
    return stored === "activity" || stored === "repos" ? stored : "findings";
  } catch {
    return "findings";
  }
}

const DOT_CLASS: Record<LookoutWatchState, string> = {
  watching: "bg-success",
  paused: "bg-warning",
  "not-running": "bg-muted-foreground",
  "not-installed": "bg-muted-foreground",
  unknown: "bg-muted-foreground/50",
};

const UNREACHABLE = "Could not reach Lookout. Try again.";

type Response<T> = LookoutResponse<T> | null;

/** Status, findings and (on its tab) activity, refreshed on open, on a timer and after actions. */
function useLookoutData(
  bridge: LookoutBridge,
  active: boolean,
  view: LookoutView,
  showClosed: boolean,
) {
  const [status, setStatus] = useState<Response<LookoutStatus>>(null);
  const [findings, setFindings] = useState<Response<LookoutFindings>>(null);
  const [activity, setActivity] = useState<Response<LookoutActivity>>(null);
  const [unreachable, setUnreachable] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    inFlight.current = true;
    try {
      const nextStatus = await bridge.status();
      if (current !== generation.current) return;
      setStatus(nextStatus);
      setUnreachable(false);
      // Not installed or failing: the status already says why; ask nothing else.
      if (!nextStatus.installed || !nextStatus.ok) return;
      const [nextFindings, nextActivity] = await Promise.all([
        bridge.findings(showClosed ? { all: true } : {}),
        view === "activity" ? bridge.activity({ limit: 50 }) : null,
      ]);
      if (current !== generation.current) return;
      setFindings(nextFindings);
      if (nextActivity) setActivity(nextActivity);
    } catch {
      if (current === generation.current) setUnreachable(true);
    } finally {
      if (current === generation.current) inFlight.current = false;
    }
  }, [bridge, showClosed, view]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const installed = status?.installed ?? null;
  useEffect(() => {
    // Without Lookout installed, the check on open is all; "Check again" asks once more.
    if (!active || installed === false) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !inFlight.current) void refresh();
    }, LOOKOUT_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, installed, refresh]);

  return { status, findings, activity, unreachable, refresh };
}

function StatusDot({ state }: { state: LookoutWatchState }) {
  return (
    <span className="flex items-center gap-1.5 text-sm font-medium">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[state])} />
      {WATCH_STATE_LABELS[state]}
    </span>
  );
}

function CenteredState({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>;
}

function NotInstalled({ launcher, onCheck }: { launcher: string; onCheck: () => void }) {
  return (
    <CenteredState>
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ScanEyeIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>Lookout isn't installed</EmptyTitle>
          <EmptyDescription>
            Lookout watches your Claude Code sessions and speaks up only when it has evidence.
            Install it once from a Lookout checkout:
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <code className="w-full rounded-md bg-muted px-2 py-1.5 text-left font-mono text-xs break-all select-all">
            &lt;path-to-lookout-checkout&gt;/scripts/lookout install
          </code>
          <p className="text-xs text-muted-foreground break-all">Stark Code looks for {launcher}</p>
          <Button size="xs" variant="outline" onClick={onCheck}>
            Check again
          </Button>
        </EmptyContent>
      </Empty>
    </CenteredState>
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

/** The panel's body: what Lookout is doing, what it found, and the way to act on it. */
export function LookoutContent({
  bridge,
  active,
  projectRoot,
  timestampFormat,
  onQuote,
}: {
  bridge: LookoutBridge;
  active: boolean;
  /** The conversation's folder; its repository's findings come first. */
  projectRoot: string | null;
  timestampFormat: TimestampFormat;
  onQuote?: ((text: string, label: string) => boolean) | undefined;
}) {
  const [view, setView] = useState(initialView);
  const [showClosed, setShowClosed] = useState(false);
  const { status, findings, activity, unreachable, refresh } = useLookoutData(
    bridge,
    active,
    view,
    showClosed,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const chooseView = (next: string | undefined) => {
    if (next !== "findings" && next !== "activity" && next !== "repos") return;
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* Remembering the tab is optional. */
    }
  };

  /** Runs one change, shows Lookout's own error if it refused, then refreshes. */
  const act = async (key: string, call: () => Promise<LookoutResponse<unknown>>) => {
    setPending(key);
    setActionError(null);
    let done = false;
    try {
      const result = await call();
      if (!result.installed) setActionError("Lookout is no longer installed.");
      else if (!result.ok) setActionError(result.error);
      else done = true;
    } catch {
      setActionError(UNREACHABLE);
    } finally {
      setPending(null);
      void refresh();
    }
    return done;
  };
  const decide: LookoutDecide = (input) => act(input.ref, () => bridge.decide(input));
  const setRepoPaused = (repo: LookoutRepo, paused: boolean) =>
    void act(repo.key, () => (paused ? bridge.pause : bridge.resume)({ repo: repo.key }));

  if (status === null) {
    return (
      <CenteredState>
        {unreachable ? (
          <Notice title="Lookout did not answer">{UNREACHABLE}</Notice>
        ) : (
          <Notice title="Checking Lookout">One moment.</Notice>
        )}
      </CenteredState>
    );
  }
  if (!status.installed)
    return <NotInstalled launcher={status.launcher} onCheck={() => void refresh()} />;
  if (!status.ok) {
    return (
      <div className="p-3">
        <Alert variant="error">
          <AlertTitle>Lookout did not answer</AlertTitle>
          <AlertDescription>{status.error}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => void refresh()}>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  }

  const state = status.value;
  const watch = lookoutWatchState(status);
  const preferredRepoKey = repoForPath(state.repos, projectRoot);
  const findingList =
    findings?.installed && findings.ok
      ? orderFindings(findings.value.findings, preferredRepoKey)
      : [];
  const findingsError = findings?.installed && !findings.ok ? findings.error : null;
  const activityValue = activity?.installed && activity.ok ? activity.value : null;
  const activityError = activity?.installed && !activity.ok ? activity.error : null;
  const openCount = state.repos.reduce((total, repo) => total + repo.openFindings, 0);
  const pausing = pending === "all";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <StatusDot state={watch} />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {repositoriesLabel(state.repos.length)} · {budgetLabel(state.budget)}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pausing}
                  aria-label={state.paused ? "Resume Lookout" : "Pause Lookout"}
                  onClick={() =>
                    void act("all", () => (state.paused ? bridge.resume({}) : bridge.pause({})))
                  }
                >
                  {pausing ? (
                    <Spinner aria-hidden />
                  ) : state.paused ? (
                    <PlayIcon aria-hidden />
                  ) : (
                    <PauseIcon aria-hidden />
                  )}
                  {state.paused ? "Resume" : "Pause"}
                </Button>
              }
            />
            <TooltipPopup side="bottom" positionMethod="fixed">
              {state.paused
                ? "Resume reviews in every repository"
                : "Pause reviews in every repository. Events are still recorded."}
            </TooltipPopup>
          </Tooltip>
        </div>
        {watch === "not-running" ? (
          <p className="text-xs text-muted-foreground">
            Lookout starts again with your next Claude Code session.
          </p>
        ) : null}
      </div>
      {!state.selftest.ok || state.budget.availableCents <= 0 || actionError || unreachable ? (
        <div className="flex shrink-0 flex-col gap-2 px-3 pt-2">
          {!state.selftest.ok ? (
            <Alert variant="warning">
              <AlertTitle>Reviews are on hold</AlertTitle>
              <AlertDescription>
                Lookout's isolation self-test failed: {state.selftest.reason}
              </AlertDescription>
            </Alert>
          ) : null}
          {state.budget.availableCents <= 0 ? (
            <Alert variant="info">
              <AlertTitle>Review budget used up</AlertTitle>
              <AlertDescription>
                Reviews continue when the {state.budget.windowHours} h window frees budget.
              </AlertDescription>
            </Alert>
          ) : null}
          {actionError || unreachable ? (
            <Alert variant="error">
              <AlertDescription>{actionError ?? UNREACHABLE}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <ToggleGroup
          aria-label="Lookout view"
          variant="segmented"
          value={[view]}
          onValueChange={(next) => chooseView(next[0])}
        >
          <Toggle value="findings">Findings{openCount > 0 ? ` ${openCount}` : ""}</Toggle>
          <Toggle value="activity">Activity</Toggle>
          <Toggle value="repos">Repos</Toggle>
        </ToggleGroup>
        {view === "findings" ? (
          <Menu>
            <MenuTrigger
              render={
                <Button size="xs" variant="ghost" aria-label="Choose which findings to show" />
              }
            >
              {showClosed ? "All" : "Open"}
              <ChevronDownIcon aria-hidden />
            </MenuTrigger>
            <MenuPopup align="end" positionMethod="fixed">
              <MenuRadioGroup
                value={showClosed ? "all" : "open"}
                onValueChange={(value) => setShowClosed(value === "all")}
              >
                <MenuRadioItem closeOnClick value="open">
                  Open findings
                  <MenuRadioItemIndicator />
                </MenuRadioItem>
                <MenuRadioItem closeOnClick value="all">
                  All findings, including closed
                  <MenuRadioItemIndicator />
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1" scrollbarGutter>
        <div className="flex flex-col px-1 pb-3">
          {view === "findings" ? (
            state.repos.length === 0 ? (
              <Notice title="No repositories yet">
                Lookout starts watching a repository the first time a Claude Code session changes
                code in it.
              </Notice>
            ) : findingsError ? (
              <Alert variant="error">
                <AlertDescription>{findingsError}</AlertDescription>
              </Alert>
            ) : findings === null ? null : findingList.length === 0 ? (
              <Notice title={showClosed ? "No findings yet" : "Nothing to report"}>
                Watching {repositoriesLabel(state.repos.length)}. Nothing needs your attention.
              </Notice>
            ) : (
              <LookoutFindingList
                findings={findingList}
                preferredRepoKey={preferredRepoKey}
                timestampFormat={timestampFormat}
                pendingRef={pending}
                onDecide={decide}
                onQuote={onQuote}
              />
            )
          ) : view === "activity" ? (
            activityError ? (
              <Alert variant="error">
                <AlertDescription>{activityError}</AlertDescription>
              </Alert>
            ) : (
              <LookoutActivityView activity={activityValue} />
            )
          ) : state.repos.length === 0 ? (
            <Notice title="No repositories yet">
              Lookout starts watching a repository the first time a Claude Code session changes code
              in it.
            </Notice>
          ) : (
            <LookoutRepoList
              repos={state.repos}
              preferredRepoKey={preferredRepoKey}
              pendingRepo={pending}
              onSetPaused={setRepoPaused}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** Lookout in the docked tool frame beside the chat, like Pages and Conversation tools. */
export function LookoutPanel({
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
  readonly onQuote?: ((text: string, label: string) => boolean) | undefined;
}) {
  const bridge = window.desktopBridge?.lookout;
  return (
    <ConversationToolsPanel
      active={active}
      inline={inline}
      onClose={onClose}
      tools={tools}
      title="Lookout"
      name="Lookout"
      widthStorageKey="starkcode:lookout-panel-width"
    >
      {bridge ? <LookoutContent bridge={bridge} active={active} {...content} /> : null}
    </ConversationToolsPanel>
  );
}
