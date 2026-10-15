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
}): { shell: string; args: string[] } {
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
  if (input.driver === "claudeAgent") {
    args.push(
      "--settings",
      JSON.stringify({
        env: { ...PROVIDER_PRIVACY_ENV, ...STARK_PAGES_ENV },
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
