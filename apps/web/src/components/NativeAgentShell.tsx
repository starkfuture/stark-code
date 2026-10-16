import type {
  ProviderInstanceId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@starkfuture/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
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
  const [view, setView] = useState<"terminal" | "reader">("terminal");
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const restart = useAtomCommand(terminalEnvironment.restart, "restart native agent shell");
  const terminalId = nativeAgentTerminalId(props.providerInstanceId);
  const replies = useNativeReplies(props.threadRef, view === "reader", terminalId);
  const label = props.driver === "codex" ? "Codex" : "Claude";
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label={`${label} native shell`}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
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
        <Button variant="ghost" size="sm" onClick={props.onBackToChat}>
          Back to chat
        </Button>
      </div>
      <div
        className="flex shrink-0 flex-wrap gap-1 border-b px-3 py-2"
        aria-label="Native shell view"
      >
        <Button
          variant={view === "terminal" ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={view === "terminal"}
          onClick={() => setView("terminal")}
        >
          Terminal
        </Button>
        <Button
          variant={view === "reader" ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={view === "reader"}
          onClick={() => setView("reader")}
        >
          Reader
        </Button>
      </div>
      {view === "reader" ? (
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
              label: `${reply.provider === "claude" ? "Claude" : "Codex"} · ${reply.text.replace(/\s+/g, " ").slice(0, 90)}`,
            }))}
            emptyMessage="Completed replies from new native sessions appear here. Restart a session opened before Reader was added. For Codex, review and approve the capture hook in its terminal when prompted. Interrupted replies may not be captured."
          />
        </>
      ) : null}
      <div
        className={view === "terminal" ? "min-h-0 flex-1" : "hidden"}
        data-thread-terminal-drawer
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
          visible={view === "terminal"}
          resizeEpoch={0}
          drawerHeight={0}
          keybindings={props.keybindings}
        />
      </div>
      {ended ? (
        <div className="flex shrink-0 items-center justify-between border-t px-4 py-2">
          <span className="text-sm text-muted-foreground">The native session has exited.</span>
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
    </section>
  );
}
