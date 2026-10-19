import type { ServerProvider } from "@starkfuture/contracts";
import { providerClients } from "../settings/providerDriverMeta";

/** Only describe the selected instance; never borrow another provider's active account. */
export function composerProviderIdentity(provider: ServerProvider): string {
  const driver = providerClients.get(provider.driver)?.label ?? String(provider.driver);
  const profile = provider.displayName?.trim();
  if (profile && profile.toLowerCase() !== driver.toLowerCase()) return `${driver} · ${profile}`;
  const authLabel = provider.auth.status === "authenticated" ? provider.auth.label?.trim() : null;
  return authLabel && authLabel.toLowerCase() !== driver.toLowerCase()
    ? `${driver} · ${authLabel}`
    : driver;
}
