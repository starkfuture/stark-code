export const NATIVE_AGENT_SHELL_TOGGLE_EVENT = "t3code:toggle-native-agent-shell";

export function toggleNativeAgentShell(): void {
  window.dispatchEvent(new Event(NATIVE_AGENT_SHELL_TOGGLE_EVENT));
}
