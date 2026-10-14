import type { ComposerPermissionWarning } from "../../composerPermissionWarnings";
export function ProviderPermissionWarnings({
  warnings,
}: {
  warnings: ReadonlyArray<ComposerPermissionWarning>;
}) {
  return warnings.length ? (
    <div role="note" data-provider-permission-warning className="space-y-1 text-xs text-warning">
      {warnings.map((entry) => (
        <p key={entry.reference}>
          <code>{entry.reference}</code> {entry.warning}
        </p>
      ))}
    </div>
  ) : null;
}
