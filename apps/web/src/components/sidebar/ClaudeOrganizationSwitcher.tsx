import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@starkfuture/client-runtime/state/runtime";
import type { ClaudeAccount, ClaudeAccountsSnapshot, EnvironmentId } from "@starkfuture/contracts";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { claudeAccountsEnvironment } from "../../state/claudeAccounts";
import { useAtomCommand } from "../../state/use-atom-command";
import { ClaudeAI } from "../Icons";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton } from "../ui/sidebar";

interface ClaudeOrganizationSwitcherProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly isConnected: boolean;
  readonly onManage: () => void;
}

function organizationLabel(account: ClaudeAccount) {
  return (
    account.organizationName ||
    account.alias ||
    account.organizationUuid ||
    `Organization ${account.number}`
  );
}

function usageLabel(account: ClaudeAccount) {
  if (
    account.usageStatus !== "ok" ||
    account.usageAgeSeconds === null ||
    account.usageAgeSeconds > 120 ||
    account.windows.length === 0
  )
    return null;
  return account.windows
    .map((window) => `${window.name}: ${Math.round(window.percent)}% used`)
    .join(" · ");
}

/** A saved organization changes the machine's shared login, not one conversation. */
export function ClaudeOrganizationSwitcher(props: ClaudeOrganizationSwitcherProps) {
  return <ClaudeOrganizationSwitcherContent key={props.environmentId} {...props} />;
}

function ClaudeOrganizationSwitcherContent({
  environmentId,
  environmentLabel,
  isConnected,
  onManage,
}: ClaudeOrganizationSwitcherProps) {
  const canRead = useAtomValue(claudeAccountsEnvironment.snapshot.permissionAtom(environmentId));
  const canWrite = useAtomValue(claudeAccountsEnvironment.command.permissionAtom(environmentId));
  const readSnapshot = useAtomCommand(claudeAccountsEnvironment.snapshot, { reportFailure: false });
  const sendCommand = useAtomCommand(claudeAccountsEnvironment.command, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ClaudeAccountsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const lastSuccessfulRefreshAt = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function refresh() {
    if (!canRead || !isConnected || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const result = await readSnapshot({ environmentId, input: undefined });
      if (!mounted.current) return;
      if (result._tag === "Success") {
        lastSuccessfulRefreshAt.current = Date.now();
        setSnapshot(result.value);
        setError(null);
      } else throw squashAtomCommandFailure(result);
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Could not load Claude organizations.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const refreshVisible = useEffectEvent(() => {
    const stale =
      lastSuccessfulRefreshAt.current === null ||
      Date.now() - lastSuccessfulRefreshAt.current >= 60_000;
    if (document.visibilityState === "visible" && (stale || error !== null)) void refresh();
  });
  // The footer is identity, not a generic account launcher: load it before the menu opens.
  useEffect(() => {
    if (!isConnected) {
      lastSuccessfulRefreshAt.current = null;
      return;
    }
    if (!canRead) return;
    refreshVisible();
    document.addEventListener("visibilitychange", refreshVisible);
    return () => document.removeEventListener("visibilitychange", refreshVisible);
  }, [canRead, isConnected]);
  useEffect(() => {
    if (!open || !canRead || !isConnected) return;
    refreshVisible();
    const timer = window.setInterval(refreshVisible, 60_000);
    return () => window.clearInterval(timer);
  }, [open, canRead, isConnected]);

  async function switchOrganization(account: ClaudeAccount) {
    if (
      !canRead ||
      !canWrite ||
      !isConnected ||
      inFlight.current ||
      !snapshot?.available ||
      account.active
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setSwitching(account.number);
    setError(null);
    setNotice(null);
    try {
      const result = await sendCommand({
        environmentId,
        input: {
          action: "switch",
          accountNumber: account.number,
          expectedEmail: account.email,
          expectedOrganizationUuid: account.organizationUuid,
        },
      });
      if (!mounted.current) return;
      if (result._tag === "Success") {
        setSnapshot(result.value);
        const current = result.value.accounts.find((candidate) => candidate.active);
        setNotice(
          current
            ? `Active organization: ${organizationLabel(current)}.`
            : "The active organization could not be confirmed. Refresh to check.",
        );
      } else throw squashAtomCommandFailure(result);
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "Could not switch Claude organizations.");
        // A switch can finish before a later usage read fails. Reconcile once without replaying it.
        try {
          const latest = await readSnapshot({ environmentId, input: undefined });
          if (mounted.current && latest._tag === "Success") setSnapshot(latest.value);
        } catch {
          /* Keep the last known snapshot and the original action failure. */
        }
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setBusy(false);
        setSwitching(null);
      }
    }
  }

  const visibleSnapshot = canRead ? snapshot : null;
  const active = visibleSnapshot?.accounts.find((account) => account.active);
  const groups = new Map<string, ClaudeAccount[]>();
  for (const account of visibleSnapshot?.accounts ?? []) {
    const group = groups.get(account.email) ?? [];
    group.push(account);
    groups.set(account.email, group);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<SidebarMenuButton size="lg" aria-label="Switch Claude organization" />}
      >
        <ClaudeAI />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">
            {active ? organizationLabel(active) : "Claude organizations"}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            Claude organization · {environmentLabel}
          </span>
        </span>
        <ChevronsUpDownIcon />
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        width="md"
        padding="compact"
        aria-label="Claude organizations"
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Claude organizations</h3>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canRead || !isConnected || busy}
              onClick={() => void refresh()}
            >
              {busy && switching === null ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Shared Claude login on {environmentLabel}. Running sessions may need restarting to use
            the new organization.
          </p>
          {!isConnected ? (
            <p role="status" className="text-xs text-muted-foreground">
              Waiting for {environmentLabel} to connect.
            </p>
          ) : null}
          {!canRead ? (
            <p className="text-xs text-muted-foreground">
              Provider management permission is needed to view organizations.
            </p>
          ) : null}
          {canRead && !canWrite ? (
            <p className="text-xs text-muted-foreground">
              Provider management permission is needed to switch organizations.
            </p>
          ) : null}
          {canRead && error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {canRead && (switching !== null || notice) ? (
            <p role="status" className="text-xs">
              {switching !== null ? "Switching organization…" : notice}
            </p>
          ) : null}
          {canRead && !snapshot && busy ? (
            <p role="status" className="text-xs">
              Loading saved organizations…
            </p>
          ) : null}
          {visibleSnapshot && !visibleSnapshot.available ? (
            <p className="text-xs text-muted-foreground">
              Organization switching needs claude-swap on {environmentLabel}. Open Manage
              organizations for setup.
            </p>
          ) : visibleSnapshot && visibleSnapshot.accounts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No organizations saved yet. Add them in Manage organizations.
            </p>
          ) : (
            [...groups].map(([email, accounts]) => (
              <section key={email} aria-label={email} className="space-y-1">
                <p className="break-all px-2 text-xs text-muted-foreground">{email}</p>
                <ul aria-label={`Saved organizations for ${email}`}>
                  {accounts.map((account) => {
                    const label = organizationLabel(account);
                    const duplicateLabel = accounts.some(
                      (other) =>
                        other.number !== account.number && organizationLabel(other) === label,
                    );
                    const usage = !busy && !error ? usageLabel(account) : null;
                    return (
                      <li key={`${account.number}:${account.organizationUuid ?? ""}`}>
                        <button
                          type="button"
                          aria-pressed={account.active}
                          disabled={!canWrite || !isConnected || busy || account.active}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60"
                          onClick={() => void switchOrganization(account)}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block break-words">{label}</span>
                            {duplicateLabel ? (
                              <span className="block break-all text-xs text-muted-foreground">
                                {account.organizationUuid ?? `Saved login ${account.number}`}
                              </span>
                            ) : null}
                            {usage ? (
                              <span className="block text-xs text-muted-foreground">{usage}</span>
                            ) : null}
                          </span>
                          {account.active ? (
                            <CheckIcon
                              aria-label="Active organization"
                              className="size-4 shrink-0"
                            />
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
          {visibleSnapshot?.notice ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Connection details</summary>
              <p className="pt-2">{visibleSnapshot.notice}</p>
            </details>
          ) : null}
          <div className="border-t border-border/60 pt-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              Manage organizations
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
