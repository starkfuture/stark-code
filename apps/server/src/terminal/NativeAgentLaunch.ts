import { CODEX_PRIVACY_ARGS, PROVIDER_PRIVACY_ENV } from "@starkfuture/shared/providerPrivacy";
import { BRAND } from "@starkfuture/shared/branding";
import { ClaudeSettings, CodexSettings } from "@starkfuture/contracts";
import { tokenizeCliArgs } from "@starkfuture/shared/cliArgs";
import { expandHomePath } from "@starkfuture/provider-core/server/pathExpansion";
import * as Schema from "effect/Schema";

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

/** Launch the interactive CLI directly, without SDK or app-server transport flags. */
export function nativeAgentLaunch(input: {
  readonly driver: string;
  readonly config: unknown;
  readonly home: string;
}) {
  const settings =
    input.driver === "codex"
      ? decodeCodexSettings(input.config)
      : input.driver === "claudeAgent"
        ? decodeClaudeSettings(input.config)
        : null;
  if (settings === null) throw new Error("Native shell mode supports Claude and Codex.");
  const args = [...tokenizeCliArgs(settings.launchArgs)];
  if (BRAND.requireApprovalsByDefault) {
    const unsafe = args.some((arg, index) => {
      if (
        /^(?:--yolo|--dangerously-bypass-approvals-and-sandbox|--dangerously-skip-permissions|--full-auto)$/.test(
          arg,
        )
      )
        return true;
      if (arg === "-a" || arg === "--ask-for-approval")
        return !["untrusted", "on-request"].includes(args[index + 1] ?? "");
      if (arg.startsWith("--ask-for-approval="))
        return !["untrusted", "on-request"].includes(arg.slice(arg.indexOf("=") + 1));
      if (arg === "--permission-mode") return !["default", "plan"].includes(args[index + 1] ?? "");
      if (arg.startsWith("--permission-mode="))
        return !["default", "plan"].includes(arg.slice(arg.indexOf("=") + 1));
      return false;
    });
    if (unsafe)
      throw new Error(
        "This Stark build requires supervised native agents. Remove bypass or automatic permission launch arguments.",
      );
  }
  const hasPermissionPolicy = args.some((arg) =>
    input.driver === "codex"
      ? /^(?:-a$|--ask-for-approval(?:=|$)|--yolo$|--dangerously-bypass-approvals-and-sandbox$)/.test(
          arg,
        )
      : /^(?:--permission-mode(?:=|$)|--dangerously-skip-permissions$)/.test(arg),
  );
  // Keep explicit user configuration; a normal native launch asks for approvals.
  if (!hasPermissionPolicy) {
    args.push(
      ...(input.driver === "codex"
        ? ["--ask-for-approval", "on-request"]
        : ["--permission-mode", "default"]),
    );
  }
  if (BRAND.requireApprovalsByDefault && input.driver === "claudeAgent") {
    args.push(
      "--settings",
      JSON.stringify({
        env: PROVIDER_PRIVACY_ENV,
        disableAutoMode: "disable",
        permissions: { disableBypassPermissionsMode: "disable" },
      }),
    );
  }
  if (input.driver === "codex") args.push(...CODEX_PRIVACY_ARGS);
  return {
    shell: expandHomePath(settings.binaryPath, input.home),
    args,
  };
}
