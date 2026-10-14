export const NATIVE_AGENT_SHELL_TOGGLE_EVENT = "starkcode:toggle-native-agent-shell";

export function toggleNativeAgentShell(): void {
  window.dispatchEvent(new Event(NATIVE_AGENT_SHELL_TOGGLE_EVENT));
}
