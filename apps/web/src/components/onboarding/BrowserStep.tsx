import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  type BrowserImportSource,
  type EnvironmentId,
} from "@starkfuture/contracts";

import {
  getClientSettings,
  persistClientSettingsUpdate,
  useClientSettingsHydrated,
} from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { usePrimaryEnvironment } from "../../state/environments";
import { BrowserImportWizard } from "../settings/BrowserImportWizard";
import { runBrowserImport } from "../settings/browserImport";
import { Button } from "../ui/button";

/** Reuses the regular import flow; opening setup only discovers browser metadata. */
export function BrowserStep({ onContinue }: { readonly onContinue: () => void }) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.preview;
  const environment = usePrimaryEnvironment();
  const settingsReady = useClientSettingsHydrated();
  const [sources, setSources] = useState<readonly BrowserImportSource[] | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [imported, setImported] = useState(false);
  const [session, setSession] = useState<{
    source: BrowserImportSource;
    environmentId: EnvironmentId;
    target: { id: string; name: string };
  } | null>(null);
  const importInFlight = useRef(false);

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    void bridge.listBrowserImportSources().then(
      (available) => {
        if (disposed) return;
        const installed = available.filter((source) => source.unavailable !== "notInstalled");
        setSources(installed);
        setSourceId((current) =>
          installed.some((source) => source.id === current)
            ? current
            : (installed.find((source) => source.isDefault)?.id ?? ""),
        );
      },
      () => {
        if (disposed) return;
        setError("Could not find your browsers. Try again.");
        setSources([]);
      },
    );
    return () => {
      disposed = true;
    };
  }, [bridge, refresh]);

  const beginImport = () => {
    const source = sources?.find((candidate) => candidate.id === sourceId);
    if (!source || !environment || !settingsReady) return;
    const settings = getClientSettings();
    const profiles = resolveBrowserProfiles(settings.browserProfiles);
    const target =
      profiles.find(
        (profile) =>
          profile.id === settings.browserDefaultProfileId && profile.kind === "persistent",
      ) ?? profiles.find((profile) => profile.id === DEFAULT_BROWSER_PROFILE_ID)!;
    // Capture the destination before opening the dialog; a connection switch
    // while importing must not send the cookies to another environment.
    setSession({ source, environmentId: environment.environmentId, target });
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Bring your browser sign-ins
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Import website cookies and signed-in sessions for sites you open inside Stark Code. Choose
        your browser, then review the profile before importing.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        This is a one-time copy. Saved passwords, bookmarks and browsing history are not imported.
        Some sites may still ask you to sign in again.
      </p>
      <div className="mt-5 rounded-xl border border-border p-4">
        {!bridge ? (
          <p className="text-sm text-muted-foreground">
            Browser import is available in the desktop app.
          </p>
        ) : error ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                setError("");
                setSources(null);
                setRefresh((value) => value + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : sources === null ? (
          <p role="status" className="text-sm text-muted-foreground">
            Finding your browsers…
          </p>
        ) : sources.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            No supported browsers were found. You can import later in Settings.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="onboarding-browser" className="text-sm font-medium">
                Browser
              </label>
              <select
                id="onboarding-browser"
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
                className="block h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <option value="" disabled>
                  Choose a browser
                </option>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                    {source.isDefault ? " (default browser)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <Button disabled={!sourceId || !environment || !settingsReady} onClick={beginImport}>
              Review import
            </Button>
            {!environment ? (
              <p className="text-xs text-muted-foreground">Connect to an environment to import.</p>
            ) : null}
            {imported ? (
              <p role="status" className="text-sm text-muted-foreground">
                Browser sign-ins imported. You can continue setup.
              </p>
            ) : null}
          </div>
        )}
      </div>
      <div className="mt-6 flex justify-end">
        <Button variant={imported ? "default" : "ghost-muted"} onClick={onContinue}>
          {imported ? "Continue" : "Skip for now"}
        </Button>
      </div>
      {session && bridge ? (
        <BrowserImportWizard
          source={session.source}
          destinationEnvironmentName="Stark Code"
          targetProfiles={[session.target]}
          canCreateProfile={false}
          onImport={async (input) => {
            if (!settingsReady) return { kind: "blocked", reason: "sessionUnavailable" };
            if (importInFlight.current) return { kind: "blocked", reason: "readFailed" };
            importInFlight.current = true;
            try {
              const result = await runBrowserImport(
                {
                  bridge,
                  getSettings: getClientSettings,
                  persistSettingsUpdate: persistClientSettingsUpdate,
                },
                { source: session.source, environmentId: session.environmentId, ...input },
              );
              if (result.kind === "imported" && result.imported > 0) setImported(true);
              return result;
            } finally {
              importInFlight.current = false;
            }
          }}
          onRefreshSource={async () =>
            (await bridge.listBrowserImportSources()).find(
              (source) => source.id === session.source.id,
            )
          }
          onOpenFullDiskAccessSettings={() =>
            ensureLocalApi().shell.openSystemSettings("full-disk-access")
          }
          onCheckFullDiskAccess={
            window.desktopBridge?.checkSystemPermission
              ? () => window.desktopBridge!.checkSystemPermission!("full-disk-access")
              : undefined
          }
          onClose={() => setSession(null)}
        />
      ) : null}
    </>
  );
}
