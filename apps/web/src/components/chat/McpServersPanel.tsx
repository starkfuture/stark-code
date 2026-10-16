import { useEffect, useRef, useState } from "react";
import {
  isExpectedMcpCallback,
  type EnvironmentId,
  type McpServersListInput,
  type McpServersReloadResult,
  type McpServerStatusEntry,
  type McpServerSignInStart,
  type ScopedThreadRef,
} from "@starkfuture/contracts";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentPresentation } from "../../state/presentation";
import { isElectron } from "../../env";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  isLocalMcpDesktopTarget,
  mcpConnectionSummary,
  mcpDisplayText,
  MCP_SOURCE_LABELS,
  MCP_STATUS_LABELS,
  safeMcpBrowserTarget,
} from "./mcpServerPresentation";

type ServerAction = "reconnect" | "enable" | "disable" | "sign-in" | "sign-out";
export function McpServerRows({
  servers,
  canReconnect,
  canManage,
  busy,
  waitingName,
  onAction,
}: {
  servers: ReadonlyArray<McpServerStatusEntry>;
  canReconnect: boolean;
  canManage: boolean;
  busy: boolean;
  waitingName?: string | undefined;
  onAction: (server: McpServerStatusEntry, action: ServerAction) => void;
}) {
  return (
    <div className="space-y-3">
      {servers.map((server) => (
        <section key={server.name} className="rounded-xl border p-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="min-w-0 break-all font-medium">{mcpDisplayText(server.name, 256)}</h4>
            <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs">
              {server.source
                ? MCP_SOURCE_LABELS[server.source]
                : server.scope
                  ? mcpDisplayText(server.scope, 100)
                  : "Provider"}
              {server.pluginName ? ` ${mcpDisplayText(server.pluginName, 100)}` : ""}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {waitingName === server.name
              ? "Waiting for sign-in…"
              : MCP_STATUS_LABELS[server.status]}
            {server.locked ? " · Locked app server" : ""} · {server.tools.length} tools
          </p>
          {server.error ? (
            <p className="mt-2 break-all text-xs text-destructive">
              {mcpDisplayText(server.error)}
            </p>
          ) : null}
          {server.tools.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs">Tools</summary>
              <ul className="mt-2 space-y-2">
                {server.tools.map((tool) => (
                  <li key={tool.name} className="rounded bg-muted/50 p-2">
                    <p className="break-all font-mono text-xs">{mcpDisplayText(tool.name, 256)}</p>
                    {tool.description ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {mcpDisplayText(tool.description)}
                      </p>
                    ) : null}
                    <div className="mt-1 flex flex-wrap gap-1 text-3xs">
                      {tool.readOnly !== undefined ? (
                        <span className="rounded border px-1">
                          {tool.readOnly ? "Read-only" : "Read/write"}
                        </span>
                      ) : null}
                      {tool.destructive !== undefined ? (
                        <span className="rounded border px-1">
                          {tool.destructive ? "Destructive" : "Non-destructive"}
                        </span>
                      ) : null}
                      {tool.openWorld !== undefined ? (
                        <span className="rounded border px-1">
                          {tool.openWorld ? "Open-world" : "Closed-world"}
                        </span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {!server.locked ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {canReconnect && (server.status === "failed" || server.status === "connecting") ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (!busy && canReconnect) onAction(server, "reconnect");
                  }}
                >
                  Reconnect
                </Button>
              ) : null}
              {canManage ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (!busy && canManage)
                      onAction(server, server.status === "disabled" ? "enable" : "disable");
                  }}
                >
                  {server.status === "disabled"
                    ? "Enable"
                    : server.source === "codex"
                      ? "Disable in Codex settings"
                      : "Disable for this project"}
                </Button>
              ) : null}
              {canManage && server.status === "needs-auth" && waitingName !== server.name ? (
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => {
                    if (!busy && canManage) onAction(server, "sign-in");
                  }}
                >
                  Sign in
                </Button>
              ) : null}
              {canManage && server.authKind === "oauth" && server.canSignOut ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (!busy && canManage) onAction(server, "sign-out");
                  }}
                >
                  Sign out
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

type McpServersPanelProps = {
  environmentId: EnvironmentId;
  target: McpServersListInput;
};

export function McpServersPanel(props: McpServersPanelProps) {
  // A held confirmation and OAuth callback belong to exactly one target. A late
  // action from the previous target must never populate the newly selected panel.
  const targetKey = JSON.stringify([
    props.environmentId,
    props.target.threadId,
    props.target.providerInstanceId,
    props.target.projectId,
  ]);
  return <McpServersPanelTarget key={targetKey} {...props} />;
}

function McpServersPanelTarget({ environmentId, target }: McpServersPanelProps) {
  const query = useEnvironmentQuery(serverEnvironment.mcpServers({ environmentId, input: target }));
  const reload = useAtomCommand(serverEnvironment.reloadMcpServers, { reportFailure: false });
  const reconnect = useAtomCommand(serverEnvironment.reconnectMcpServer, { reportFailure: false });
  const toggle = useAtomCommand(serverEnvironment.setMcpServerEnabled, { reportFailure: false });
  const signIn = useAtomCommand(serverEnvironment.signInMcpServer, { reportFailure: false });
  const signOut = useAtomCommand(serverEnvironment.signOutMcpServer, { reportFailure: false });
  const submit = useAtomCommand(serverEnvironment.submitMcpServerCallback, {
    reportFailure: false,
  });
  const { presentation } = useEnvironmentPresentation(environmentId);
  const desktopHost = presentation
    ? isLocalMcpDesktopTarget(isElectron, presentation.entry.target)
    : false;
  const canReconnect = useEnvironmentScope(environmentId, "orchestration:operate") && desktopHost;
  const canReload =
    target.threadId !== undefined &&
    canReconnect &&
    query.data?.live === true &&
    query.data.canReload === true;
  const canManage = useEnvironmentScope(environmentId, "providers:manage") && desktopHost;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadResult, setReloadResult] = useState<McpServersReloadResult | null>(null);
  const [pending, setPending] = useState<{
    name: string;
    flow: McpServerSignInStart;
    opened: boolean;
    startedAt: number;
  } | null>(null);
  const [callback, setCallback] = useState("");
  const refresh = useRef(query.refresh);
  refresh.current = query.refresh;
  useEffect(() => {
    refresh.current();
    const timer = window.setInterval(() => refresh.current(), 2_000);
    return () => window.clearInterval(timer);
  }, [environmentId, target.threadId, target.providerInstanceId, target.projectId]);
  useEffect(() => {
    if (!pending) return;
    if (
      query.data?.servers.some(
        (server) => server.name === pending.name && server.status === "connected",
      )
    ) {
      setPending(null);
      setCallback("");
      return;
    }
    const timer = window.setTimeout(
      () => {
        setPending(null);
        setCallback("");
        setError("Sign-in timed out. Start again when you are ready.");
      },
      Math.max(0, 300_000 - (Date.now() - pending.startedAt)),
    );
    return () => window.clearTimeout(timer);
  }, [pending, query.data]);
  const run = async (operation: () => Promise<{ readonly _tag: string }>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setReloadResult(null);
    try {
      const result = await operation();
      if (result._tag === "Failure") setError("The MCP action failed. Refresh and try again.");
      else refresh.current();
    } catch {
      setError("The MCP action failed. Refresh and try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const reloadServers = async (force = false) => {
    if (
      !canReload ||
      busyRef.current ||
      (!force && reloadResult?.status === "confirmation-required") ||
      (force && reloadResult?.status !== "confirmation-required")
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setReloadResult(null);
    try {
      const result = await reload({
        environmentId,
        input: { ...target, ...(force ? { force: true } : {}) },
      });
      if (result._tag === "Failure") {
        setError("Could not reload MCP servers. Refresh status and try again.");
      } else {
        setReloadResult(result.value);
      }
    } catch {
      setError("Could not reload MCP servers. Refresh status and try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
      refresh.current();
    }
  };
  const action = (server: McpServerStatusEntry, kind: ServerAction) => {
    if (server.locked || busy) return;
    const input = { ...target, name: server.name };
    if (kind === "reconnect" && canReconnect) {
      void run(() => reconnect({ environmentId, input }));
      return;
    }
    if (!canManage) return;
    if (kind === "enable" || kind === "disable") {
      void run(() => toggle({ environmentId, input: { ...input, enabled: kind === "enable" } }));
      return;
    }
    if (kind === "sign-out") {
      void run(() => signOut({ environmentId, input }));
      return;
    }
    if (kind === "sign-in")
      void run(async () => {
        const result = await signIn({ environmentId, input });
        if (result._tag === "Success") {
          const flow = result.value;
          if (flow.url && !safeMcpBrowserTarget(flow.url)) {
            setError("The server returned an unsafe sign-in URL.");
            return result;
          }
          if (!flow.completed) {
            setPending({
              name: server.name,
              flow,
              opened: flow.browserOpened === true,
              startedAt: Date.now(),
            });
            setCallback("");
          }
        }
        return result;
      });
  };
  const browser = pending?.flow.url ? safeMcpBrowserTarget(pending.flow.url) : null;
  const waitingServer = query.data?.servers.find((server) => server.name === pending?.name);
  const canPaste =
    pending?.opened && pending.flow.callbackExpected && waitingServer?.canSubmitCallback === true;
  return (
    <section className="space-y-4 text-sm" aria-label="MCP servers">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">MCP servers</h3>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" disabled={busy} onClick={() => refresh.current()}>
            Refresh status
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!canReload || busy || reloadResult?.status === "confirmation-required"}
            onClick={() => void reloadServers()}
          >
            Reload MCPs
          </Button>
        </div>
      </div>
      {!desktopHost ? (
        <p className="text-xs text-muted-foreground">
          Status only. Manage MCP servers from the desktop host.
        </p>
      ) : null}
      {target.threadId === undefined ? (
        <p className="text-xs text-muted-foreground">
          Settings inspects project connections. Open the conversation's Tools → MCP panel to reload
          its connections.
        </p>
      ) : null}
      {error || query.error ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? "Could not read MCP status. Refresh and try again."}
        </p>
      ) : null}
      {reloadResult?.status === "confirmation-required" ? (
        <div className="space-y-3 rounded-xl border p-3 text-xs" role="status">
          <p>
            Reloading may invalidate the agent's prompt cache and increase token usage on the next
            turn. No servers have been reloaded yet.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!canReload || busy}
              onClick={() => void reloadServers(true)}
            >
              Reload anyway
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setReloadResult(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : reloadResult?.status === "reloaded" ? (
        <div className="space-y-1 text-xs text-muted-foreground" role="status">
          {reloadResult.failedServers.length > 0 || (reloadResult.pluginErrors ?? 0) > 0 ? (
            <>
              <p>MCP reload reported issues.</p>
              {reloadResult.failedServers.length > 0 ? (
                <p>
                  Failed servers:{" "}
                  {reloadResult.failedServers.map((name) => mcpDisplayText(name, 256)).join(", ")}.
                </p>
              ) : null}
              {(reloadResult.pluginErrors ?? 0) > 0 ? (
                <p>
                  {reloadResult.pluginErrors} plugin{" "}
                  {reloadResult.pluginErrors === 1 ? "error" : "errors"} reported.
                </p>
              ) : null}
            </>
          ) : (
            <p>MCP reload requested. Connection status updates below.</p>
          )}
        </div>
      ) : null}
      {pending ? (
        <div className="space-y-3 rounded-xl border p-3 text-xs">
          <p>Waiting for sign-in to {mcpDisplayText(pending.name, 256)}…</p>
          {browser ? (
            <>
              <p>Opens {browser.host} in your browser.</p>
              <Button
                size="xs"
                onClick={() => {
                  if (!canManage) return;
                  void ensureLocalApi()
                    .shell.openExternal(browser.url)
                    .then(() => {
                      setPending((current) => (current ? { ...current, opened: true } : null));
                      refresh.current();
                    })
                    .catch(() => setError("Could not open the system browser. Try again."));
                }}
              >
                Open {browser.host} in browser
              </Button>
            </>
          ) : null}
          {canPaste ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!canManage || !isExpectedMcpCallback(callback, pending.flow)) {
                  setError("Paste the matching localhost callback address from this sign-in flow.");
                  return;
                }
                void run(async () => {
                  const answer = await submit({
                    environmentId,
                    input: { ...target, name: pending.name, url: callback },
                  });
                  if (answer._tag === "Success") setCallback("");
                  return answer;
                });
              }}
            >
              <label className="flex flex-col gap-2">
                If the redirect did not finish, paste the address from your browser
                <input
                  aria-label="Browser callback address"
                  autoComplete="off"
                  spellCheck={false}
                  className="rounded border bg-background px-2 py-1"
                  value={callback}
                  onChange={(event) => setCallback(event.target.value)}
                />
              </label>
              <Button size="xs" disabled={busy || !callback.trim()} type="submit">
                Complete sign-in
              </Button>
            </form>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setPending(null);
              setCallback("");
            }}
          >
            Cancel waiting
          </Button>
        </div>
      ) : null}
      {query.isPending && !query.data ? (
        <p className="text-xs text-muted-foreground">Reading server status…</p>
      ) : null}
      {query.data && !query.data.live ? (
        <p className="text-xs text-muted-foreground">
          Send a message to start this thread's MCP session.
        </p>
      ) : null}
      {query.data?.servers.length === 0 ? (
        <p className="text-xs text-muted-foreground">No MCP servers reported.</p>
      ) : null}
      {canReconnect &&
      query.data?.servers.some((server) => server.status === "failed" && !server.locked) ? (
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => {
            void run(async () => {
              for (const server of query.data?.servers ?? []) {
                if (server.status !== "failed" || server.locked) continue;
                const answer = await reconnect({
                  environmentId,
                  input: { ...target, name: server.name },
                });
                if (answer._tag === "Failure") return answer;
              }
              return { _tag: "Success" };
            });
          }}
        >
          Reconnect all failed
        </Button>
      ) : null}
      <McpServerRows
        servers={query.data?.servers ?? []}
        canReconnect={canReconnect}
        canManage={canManage}
        busy={busy}
        waitingName={pending?.name}
        onAction={action}
      />
    </section>
  );
}

export function McpServersChip({ threadRef }: { threadRef: ScopedThreadRef }) {
  const [open, setOpen] = useState(false);
  const query = useEnvironmentQuery(
    serverEnvironment.mcpServers({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const refresh = useRef(query.refresh);
  refresh.current = query.refresh;
  useEffect(() => {
    refresh.current();
    const timer = window.setInterval(() => refresh.current(), 10_000);
    return () => window.clearInterval(timer);
  }, [threadRef.environmentId, threadRef.threadId]);
  const summary = mcpConnectionSummary(query.data?.servers ?? []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            aria-label={`MCP servers: ${summary.connected} connected${summary.warning ? ", needs attention" : ""}`}
          >
            MCP {summary.connected}
            {summary.warning ? (
              <span aria-hidden className="size-1.5 rounded-full bg-warning" />
            ) : null}
          </Button>
        }
      />
      <PopoverPopup side="bottom" align="end" width="auto">
        <div className="max-h-[75vh] w-[min(34rem,85vw)] overflow-auto p-4">
          <McpServersPanel
            key={`${threadRef.environmentId}:${threadRef.threadId}`}
            environmentId={threadRef.environmentId}
            target={{ threadId: threadRef.threadId }}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
