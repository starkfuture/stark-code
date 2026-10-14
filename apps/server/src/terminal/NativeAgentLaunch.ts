import { CODEX_PRIVACY_ARGS, PROVIDER_PRIVACY_ENV } from "@starkfuture/shared/providerPrivacy";
import { BRAND } from "@starkfuture/shared/branding";
import { ClaudeSettings, CodexSettings } from "@starkfuture/contracts";
import { tokenizeCliArgs } from "@starkfuture/shared/cliArgs";
import { expandHomePath } from "@starkfuture/provider-core/server/pathExpansion";
import * as Schema from "effect/Schema";

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

const supervisedLaunchError =
  "This Stark build requires supervised native agents. Remove bypass or automatic permission launch arguments.";
const safeCodexApprovals = ["untrusted", "on-request"];
const safeCodexSandboxes = ["read-only", "workspace-write"];

function codexOptionValue(args: readonly string[], index: number, short: string, long: string) {
  const arg = args[index]!;
  if (arg === short || arg === long) return { value: args[index + 1] ?? "", consumesNext: true };
  if (arg.startsWith(`${long}=`)) return { value: arg.slice(long.length + 1), consumesNext: false };
  if (arg.startsWith(short) && !arg.startsWith("--"))
    return { value: arg.slice(short.length).replace(/^=/, ""), consumesNext: false };
  return null;
}

function codexPolicyOverride(value: string) {
  const equals = value.indexOf("=");
  if (equals < 0) return null;
  const key = value
    .slice(0, equals)
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!["approval_policy", "sandbox_mode", "approvals_reviewer"].includes(key)) return null;
  // These policy keys take enum strings. Reject other TOML expressions rather than
  // letting a table or an unrecognised spelling weaken the supervised launch.
  const raw = value.slice(equals + 1).trim();
  return { key, value: raw.replace(/^["']|["']$/g, "") };
}

function supervisedCodexArgs(args: readonly string[]) {
  const retained: string[] = [];
  let approval = "on-request";
  let sandbox = "workspace-write";
  let configuredApproval: string | undefined;
  let configuredSandbox: string | undefined;
  let explicitApproval = false;
  let explicitSandbox = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (
      /^(?:--yolo|--dangerously-bypass-approvals-and-sandbox|--full-auto|--approve-for-me|--not-so-yolo|--dangerously-bypass-hook-trust|--remote)(?:=|$)/.test(
        arg,
      )
    )
      throw new Error(supervisedLaunchError);
    const approvalOption = codexOptionValue(args, index, "-a", "--ask-for-approval");
    const sandboxOption = codexOptionValue(args, index, "-s", "--sandbox");
    const policyOption = approvalOption ?? sandboxOption;
    if (policyOption) {
      if (!(approvalOption ? safeCodexApprovals : safeCodexSandboxes).includes(policyOption.value))
        throw new Error(supervisedLaunchError);
      if (approvalOption) {
        approval = policyOption.value;
        explicitApproval = true;
      } else {
        sandbox = policyOption.value;
        explicitSandbox = true;
      }
      if (policyOption.consumesNext) index++;
      continue;
    }
    const configOption = codexOptionValue(args, index, "-c", "--config");
    if (configOption) {
      const policy = codexPolicyOverride(configOption.value);
      if (policy) {
        const allowed =
          policy.key === "approval_policy"
            ? safeCodexApprovals
            : policy.key === "sandbox_mode"
              ? safeCodexSandboxes
              : ["user"];
        if (!allowed.includes(policy.value)) throw new Error(supervisedLaunchError);
        if (policy.key === "approval_policy") configuredApproval = policy.value;
        if (policy.key === "sandbox_mode") configuredSandbox = policy.value;
      }
      retained.push(arg);
      if (configOption.consumesNext) retained.push(args[++index]!);
      continue;
    }
    retained.push(arg);
  }
  if (!explicitApproval) approval = configuredApproval ?? approval;
  if (!explicitSandbox) sandbox = configuredSandbox ?? sandbox;
  // CLI sandbox selection outranks personal permission profiles and resumed
  // sessions. Config overrides are last so profiles cannot enable auto review.
  // This controls launch defaults; the native CLI still owns its runtime menu.
  retained.push(
    "--ask-for-approval",
    approval,
    "--sandbox",
    sandbox,
    "-c",
    `approval_policy=${JSON.stringify(approval)}`,
    "-c",
    `sandbox_mode=${JSON.stringify(sandbox)}`,
    "-c",
    'approvals_reviewer="user"',
  );
  return retained;
}

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
    args = supervisedCodexArgs(args);
  }
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
    if (unsafe) throw new Error(supervisedLaunchError);
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
  args.push(...promptArgs);
  return {
    shell: expandHomePath(settings.binaryPath, input.home),
    args,
  };
}
