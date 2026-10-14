import type { ServerProviderSkill, ServerProviderSlashCommand } from "@starkfuture/contracts";

export const PROVIDER_PERMISSION_WARNING =
  "This skill or plugin can pre-approve tools. Some tool calls may run without a Stark approval prompt.";
export interface ComposerPermissionWarning {
  readonly reference: string;
  readonly warning: string;
}
export function permissionWarningForCatalogEntry(
  entry:
    | { type: "skill"; skill: ServerProviderSkill }
    | { type: "provider-slash-command"; command: ServerProviderSlashCommand }
    | { type: "slash-command" | "path" | "thread" | "pull-request" },
): string | null {
  if (entry.type === "skill") return entry.skill.permissionWarning ?? PROVIDER_PERMISSION_WARNING;
  if (entry.type === "provider-slash-command")
    return (
      entry.command.permissionWarning ??
      (["plugin", "personal", "project"].includes(entry.command.source ?? "")
        ? PROVIDER_PERMISSION_WARNING
        : null)
    );
  return null;
}
export function activeComposerPermissionWarnings(
  prompt: string,
  warnings: ReadonlyArray<ComposerPermissionWarning> | undefined,
): ComposerPermissionWarning[] {
  return (warnings ?? [])
    .filter((entry) => {
      const escaped = entry.reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^A-Za-z0-9_:/-])${escaped}(?=$|[^A-Za-z0-9_:/-])`).test(prompt);
    })
    .slice(-10);
}
