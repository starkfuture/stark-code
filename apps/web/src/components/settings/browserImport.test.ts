import {
  BROWSER_PROFILE_MAX_COUNT,
  DEFAULT_CLIENT_SETTINGS,
  type BrowserImportResult,
  type BrowserImportSource,
  type ClientSettings,
  type EnvironmentId,
} from "@starkfuture/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { runBrowserImport } from "./browserImport";

const environmentId = "environment-a" as EnvironmentId;
const source: BrowserImportSource = {
  id: "chrome",
  name: "Chrome",
  profiles: [{ directory: "Default", name: "Personal" }],
};
const result: BrowserImportResult = { imported: 5, skipped: 2, skippedDomains: ["example.test"] };
const request = {
  source,
  environmentId,
  sourceProfileDirectory: "Default",
  target: { kind: "new" as const, profileId: "profile-import" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fixture() {
  let settings: ClientSettings = { ...DEFAULT_CLIENT_SETTINGS };
  const bridge = {
    importBrowserCookies: vi.fn().mockResolvedValue(result),
    clearCookies: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined),
  };
  const persistSettingsUpdate = vi.fn(
    async (update: (current: ClientSettings) => ClientSettings) => {
      settings = update(settings);
      return settings;
    },
  );
  return {
    bridge,
    getSettings: () => settings,
    persistSettingsUpdate,
    setSettings: (next: ClientSettings) => {
      settings = next;
    },
  };
}

describe("runBrowserImport", () => {
  it("registers a successful import with a distinct name and preserves other settings", async () => {
    const deps = fixture();
    deps.setSettings({
      ...DEFAULT_CLIENT_SETTINGS,
      browserProfiles: [{ id: "profile-earlier", name: "Chrome", kind: "persistent" }],
    });

    expect(await runBrowserImport(deps, request)).toEqual({
      kind: "imported",
      ...result,
      targetName: "Chrome 2",
    });
    expect(deps.bridge.importBrowserCookies).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      sourceId: "chrome",
      sourceProfileDirectory: "Default",
      targetProfileId: "profile-import",
    });
    expect(deps.getSettings()).toEqual({
      ...DEFAULT_CLIENT_SETTINGS,
      browserProfiles: [
        { id: "profile-earlier", name: "Chrome", kind: "persistent" },
        { id: "profile-import", name: "Chrome 2", kind: "persistent" },
      ],
    });
  });

  it("does not register an empty import", async () => {
    const deps = fixture();
    deps.bridge.importBrowserCookies.mockResolvedValue({ ...result, imported: 0 });

    expect(await runBrowserImport(deps, request)).toMatchObject({ kind: "imported", imported: 0 });
    expect(deps.persistSettingsUpdate).not.toHaveBeenCalled();
    expect(deps.getSettings().browserProfiles).toEqual([]);
  });

  it("blocks missing desktop support without touching settings", async () => {
    const deps = fixture();

    expect(await runBrowserImport({ ...deps, bridge: null }, request)).toEqual({
      kind: "blocked",
      reason: "sessionUnavailable",
    });
    expect(deps.persistSettingsUpdate).not.toHaveBeenCalled();
  });

  it("does not import into an existing profile that was removed", async () => {
    const deps = fixture();

    expect(
      await runBrowserImport(deps, {
        ...request,
        target: { kind: "existing", profileId: "profile-gone", name: "Gone" },
      }),
    ).toEqual({ kind: "blocked", reason: "readFailed" });
    expect(deps.bridge.importBrowserCookies).not.toHaveBeenCalled();
  });

  it("does not report success if the existing target disappears during import", async () => {
    const deps = fixture();
    const pending = deferred<BrowserImportResult>();
    deps.setSettings({
      ...DEFAULT_CLIENT_SETTINGS,
      browserProfiles: [{ id: "profile-existing", name: "Existing", kind: "persistent" }],
    });
    deps.bridge.importBrowserCookies.mockReturnValue(pending.promise);
    const importing = runBrowserImport(deps, {
      ...request,
      target: { kind: "existing", profileId: "profile-existing", name: "Existing" },
    });
    deps.setSettings(DEFAULT_CLIENT_SETTINGS);
    pending.resolve(result);

    expect(await importing).toEqual({ kind: "blocked", reason: "readFailed" });
    expect(deps.persistSettingsUpdate).not.toHaveBeenCalled();
  });

  it("clears copied cookies when settings cannot save the new profile", async () => {
    const deps = fixture();
    deps.persistSettingsUpdate.mockRejectedValue(new Error("disk failure"));

    expect(await runBrowserImport(deps, request)).toEqual({
      kind: "blocked",
      reason: "profileNotSaved",
    });
    expect(deps.bridge.clearCookies).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      "profile-import",
    );
    expect(deps.bridge.clearCache).toHaveBeenCalledExactlyOnceWith(environmentId, "profile-import");
    expect(deps.getSettings().browserProfiles).toEqual([]);
  });

  it("rechecks the latest profile cap after copying and clears the unregistered partition", async () => {
    const deps = fixture();
    const pending = deferred<BrowserImportResult>();
    deps.bridge.importBrowserCookies.mockReturnValue(pending.promise);
    const importing = runBrowserImport(deps, request);
    deps.setSettings({
      ...DEFAULT_CLIENT_SETTINGS,
      browserProfiles: Array.from({ length: BROWSER_PROFILE_MAX_COUNT }, (_, index) => ({
        id: `profile-${index}`,
        name: `Browser ${index}`,
        kind: "persistent" as const,
      })),
    });
    pending.resolve(result);

    expect(await importing).toEqual({ kind: "blocked", reason: "profileLimitReached" });
    expect(deps.getSettings().browserProfiles).toHaveLength(BROWSER_PROFILE_MAX_COUNT);
    expect(deps.bridge.clearCookies).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      "profile-import",
    );
  });

  it("reuses a target registered by an earlier attempt instead of duplicating it", async () => {
    const deps = fixture();
    deps.setSettings({
      ...DEFAULT_CLIENT_SETTINGS,
      browserProfiles: [{ id: "profile-import", name: "Saved Chrome", kind: "persistent" }],
    });

    expect(await runBrowserImport(deps, request)).toMatchObject({
      kind: "imported",
      targetName: "Saved Chrome",
    });
    expect(deps.getSettings().browserProfiles).toHaveLength(1);
  });

  it("returns safe failure categories instead of raw errors", async () => {
    const deps = fixture();
    deps.bridge.importBrowserCookies.mockRejectedValue(
      new Error("Importing cookies from chrome failed: needsKeychainApproval. private details"),
    );
    expect(await runBrowserImport(deps, request)).toEqual({
      kind: "blocked",
      reason: "needsKeychainApproval",
    });
    deps.bridge.importBrowserCookies.mockRejectedValue(new Error("private file location"));
    expect(await runBrowserImport(deps, request)).toEqual({
      kind: "blocked",
      reason: "readFailed",
    });
    expect(deps.persistSettingsUpdate).not.toHaveBeenCalled();
  });
});
