export interface WorkspaceAgentOwner {
  readonly token: symbol;
  readonly threadId: string;
  readonly kind: "native" | "graphical";
}

// One server process owns each data home. Tokens keep an old exit callback
// from releasing a replacement agent's workspace.
const owners = new Map<string, WorkspaceAgentOwner>();

export function claimAgentWorkspace(workspace: string, owner: WorkspaceAgentOwner): void {
  const existing = owners.get(workspace);
  if (existing && existing.token !== owner.token) {
    throw new Error(
      `A ${existing.kind} agent is already running in this workspace (thread ${existing.threadId}). Exit it or use another Git worktree.`,
    );
  }
  owners.set(workspace, owner);
}

export function releaseAgentWorkspace(token: symbol): void {
  for (const [workspace, owner] of owners) {
    if (owner.token === token) owners.delete(workspace);
  }
}
