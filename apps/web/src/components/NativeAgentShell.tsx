import { Dialog } from "@base-ui/react/dialog";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import type {
  ProviderInstanceId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@starkfuture/contracts";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { useNativeReplies } from "../state/nativeReplies";
import { ResponseVisualPanel } from "./chat/ResponseVisualPanel";
import { TerminalViewport } from "./ThreadTerminalDrawer";
import { Button } from "./ui/button";
import { useAtomCommand } from "../state/use-atom-command";
import { terminalEnvironment } from "../state/terminal";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../appearanceFonts";

export function nativeAgentTerminalId(instanceId: ProviderInstanceId): string {
  return `native-agent-${instanceId}`;
}

/** The terminal stays owned by the server when its view is hidden or the thread changes. */
export function NativeAgentShell(props: {
  readonly threadRef: ScopedThreadRef;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly focusRequestId?: number;
  readonly onBackToChat: () => void;
}) {
  const [ended, setEnded] = useState(false);
  const [view, setView] = useState<"terminal" | "reader" | "both">("terminal");
  const [expanded, setExpanded] = useState(false);
  const [readerVisited, setReaderVisited] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const chooseView = (next: typeof view) => {
    setView(next);
    if (next !== "terminal") setReaderVisited(true);
    setResizeEpoch((epoch) => epoch + 1);
  };
  const expand = (next: boolean) => {
    setExpanded(next);
    setResizeEpoch((epoch) => epoch + 1);
  };
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const restart = useAtomCommand(terminalEnvironment.restart, "restart native agent shell");
  const terminalId = nativeAgentTerminalId(props.providerInstanceId);
  const replies = useNativeReplies(props.threadRef, readerVisited, terminalId);
  const label = props.driver === "codex" ? "Codex" : "Claude";
  return (
    <Dialog.Root
      open
      modal={expanded}
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (open || !expanded) return;
        // Escape remains a real CLI key when focus is inside the terminal.
        if (
          details.event.target instanceof Element &&
          details.event.target.closest("[data-thread-terminal-drawer]")
        )
          return;
        expand(false);
        expandButton.current?.focus({ preventScroll: true });
      }}
    >
      <div ref={setPortalHost} className="contents" />
      {portalHost ? (
        <Dialog.Portal keepMounted container={portalHost} className="contents">
          <Dialog.Popup
            role={expanded ? "dialog" : "region"}
            aria-modal={expanded || undefined}
            initialFocus={false}
            finalFocus={false}
            className={cn(
              "@container/native-shell flex min-h-0 min-w-0 flex-col bg-background outline-none",
              expanded ? "fixed inset-0 z-[60]" : "relative z-[45] h-full",
            )}
            aria-label={`${label} native shell`}
            data-native-shell-expanded={expanded ? "true" : "false"}
          >
            <div
              className={cn(
                "flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2",
                expanded &&
                  isElectron &&
                  "drag-region min-h-(--workspace-topbar-height) pl-(--workspace-controls-left) wco:pr-(--workspace-native-controls-inset)",
              )}
            >
              <div>
                <div className="text-sm font-medium">{label} · Native shell</div>
                <div className="text-xs text-muted-foreground">
                  All CLI commands, plugins, and skills. Shares files with chat; uses its own
                  conversation.
                  {props.driver === "codex"
                    ? " Read-only by default; approve access inside Codex when needed."
                    : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  ref={expandButton}
                  variant="ghost"
                  size="icon-sm"
                  aria-label={expanded ? "Return shell to workspace" : "Fill window"}
                  onClick={() => expand(!expanded)}
                >
                  {expanded ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
                </Button>
                <Button variant="ghost" size="sm" onClick={props.onBackToChat}>
                  Back to chat
                </Button>
              </div>
            </div>
            <div
              className="flex shrink-0 flex-wrap gap-1 border-b px-3 py-2"
              aria-label="Native shell view"
            >
              <Button
                variant={view === "terminal" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={view === "terminal"}
                onClick={() => chooseView("terminal")}
              >
                Terminal
              </Button>
              <Button
                variant={view === "reader" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={view === "reader"}
                onClick={() => chooseView("reader")}
              >
                Reader
              </Button>
              <Button
                variant={view === "both" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={view === "both"}
                onClick={() => chooseView("both")}
              >
                Both
              </Button>
              {view === "both" ? (
                <span className="self-center px-2 text-xs text-muted-foreground">
                  The same session. Reading uses no extra tokens.
                </span>
              ) : null}
            </div>
            <div
              className="flex min-h-0 min-w-0 flex-1 flex-col @min-[52rem]/native-shell:flex-row"
              data-native-shell-layout={view}
            >
              <div
                className={view !== "reader" ? "min-h-0 min-w-0 flex-1" : "hidden"}
                data-thread-terminal-drawer
                aria-hidden={view === "reader"}
              >
                <TerminalViewport
                  advancedTypography={advancedTypography}
                  threadRef={props.threadRef}
                  threadId={props.threadRef.threadId}
                  terminalId={terminalId}
                  terminalLabel={`${label} native shell`}
                  cwd={props.cwd}
                  worktreePath={props.worktreePath}
                  providerInstanceId={props.providerInstanceId}
                  agentShell
                  onSessionExited={() => setEnded(true)}
                  focusRequestId={props.focusRequestId ?? 1}
                  autoFocus
                  visible={view !== "reader"}
                  resizeEpoch={resizeEpoch}
                  drawerHeight={0}
                  keybindings={props.keybindings}
                />
              </div>
              <div
                className={cn(
                  "min-h-0 min-w-0 flex-1 flex-col",
                  view === "terminal" ? "hidden" : "flex",
                  view === "both" &&
                    "border-t @min-[52rem]/native-shell:border-t-0 @min-[52rem]/native-shell:border-l",
                )}
                aria-hidden={view === "terminal"}
              >
                <>
                  {replies.error ? (
                    <p role="alert" className="px-4 py-2 text-sm text-destructive">
                      {replies.error}
                    </p>
                  ) : null}
                  <ResponseVisualPanel
                    environmentId={props.threadRef.environmentId}
                    threadRef={props.threadRef}
                    cwd={props.worktreePath ?? props.cwd}
                    answers={(replies.data ?? []).map((reply) => ({
                      id: reply.id,
                      text: reply.text,
                      truncated: reply.truncated === true,
                      label: `${reply.provider === "claude" ? "Claude" : "Codex"} · ${reply.text.replace(/\s+/g, " ").slice(0, 90)}`,
                    }))}
                    emptyMessage="Completed replies from new native sessions appear here. Restart a session opened before Reader was added. For Codex, review and approve the capture hook in its terminal when prompted. Interrupted replies may not be captured."
                  />
                </>
              </div>
            </div>
            {ended ? (
              <div className="flex shrink-0 items-center justify-between border-t px-4 py-2">
                <span className="text-sm text-muted-foreground">
                  The native session has exited.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void restart({
                      environmentId: props.threadRef.environmentId,
                      input: {
                        threadId: props.threadRef.threadId,
                        terminalId,
                        cwd: props.cwd,
                        worktreePath: props.worktreePath,
                        providerInstanceId: props.providerInstanceId,
                        agentShell: true,
                        cols: 100,
                        rows: 30,
                      },
                    }).then((result) => {
                      if (result._tag === "Success") setEnded(false);
                    });
                  }}
                >
                  Start another session
                </Button>
              </div>
            ) : null}
          </Dialog.Popup>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  );
}
