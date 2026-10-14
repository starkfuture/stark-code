import type {
  ProviderInstanceId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@starkfuture/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
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
  readonly onBackToChat: () => void;
}) {
  const [ended, setEnded] = useState(false);
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const restart = useAtomCommand(terminalEnvironment.restart, "restart native agent shell");
  const terminalId = nativeAgentTerminalId(props.providerInstanceId);
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
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={props.onBackToChat}>
          Back to chat
        </Button>
      </div>
      <div className="min-h-0 flex-1" data-thread-terminal-drawer>
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
          focusRequestId={1}
          autoFocus
          visible
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
