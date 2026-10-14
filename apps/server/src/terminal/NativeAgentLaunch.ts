import { CODEX_PRIVACY_ARGS, PROVIDER_PRIVACY_ENV } from "@starkfuture/shared/providerPrivacy";
import { BRAND } from "@starkfuture/shared/branding";
import { STARK_PAGES_ENV } from "@starkfuture/shared/starkPages";
import { ClaudeSettings, CodexSettings } from "@starkfuture/contracts";
import { tokenizeCliArgs } from "@starkfuture/shared/cliArgs";
import { expandHomePath } from "@starkfuture/provider-core/server/pathExpansion";
import * as Schema from "effect/Schema";
import { supervisedNativeCodexArgs } from "@starkfuture/shared/nativeCodexLaunch";
export { NativeAgentLaunchRefused } from "@starkfuture/shared/nativeCodexLaunch";

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
  const userArgs = [...tokenizeCliArgs(settings.launchArgs)];
  const delimiter = userArgs.indexOf("--");
  // Enforced flags must precede the end-of-options delimiter, whose remaining
  // arguments are prompt text rather than CLI options.
  const promptArgs = delimiter < 0 ? [] : userArgs.slice(delimiter);
  let args = delimiter < 0 ? userArgs : userArgs.slice(0, delimiter);
  if (BRAND.requireApprovalsByDefault && input.driver === "codex") {
    args = supervisedNativeCodexArgs(userArgs);
  }
  if (BRAND.requireApprovalsByDefault && input.driver === "claudeAgent") {
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
  if (!hasPermissionPolicy && !(BRAND.requireApprovalsByDefault && input.driver === "codex")) {
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
        env: { ...PROVIDER_PRIVACY_ENV, ...STARK_PAGES_ENV },
        disableAutoMode: "disable",
        permissions: { disableBypassPermissionsMode: "disable" },
      }),
    );
  }
  if (input.driver === "codex") args.push(...CODEX_PRIVACY_ARGS);
  if (input.driver !== "codex" || !BRAND.requireApprovalsByDefault) args.push(...promptArgs);
  return {
    shell: expandHomePath(settings.binaryPath, input.home),
    args,
  };
}
