/**
 * LOCAL investigator: runs the assessment with headless Claude Code (`claude -p`) on the developer's own
 * Claude subscription/profile. No Anthropic API key needed. Code-only by design.
 *
 * Isolation (it runs on the laptop with the developer's access, so this matters):
 *  - Works on an extracted copy of the snapshot bundle in a fresh temp dir outside the repo.
 *  - `--setting-sources local` from that empty dir: no user/project settings are inherited (so nothing like
 *    an inherited sandbox.excludedCommands or broad permission allow applies). Optional `--safe-mode` also
 *    drops CLAUDE.md, skills, plugins, hooks and MCP; our `disableAllHooks` + `--strict-mcp-config` cover
 *    hooks and MCP either way. Admin-managed policy settings still apply (they cannot be overridden).
 *  - Minimal environment: only PATH/HOME/locale-style variables reach Claude Code and its Bash; cloud/app
 *    credentials in the watcher's environment are not passed.
 *  - Bash runs in Claude Code's sandbox (Seatbelt / bubblewrap), failIfUnavailable, no unsandboxed retry:
 *    user-data roots unreadable (home, /Users, /Volumes, temp roots ...) except the work dir and the Node
 *    toolchain; writes limited to the work dir; network limited to package registries; localhost allowed.
 *  - Built-in file tools: dontAsk mode with only work-dir rules allowed. No web tools, no MCP servers.
 *  - PILOT_IN_INVESTIGATION=1 (and the older LOOKOUT_IN_INVESTIGATION=1) makes our own hook a no-op if anything
 *    still loads it.
 *  - `pilot local-selftest` checks all of this against a real Claude Code run (canaries), from the transcript.
 *
 * Results come back as `--json-schema` structured output; the stream-json transcript gives the tool log used
 * to verify command evidence. Cost is Claude Code's total_cost_usd: an API-equivalent estimate, not a bill.
 * A turn that ends without a result is charged its full per-turn cap (upper bound). A usage-limit response
 * becomes a QuotaHoldError carrying the cost spent so far (job is held, not failed).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { kvGet, kvSet } from "../db.ts";
import { envVar } from "../home.ts";
import { QuotaHoldError, type Investigator, type RunOutcome, type RunSpec } from "./index.ts";
import { systemPrompt } from "./prompt.ts";
import type { DriveResult, DriveStatus, ToolLogEntry } from "./sessionDriver.ts";
import { SUBMISSION_SCHEMA, validateSubmission, type Submission } from "./types.ts";
import { selfTestStatus } from "../selftest.ts";

export interface ClaudeTurn {
  exitCode: number | null;
  killedFor: "deadline" | "stop" | null;
  result: Record<string, any> | null;
  toolLog: ToolLogEntry[];
  stderr: string;
}

const REGISTRIES = ["registry.npmjs.org", "*.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org"];
const ENV_PASSTHROUGH = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "XDG_CONFIG_HOME"];

/** Roots that hold user data on macOS/Linux; denied to sandboxed Bash except the allow list. */
const DENY_READ_ROOTS = ["~/", "/Users", "/home", "/Volumes", "/private/tmp", "/tmp", "/private/var/folders", "/var/folders", "/opt", "/srv", "/mnt", "/media", "/root"];

/**
 * Per-run work dirs. Claude Code keeps each command's output and cwd files in its per-uid temp dir, by default
 * /tmp/claude-<uid> - which is denied here (other sessions keep their files there), so commands could not fstat
 * their own stdout (cat failed, node aborted) or record their cwd (every command reported exit code 1).
 * CLAUDE_CODE_TMPDIR moves that dir, but Claude Code ignores it when it is longer than ~30 bytes (AF_UNIX socket
 * paths), and withholds its own write grant when the path is spelled through a symlink into a denied read path
 * (/tmp -> /private/tmp on macOS). So work dirs are short, spelled by their real path (/private/tmp/cpj-XXXXXX),
 * private (0700), and double as Claude Code's temp dir: everything a run touches stays in one allow-listed folder.
 */
export const CC_TMP_MAX_BYTES = 30;

export function makeWorkDir(prefix: "cpj-" | "cpt-" | "cps-" | "cpp-" | "cpw-" | "cpa-" | "cpx-"): string {
  // PILOT_WORK_ROOT exists for unit tests (fake claude binary, sandboxed test shells); real runs use /private/tmp.
  const root = envVar("WORK_ROOT")
    ? fs.realpathSync(envVar("WORK_ROOT")!)
    : fs.existsSync("/tmp")
      ? fs.realpathSync("/tmp")
      : fs.realpathSync(os.tmpdir());
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, prefix)));
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function claudeTmpFits(workDir: string): boolean {
  return Buffer.byteLength(workDir) <= CC_TMP_MAX_BYTES;
}

export function runEnv(workDir: string, passthrough: string[] = []): NodeJS.ProcessEnv {
  return minimalEnv(
    { PILOT_IN_INVESTIGATION: "1", LOOKOUT_IN_INVESTIGATION: "1", npm_config_cache: path.join(workDir, ".npm-cache"), TMPDIR: workDir, CLAUDE_CODE_TMPDIR: workDir },
    passthrough,
  );
}

export function minimalEnv(extra: Record<string, string>, passthrough: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of [...ENV_PASSTHROUGH, ...passthrough]) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

export function sandboxSettings(workDir: string): Record<string, unknown> {
  const nodePrefix = path.resolve(path.dirname(process.execPath), "..");
  const real = fs.existsSync(workDir) ? fs.realpathSync(workDir) : workDir;
  return {
    disableAllHooks: true,
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      excludedCommands: [],
      filesystem: { denyRead: DENY_READ_ROOTS, allowRead: [...new Set([workDir, real, nodePrefix])], allowWrite: [...new Set([workDir, real])] },
      network: { allowedDomains: REGISTRIES, allowLocalBinding: true },
    },
    permissions: {
      allow: ["Read(/**)", "Edit(/**)", "Bash"],
      deny: ["WebFetch", "WebSearch", "Read(~/**)", "Edit(~/**)"],
    },
  };
}

export function claudeArgs(o: {
  /** null: the prompt is written to stdin (keeps private text out of argv). */
  prompt: string | null;
  sessionId: string;
  resume: boolean;
  model: string;
  effort: string;
  maxTurns: number;
  maxBudgetUsd: number;
  workDir: string;
  safeMode: boolean;
  schema?: unknown;
  system?: string;
  /** Built-in tools to offer; "" offers none (prompt checks and chat answers only read their prompt). */
  tools?: string;
  /** Use `system` as the whole system prompt instead of appending it to Claude Code's. */
  replaceSystem?: boolean;
}): string[] {
  return [
    "-p",
    ...(o.prompt === null ? [] : [o.prompt]),
    ...(o.tools === undefined ? [] : ["--tools", o.tools]),
    ...(o.resume ? ["--resume", o.sessionId] : ["--session-id", o.sessionId]),
    "--output-format",
    "stream-json",
    "--verbose",
    ...(o.schema === null ? [] : ["--json-schema", JSON.stringify(o.schema ?? SUBMISSION_SCHEMA)]),
    o.replaceSystem ? "--system-prompt" : "--append-system-prompt",
    o.system ?? systemPrompt("local"),
    "--model",
    o.model,
    "--effort",
    o.effort,
    "--max-turns",
    String(o.maxTurns),
    "--max-budget-usd",
    o.maxBudgetUsd.toFixed(2),
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "local",
    ...(o.safeMode ? ["--safe-mode"] : []),
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disallowedTools",
    "WebFetch",
    "WebSearch",
    "--settings",
    JSON.stringify(sandboxSettings(o.workDir)),
  ];
}

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("\n") : "";

/** Run one `claude -p` turn in its own process group, streaming JSON lines; kill the group on deadline/stop. */
export function runClaudeTurn(
  bin: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; deadlineMs: number; shouldStop: () => boolean; onSpawn?: (c: ChildProcess) => void; input?: string },
): Promise<ClaudeTurn & { allToolResults: string[] }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true });
    if (o.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {}); // the process may exit before reading everything
      child.stdin.end(o.input);
    }
    o.onSpawn?.(child);
    const uses = new Map<string, string>();
    const toolLog: ToolLogEntry[] = [];
    const allToolResults: string[] = [];
    let result: Record<string, any> | null = null;
    let stderr = "";
    let killedFor: ClaudeTurn["killedFor"] = null;
    child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.type === "assistant") {
        for (const b of m.message?.content ?? []) if (b.type === "tool_use" && b.name === "Bash") uses.set(b.id, String(b.input?.command ?? ""));
      } else if (m.type === "user") {
        for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
          if (b.type !== "tool_result") continue;
          allToolResults.push(textOf(b.content));
          if (uses.has(b.tool_use_id)) toolLog.push({ command: uses.get(b.tool_use_id)!, output: textOf(b.content), isError: Boolean(b.is_error) });
        }
      } else if (m.type === "result") result = m;
    });
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    const kill = (why: "deadline" | "stop") => {
      if (killedFor) return;
      killedFor = why;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5000).unref();
    };
    const timer = setInterval(() => {
      if (o.shouldStop()) kill("stop");
      else if (Date.now() > o.deadlineMs) kill("deadline");
    }, 500);
    child.on("close", (code) => {
      clearInterval(timer);
      rl.close();
      resolve({ exitCode: code, killedFor, result, toolLog, stderr, allToolResults });
    });
    child.on("error", (err) => {
      clearInterval(timer);
      resolve({ exitCode: -1, killedFor, result: null, toolLog, stderr: `${stderr}\n${err.message}`, allToolResults });
    });
  });
}

export function structured(result: Record<string, any> | null): unknown {
  if (!result) return null;
  if (result.structured_output && typeof result.structured_output === "object") return result.structured_output;
  const text = String(result.result ?? "");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export const isQuota = (r: Record<string, any> | null) =>
  !!r && (r.api_error === "usage_limit_reached" || r.api_error === "rate_limit_error" || (r.api_error_status === 429 && /limit/i.test(String(r.result ?? ""))));

interface ChildRecord {
  pid: number;
  sessionId: string;
}

/** Kill a recorded claude process group only if the pid still belongs to that session (no pid-reuse accidents). */
export function killRecorded(rec: ChildRecord): boolean {
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(rec.pid)], { encoding: "utf8" });
    if (!cmd.includes(rec.sessionId)) return false;
  } catch {
    return false; // not running
  }
  try {
    process.kill(-rec.pid, "SIGTERM");
  } catch {
    try {
      process.kill(rec.pid, "SIGTERM");
    } catch {
      return false;
    }
  }
  return true;
}

export class LocalClaudeInvestigator implements Investigator {
  readonly runtime = "local-claude" as const;
  private cfg: Config;
  private db: DB;
  private children = new Map<string, ChildProcess>();

  constructor(cfg: Config, db: DB) {
    this.cfg = cfg;
    this.db = db;
  }

  static available(bin: string): boolean {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  }

  private recordKey(jobId: number) {
    return `local_child_${jobId}`;
  }

  async run(spec: RunSpec): Promise<RunOutcome> {
    // Fail closed: no local run until a real isolation self-test passed for exactly these settings.
    const st = selfTestStatus(this.cfg);
    if (!st.ok) throw new Error(`local mode isolation not verified: ${st.reason}`);
    // A previous watcher may have died with a claude child still running: stop it (if it is really ours).
    const prior = kvGet<ChildRecord | null>(this.db, this.recordKey(spec.jobId), null);
    if (prior && killRecorded(prior)) spec.log(`stopped orphaned local claude process ${prior.pid} (session ${prior.sessionId})`);
    if (spec.existingSessionId) spec.log(`previous local run ${spec.existingSessionId} cannot be re-attached; re-running`);

    const workDir = makeWorkDir("cpj-");
    if (!claudeTmpFits(workDir)) spec.log(`warning: ${workDir} is too long for CLAUDE_CODE_TMPDIR; sandboxed commands will misreport exit codes`);
    spec.log(`job ${spec.jobId} work dir ${workDir}`);
    execFileSync("tar", ["-xzf", spec.bundlePath, "-C", workDir]);
    const sessionId = crypto.randomUUID();
    spec.onSessionCreated(sessionId);
    const env = runEnv(workDir, this.cfg.localEnvPassthrough);

    const submissions: Submission[] = [];
    const toolLog: ToolLogEntry[] = [];
    const errors: string[] = [];
    let costUsd = 0;
    let costIsUpperBound = false;
    let denials = 0;
    let invalid = 0;
    let lastUsage: Record<string, any> | null = null;
    let status: DriveStatus = "completed";
    let reason: string | undefined;
    const budgetUsd = spec.sessionBudgetCents / 100;
    let started = false;

    /** One claude invocation with uniform handling. Returns null to continue, or a terminal status. */
    const invoke = async (prompt: string): Promise<{ t: ClaudeTurn | null; stop?: { status: DriveStatus; reason: string } }> => {
      if (spec.shouldStop()) return { t: null, stop: { status: "stopped", reason: "stop requested before turn" } };
      if (Date.now() > spec.deadlineMs) return { t: null, stop: { status: "timed_out", reason: "deadline passed before turn" } };
      const remaining = budgetUsd - costUsd;
      if (remaining < 0.01) return { t: null, stop: { status: "budget_reached", reason: `run budget $${budgetUsd.toFixed(2)} used (estimate $${costUsd.toFixed(2)})` } };
      const args = claudeArgs({
        prompt,
        sessionId,
        resume: started,
        model: this.cfg.model,
        effort: spec.depth === "deep" ? this.cfg.deepEffort : this.cfg.quickEffort,
        maxTurns: spec.depth === "deep" ? this.cfg.deepLocalMaxTurns : this.cfg.localMaxTurns,
        maxBudgetUsd: remaining,
        workDir,
        safeMode: this.cfg.localSafeMode,
      });
      started = true;
      const t = await runClaudeTurn(this.cfg.claudeBin, args, {
        cwd: workDir,
        env,
        deadlineMs: spec.deadlineMs,
        shouldStop: spec.shouldStop,
        onSpawn: (c) => {
          this.children.set(sessionId, c);
          if (c.pid) kvSet(this.db, this.recordKey(spec.jobId), { pid: c.pid, sessionId } satisfies ChildRecord);
        },
      });
      this.children.delete(sessionId);
      kvSet(this.db, this.recordKey(spec.jobId), null);
      toolLog.push(...t.toolLog);
      if (t.result && typeof t.result.total_cost_usd === "number") costUsd += t.result.total_cost_usd;
      else {
        costUsd += remaining; // no result: we cannot know what it spent, so charge the cap it was given
        costIsUpperBound = true;
      }
      denials += Array.isArray(t.result?.permission_denials) ? t.result.permission_denials.length : 0;
      lastUsage = t.result?.usage ?? lastUsage;
      if (isQuota(t.result)) throw Object.assign(new QuotaHoldError(String(t.result?.result ?? "usage limit reached")), { costCents: Math.ceil(costUsd * 100) });
      if (t.killedFor) return { t, stop: { status: t.killedFor === "stop" ? "stopped" : "timed_out", reason: `local claude killed (${t.killedFor})` } };
      if (!t.result) return { t, stop: { status: "failed", reason: `claude exited ${t.exitCode} without a result: ${t.stderr.trim().slice(-300)}` } };
      return { t };
    };

    try {
      for (let i = 0; i < spec.phases.length; i++) {
        let r = await invoke(spec.phases[i]);
        if (r.stop) {
          ({ status, reason } = r.stop);
          break;
        }
        let v = validateSubmission(structured(r.t!.result));
        if (!v.ok && !/budget/i.test(String(r.t!.result?.subtype))) {
          invalid++;
          r = await invoke(`Your assessment did not validate:\n- ${v.errors.slice(0, 15).join("\n- ")}\nReturn the corrected assessment now.`);
          if (r.stop) {
            ({ status, reason } = r.stop);
            break;
          }
          v = validateSubmission(structured(r.t!.result));
        }
        if (!v.ok) {
          invalid++;
          errors.push(`phase ${i}: ${v.errors.slice(0, 5).join("; ")}`);
          // Never reveal the next phase (e.g. the proposal) without a valid assessment for this one.
          status = /budget/i.test(String(r.t!.result?.subtype)) ? "budget_reached" : "failed";
          reason = `no valid assessment for phase ${i}`;
          break;
        }
        submissions.push(v.value);
        if (/budget/i.test(String(r.t!.result?.subtype ?? "")) || costUsd >= budgetUsd) {
          if (i < spec.phases.length - 1) {
            status = "budget_reached";
            reason = `max-budget-usd ${budgetUsd.toFixed(2)} reached (estimate $${costUsd.toFixed(2)})`;
            break;
          }
        }
      }
    } finally {
      if (!this.cfg.keepWorkdirs) fs.rmSync(workDir, { recursive: true, force: true });
      else spec.log(`work dir kept: ${workDir}`);
    }

    const drive: DriveResult = { status, reason, submissions, toolLog, deniedAsks: denials, invalidSubmissions: invalid, errors, lastUsage };
    return {
      runtime: "local-claude",
      sessionId,
      drive,
      listCostCents: Math.ceil(costUsd * 100),
      costSource: costIsUpperBound ? "subscription-upper-bound" : "subscription-estimate",
      usage: { ...(lastUsage ?? {}), total_cost_usd: costUsd, permission_denials: denials },
    };
  }

  async findOrphan(): Promise<string | null> {
    return null;
  }

  /** Works without the owning watcher: uses the recorded pid + session id. */
  async interrupt(sessionId: string): Promise<void> {
    const live = this.children.get(sessionId);
    if (live?.pid) {
      try {
        process.kill(-live.pid, "SIGTERM");
      } catch {
        live.kill("SIGTERM");
      }
      return;
    }
    const rows = this.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'local_child_%'").all() as Array<{ key: string; value: string }>;
    for (const r of rows) {
      const rec = JSON.parse(r.value) as ChildRecord | null;
      if (rec?.sessionId === sessionId) killRecorded(rec);
    }
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.children.keys()]) await this.interrupt(id);
  }

  async deleteUploads(): Promise<void> {
    /* nothing uploaded */
  }
}
