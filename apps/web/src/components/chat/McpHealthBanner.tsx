import type { ScopedThreadRef } from "@starkfuture/contracts";
import { useState } from "react";
import { isElectron } from "../../env";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { McpServersPanel } from "./McpServersPanel";
import { mcpRecoveryMessage } from "./mcpRecoveryPresentation";
import { isLocalMcpDesktopTarget, mcpDisplayText } from "./mcpServerPresentation";
import { useMcpServersQuery } from "./useMcpServersQuery";

type Props = { threadRef: ScopedThreadRef; sessionBusy?: boolean };

export function McpHealthBanner(props: Props) {
  return (
    <McpHealthBannerTarget
      key={`${props.threadRef.environmentId}:${props.threadRef.threadId}`}
      {...props}
    />
  );
}

function McpHealthBannerTarget({ threadRef, sessionBusy = false }: Props) {
  const query = useMcpServersQuery(threadRef.environmentId, { threadId: threadRef.threadId });
  const { presentation } = useEnvironmentPresentation(threadRef.environmentId);
  const hasManagePermission = useEnvironmentScope(threadRef.environmentId, "providers:manage");
  const canManage =
    hasManagePermission &&
    presentation &&
    isLocalMcpDesktopTarget(isElectron, presentation.entry.target);
  const [open, setOpen] = useState(false);
  const [signInName, setSignInName] = useState<string | undefined>();
  const failures =
    query.data?.live && !query.error
      ? query.data.servers.filter(
          (server) => server.status === "needs-auth" || server.status === "failed",
        )
      : [];
  // Keep an explicitly opened sign-in panel alive if the warning resolves during OAuth.
  if (!failures.length && !open) return null;
  return (
    <div className="pointer-events-auto mx-auto max-w-[calc(100%-2rem)] pt-3">
      {failures.length ? (
        <div
          className="space-y-2 rounded-xl border bg-background px-3 py-2 text-xs shadow-sm"
          role="status"
          aria-label="Connector attention"
        >
          {failures.slice(0, 3).map((server) => (
            <div key={server.name} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="min-w-0 flex-1 break-words">
                <span className="font-medium">{mcpDisplayText(server.name, 100)}</span>
                {" · "}
                {mcpRecoveryMessage(server)}
              </p>
              {server.status === "needs-auth" && !server.locked && canManage ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={sessionBusy}
                  aria-label={`Sign in to ${mcpDisplayText(server.name, 100)}`}
                  onClick={() => {
                    if (sessionBusy) return;
                    setSignInName(server.name);
                    setOpen(true);
                  }}
                >
                  Sign in
                </Button>
              ) : null}
            </div>
          ))}
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">
              {failures.length > 3
                ? `${failures.length - 3} more need attention.`
                : sessionBusy
                  ? "Changes wait until this turn finishes."
                  : "Other connections keep running."}
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setSignInName(undefined);
                setOpen(true);
              }}
            >
              Review connections
            </Button>
          </div>
        </div>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSignInName(undefined);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Connections</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <McpServersPanel
              environmentId={threadRef.environmentId}
              target={{ threadId: threadRef.threadId }}
              sessionBusy={sessionBusy}
              initialSignIn={signInName}
            />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
