import { useState } from "react";
import { ProjectId, ProviderInstanceId } from "@starkfuture/contracts";
import { useProjects } from "../../state/entities";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer } from "./settingsLayout";
import { McpServersPanel } from "../chat/McpServersPanel";

export function McpServersSettings() {
  const { environment, scope } = useSettingsScope();
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environment?.environmentId &&
      ((scope.kind !== "project" && scope.kind !== "checkout") ||
        scope.members.some(
          (member) => member.environmentId === project.environmentId && member.id === project.id,
        )),
  );
  const providers =
    environment?.serverConfig?.providers.filter(
      (provider) => provider.driver === "codex" || provider.driver === "claudeAgent",
    ) ?? [];
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const project = projects.find((entry) => entry.id === projectId) ?? projects[0];
  const provider = providers.find((entry) => entry.instanceId === instanceId) ?? providers[0];
  return (
    <SettingsPageContainer>
      <div className="space-y-5 py-6">
        <div>
          <h2 className="text-base font-semibold">MCP servers</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Inspect provider servers for a project. Authentication opens in your system browser.
          </p>
        </div>
        {!environment ? (
          <p className="text-sm text-muted-foreground">
            Connect an environment to view its MCP servers.
          </p>
        ) : !project || !provider ? (
          <p className="text-sm text-muted-foreground">
            Add a project and a Claude or Codex provider to inspect MCP servers.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-2 text-sm">
                Project
                <select
                  aria-label="MCP project"
                  className="rounded-lg border bg-background px-3 py-2"
                  value={project.id}
                  onChange={(event) => setProjectId(ProjectId.make(event.target.value))}
                >
                  {projects.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-2 text-sm">
                Provider
                <select
                  aria-label="MCP provider"
                  className="rounded-lg border bg-background px-3 py-2"
                  value={provider.instanceId}
                  onChange={(event) => setInstanceId(ProviderInstanceId.make(event.target.value))}
                >
                  {providers.map((entry) => (
                    <option key={entry.instanceId} value={entry.instanceId}>
                      {entry.displayName ?? entry.instanceId}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <McpServersPanel
              key={`${environment.environmentId}:${project.id}:${provider.instanceId}`}
              environmentId={environment.environmentId}
              target={{ projectId: project.id, providerInstanceId: provider.instanceId }}
            />
          </>
        )}
      </div>
    </SettingsPageContainer>
  );
}
