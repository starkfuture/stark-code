/**
 * One `claude -p` call with no tools, for prompt checks and chat answers. It reuses the review runner's isolation
 * (investigator/local.ts): a fresh private work dir, the minimal environment, `--setting-sources local`, safe mode,
 * no MCP, the sandbox settings the self-test verified. The prompt goes in on stdin, the answer comes back as
 * `--json-schema` structured output. Like reviews, it refuses to run without a passing isolation self-test.
 *
 * Cost is Claude Code's total_cost_usd (an API-equivalent estimate). A call that ends without a result is booked at
 * its cap (upper bound).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { Config } from "./config.ts";
import { notHaiku } from "./config.ts";
import { claudeArgs, isQuota, makeWorkDir, runClaudeTurn, runEnv, structured } from "./investigator/local.ts";
import { selfTestStatus } from "./selftest.ts";

export interface OneShotResult {
  ok: boolean;
  output: unknown;
  costCents: number;
  costUpperBound: boolean;
  /** Token counts Claude Code reported (input, output, cache writes and reads), when it did. */
  usage?: { input: number; output: number; cacheWrite: number; cacheRead: number; costUsd: number };
  durationMs: number;
  error?: string;
  timedOut?: boolean;
}

export interface OneShotSpec {
  system: string;
  input: string;
  schema: Record<string, unknown>;
  model: string;
  effort: Config["promptCheckEffort"];
  timeoutMs: number;
  budgetCents: number;
  prefix: "cpw-" | "cpa-";
  shouldStop?: () => boolean;
  onSpawn?: (c: ChildProcess) => void;
}

/** Kill a one-shot's whole process group (the caller was cancelled): SIGTERM now, SIGKILL after 1.5 s. */
export function killGroup(c: ChildProcess | null | undefined): void {
  if (!c?.pid) return;
  const send = (sig: NodeJS.Signals) => {
    try {
      process.kill(-c.pid!, sig);
    } catch {
      try {
        c.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  send("SIGTERM");
  setTimeout(() => {
    if (c.exitCode === null && c.signalCode === null) send("SIGKILL");
  }, 1500).unref();
}

export async function runOneShot(cfg: Config, spec: OneShotSpec): Promise<OneShotResult> {
  const started = Date.now();
  const st = selfTestStatus(cfg);
  if (!st.ok) return { ok: false, output: null, costCents: 0, costUpperBound: false, durationMs: 0, error: `isolation self-test needed: ${st.reason}` };
  const workDir = makeWorkDir(spec.prefix);
  try {
    const args = claudeArgs({
      prompt: null,
      sessionId: crypto.randomUUID(),
      resume: false,
      model: notHaiku(spec.model),
      effort: spec.effort,
      maxTurns: 4,
      maxBudgetUsd: spec.budgetCents / 100,
      workDir,
      safeMode: cfg.localSafeMode,
      schema: spec.schema,
      system: spec.system,
      tools: "",
      replaceSystem: true,
    });
    const t = await runClaudeTurn(cfg.claudeBin, args, {
      cwd: workDir,
      env: runEnv(workDir, cfg.localEnvPassthrough),
      deadlineMs: started + spec.timeoutMs,
      shouldStop: spec.shouldStop ?? (() => false),
      onSpawn: spec.onSpawn,
      input: spec.input,
    });
    const reported = typeof t.result?.total_cost_usd === "number";
    const costCents = reported ? Math.ceil(t.result!.total_cost_usd * 100) : spec.budgetCents;
    const u = t.result?.usage as Record<string, number> | undefined;
    const usage = u
      ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, costUsd: reported ? t.result!.total_cost_usd : 0 }
      : undefined;
    const base = { costCents, costUpperBound: !reported, durationMs: Date.now() - started, usage };
    if (isQuota(t.result)) return { ok: false, output: null, ...base, error: `usage limit: ${String(t.result?.result ?? "").slice(0, 200)}` };
    if (t.killedFor) return { ok: false, output: null, ...base, timedOut: t.killedFor === "deadline", error: t.killedFor === "deadline" ? `no answer within ${Math.round(spec.timeoutMs / 1000)} s` : "cancelled" };
    if (!t.result) return { ok: false, output: null, ...base, error: `claude exited ${t.exitCode} without a result: ${t.stderr.trim().slice(-200)}` };
    const output = structured(t.result);
    if (!output || typeof output !== "object") return { ok: false, output: null, ...base, error: `no structured answer (${String(t.result.subtype ?? "unknown")})` };
    return { ok: true, output, ...base };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
