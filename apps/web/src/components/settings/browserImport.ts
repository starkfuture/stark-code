import {
  BROWSER_PROFILE_MAX_COUNT,
  BrowserImportFailureReason,
  resolveBrowserProfiles,
  type BrowserImportSource,
  type ClientSettings,
  type DesktopPreviewBridge,
  type EnvironmentId,
} from "@starkfuture/contracts";

import type { ImportOutcome, WizardTarget } from "./browserImportWizard.logic";

type BrowserProfileDataBridge = Pick<DesktopPreviewBridge, "clearCookies" | "clearCache">;

/** Environments that host server-runtime tabs keep their own copy of each profile. */
export interface ServerProfileData {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly clear: (environmentId: EnvironmentId, profileId: string) => Promise<void>;
}

export async function clearBrowserProfileData(
  bridge: BrowserProfileDataBridge | null,
  environmentIds: ReadonlyArray<EnvironmentId>,
  profileId: string,
  server?: ServerProfileData,
): Promise<void> {
  const desktopEnvironmentIds = bridge === null ? [] : environmentIds;
  const serverEnvironmentIds = server?.environmentIds ?? [];
  if (desktopEnvironmentIds.length === 0 && serverEnvironmentIds.length === 0) {
    throw new Error("Browser profile data is not available to clear.");
  }
  await Promise.all([
    ...desktopEnvironmentIds.flatMap((environmentId) => [
      bridge!.clearCookies(environmentId, profileId),
      bridge!.clearCache(environmentId, profileId),
    ]),
    ...serverEnvironmentIds.map((environmentId) => server!.clear(environmentId, profileId)),
  ]);
}

/** Thrown from the post-import settings updater when the cap was hit meanwhile. */
class ProfileLimitReachedError extends Error {
  constructor() {
    super("Browser profile limit reached.");
    this.name = "ProfileLimitReachedError";
  }
}

/** IPC exposes the reason token, but raw browser or Keychain errors stay private. */
export const importFailureReason = (cause: unknown): BrowserImportFailureReason => {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return (
    BrowserImportFailureReason.literals.find((reason) => message.includes(`failed: ${reason}.`)) ??
    "readFailed"
  );
};

interface BrowserImportDependencies {
  readonly bridge: Pick<
    DesktopPreviewBridge,
    "importBrowserCookies" | "clearCookies" | "clearCache"
  > | null;
  readonly getSettings: () => ClientSettings;
  readonly persistSettingsUpdate: (
    update: (current: ClientSettings) => ClientSettings,
  ) => Promise<ClientSettings>;
}

interface BrowserImportRequest {
  readonly source: BrowserImportSource;
  readonly environmentId: EnvironmentId;
  readonly sourceProfileDirectory: string;
  readonly target: WizardTarget;
}

/**
 * Imports into a partition before registering a new profile. Callers own their
 * hydration and in-flight UI guards; settings are checked again after the copy.
 */
export async function runBrowserImport(
  { bridge, getSettings, persistSettingsUpdate }: BrowserImportDependencies,
  { source, environmentId, sourceProfileDirectory, target }: BrowserImportRequest,
): Promise<ImportOutcome> {
  if (!bridge) return { kind: "blocked", reason: "sessionUnavailable" };
  const targetExists = () =>
    resolveBrowserProfiles(getSettings().browserProfiles).some(
      (profile) => profile.id === target.profileId,
    );
  if (target.kind === "existing" && !targetExists()) {
    return { kind: "blocked", reason: "readFailed" };
  }
  try {
    const result = await bridge.importBrowserCookies({
      environmentId,
      sourceId: source.id,
      sourceProfileDirectory,
      targetProfileId: target.profileId,
    });
    if (target.kind === "existing" && !targetExists()) {
      return { kind: "blocked", reason: "readFailed" };
    }
    let targetName: string;
    if (target.kind === "new") {
      // Empty imports must not leave empty profiles behind.
      if (result.imported > 0) {
        try {
          const persisted = await persistSettingsUpdate((current) => {
            const existing = current.browserProfiles.find(
              (profile) => profile.id === target.profileId,
            );
            if (existing) return current;
            // Another settings write can reach the cap during the cookie copy.
            if (current.browserProfiles.length >= BROWSER_PROFILE_MAX_COUNT) {
              throw new ProfileLimitReachedError();
            }
            const taken = new Set(
              resolveBrowserProfiles(current.browserProfiles).map((profile) => profile.name),
            );
            let name = source.name;
            for (let index = 2; taken.has(name); index += 1) name = `${source.name} ${index}`;
            return {
              ...current,
              browserProfiles: [
                ...current.browserProfiles,
                { id: target.profileId, name, kind: "persistent" as const },
              ],
            };
          });
          targetName =
            persisted.browserProfiles.find((profile) => profile.id === target.profileId)?.name ??
            source.name;
        } catch (cause) {
          // The new target belongs to this import. Clear its partition if the
          // registration fails so cookies cannot become an unreachable orphan.
          await clearBrowserProfileData(bridge, [environmentId], target.profileId).catch(
            () => undefined,
          );
          return {
            kind: "blocked",
            reason:
              cause instanceof ProfileLimitReachedError ? "profileLimitReached" : "profileNotSaved",
          };
        }
      } else {
        targetName = source.name;
      }
    } else {
      targetName = target.name;
    }
    return {
      kind: "imported",
      imported: result.imported,
      skipped: result.skipped,
      skippedDomains: result.skippedDomains,
      targetName,
    };
  } catch (cause) {
    return { kind: "blocked", reason: importFailureReason(cause) };
  }
}
