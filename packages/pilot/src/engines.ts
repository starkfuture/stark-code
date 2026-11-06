/**
 * What Pilot thinks with for prompt checks and chat answers: Claude (default) or Codex, chosen by the person
 * (setting `engine`, or per question). Both get the same text-only context and return the same JSON schema.
 *
 *  - Claude: the isolated `claude -p` runner (oneshot.ts): no tools, safe mode, minimal environment, refuses to run
 *    without a passing isolation self-test; costs an API-equivalent estimate against the daily budget.
 *  - Codex: `codex exec` with `codex_model` (gpt-6.1-sol), a read-only sandbox, an empty private work dir, no user
 *    config or rules (`--ignore-user-config --ignore-rules`), `--ephemeral`, `--output-schema` + `-o` for the answer.
 *    It uses the person's Codex plan, not dollars: capped at `codex_daily_runs` per rolling 24 h.
 *  - When Codex's runs are used up, Claude runs instead. With `engine_fallback` (default on), a run whose engine is
 *    unavailable (not installed, signed out, usage limit, Claude's self-test missing or its budget used up) runs on the
 *    other one. Either way the result carries a plain note saying so. Pilot never starts a login for either.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Config, ThinkEngine } from "./config.ts";
import type { DB } from "./home.ts";
import { makeWorkDir, minimalEnv } from "./investigator/local.ts";
import { runOneShot, type OneShotResult } from "./oneshot.ts";
import { machineBudget } from "./budget.ts";
import { selfTestStatus } from "./selftest.ts";

export interface ThinkSpec {
  system: string;
  input: string;
  schema: Record<string, unknown>;
  timeoutMs: number;
  prefix: "cpw-" | "cpa-";
  shouldStop?: () => boolean;
  onSpawn?: (c: ChildProcess) => void;
}

export interface ThinkResult extends OneShotResult {
  engine: ThinkEngine;
  /** Plain words when the run did not use the engine that was asked for, e.g. "Codex is signed out". */
  fallback: string | null;
}

export const ENGINE_NAME: Record<ThinkEngine, string> = { claude: "Claude", codex: "Codex" };

/** Codex runs in the rolling budget window (prompt checks and answers). */
export function codexRunsUsed(reg: DB, cfg: Pick<Config, "budgetWindowHours">, nowMs = Date.now()): number {
  return Number((reg.prepare("SELECT COUNT(*) AS n FROM watch_runs WHERE engine = 'codex' AND created_ms >= ?").get(nowMs - cfg.budgetWindowHours * 3600_000) as { n: number }).n);
}

export const codexRunsLeft = (reg: DB, cfg: Pick<Config, "budgetWindowHours" | "codexDailyRuns">, nowMs = Date.now()): number => Math.max(0, cfg.codexDailyRuns - codexRunsUsed(reg, cfg, nowMs));

const EFFORT: Record<Config["promptCheckEffort"], string> = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };
const CODEX_ENV = ["CODEX_HOME", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];

export function codexArgs(cfg: Pick<Config, "codexModel" | "promptCheckEffort">, workDir: string, schemaFile: string, outFile: string): string[] {
  return [
    "exec",
    "-m",
    cfg.codexModel,
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--output-schema",
    schemaFile,
    "-o",
    outFile,
    "-C",
    workDir,
    "-c",
    `model_reasoning_effort="${EFFORT[cfg.promptCheckEffort]}"`,
    "-",
  ];
}

/** Plain-words reason for a failed Codex run, from its exit and stderr (never shown raw). */
export function codexFailure(code: number | null, stderr: string, spawnError?: string): { reason: string; unavailable: boolean } {
  if (spawnError && /ENOENT/.test(spawnError)) return { reason: "Codex is not installed", unavailable: true };
  if (/not logged in|log ?in required|please (log|sign) in|unauthori[sz]ed|\b401\b|auth(entication)? (error|failed)|token (has )?expired/i.test(stderr)) return { reason: "Codex is signed out", unavailable: true };
  if (/rate.?limit|usage limit|\b429\b|quota|too many requests/i.test(stderr)) return { reason: "Codex hit its usage limit", unavailable: true };
  return { reason: `Codex stopped without an answer (exit ${code ?? "?"})`, unavailable: false };
}

export async function runCodex(cfg: Config, spec: ThinkSpec): Promise<OneShotResult & { unavailable?: boolean }> {
  const started = Date.now();
  const workDir = makeWorkDir("cpx-");
  const schemaFile = path.join(workDir, "schema.json");
  const outFile = path.join(workDir, "answer.json");
  try {
    fs.writeFileSync(schemaFile, JSON.stringify(spec.schema));
    const input = `${spec.system}\n\nWork only from the text below. Do not run commands or read files: everything you need is here.\n\n---\n\n${spec.input}`;
    const r = await new Promise<{ code: number | null; stderr: string; killed: "deadline" | "stop" | null; spawnError?: string }>((resolve) => {
      let stderr = "";
      let killed: "deadline" | "stop" | null = null;
      const child = spawn(cfg.codexBin, codexArgs(cfg, workDir, schemaFile, outFile), {
        cwd: workDir,
        env: minimalEnv({ TMPDIR: workDir, NO_COLOR: "1" }, CODEX_ENV),
        stdio: ["pipe", "ignore", "pipe"],
        detached: true,
      });
      spec.onSpawn?.(child);
      child.stdin!.on("error", () => {});
      child.stdin!.end(input);
      child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
      const kill = (why: "deadline" | "stop") => {
        if (killed) return;
        killed = why;
        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            /* gone */
          }
        }, 1500).unref();
      };
      const timer = setInterval(() => {
        if (spec.shouldStop?.()) kill("stop");
        else if (Date.now() > started + spec.timeoutMs) kill("deadline");
      }, 250);
      child.on("close", (code) => {
        clearInterval(timer);
        resolve({ code, stderr, killed });
      });
      child.on("error", (e) => {
        clearInterval(timer);
        resolve({ code: -1, stderr, killed, spawnError: `${(e as NodeJS.ErrnoException).code ?? ""} ${e.message}` });
      });
    });
    const base = { costCents: 0, costUpperBound: false, durationMs: Date.now() - started };
    if (r.killed) return { ok: false, output: null, ...base, timedOut: r.killed === "deadline", error: r.killed === "deadline" ? `no answer within ${Math.round(spec.timeoutMs / 1000)} s` : "cancelled" };
    let output: unknown = null;
    try {
      output = JSON.parse(fs.readFileSync(outFile, "utf8"));
    } catch {
      output = null;
    }
    if (r.code === 0 && output && typeof output === "object") return { ok: true, output, ...base };
    const f = codexFailure(r.code, r.stderr, r.spawnError);
    return { ok: false, output: null, ...base, error: f.reason, unavailable: f.unavailable };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Whether a failed Claude run means "Claude cannot run now" (worth falling back) rather than a bad answer. */
const claudeUnavailable = (r: OneShotResult): boolean => /self-test|usage limit|without a result|ENOENT|budget/i.test(r.error ?? "") && !r.timedOut;

function claudeBudgetNote(cfg: Config, cents: number): string | null {
  const b = machineBudget(cfg);
  return b.availableCents >= cents ? null : `Pilot's daily budget for Claude is used up ($${(b.spentCents / 100).toFixed(2)} of $${(b.capCents / 100).toFixed(2)})`;
}

async function runClaude(cfg: Config, spec: ThinkSpec): Promise<OneShotResult & { unavailable?: boolean }> {
  const noRoom = claudeBudgetNote(cfg, cfg.promptCheckBudgetCents);
  if (noRoom) return { ok: false, output: null, costCents: 0, costUpperBound: false, durationMs: 0, error: noRoom, unavailable: true };
  const r = await runOneShot(cfg, {
    system: spec.system,
    input: spec.input,
    schema: spec.schema,
    model: cfg.promptCheckModel,
    effort: cfg.promptCheckEffort,
    timeoutMs: spec.timeoutMs,
    budgetCents: cfg.promptCheckBudgetCents,
    prefix: spec.prefix,
    shouldStop: spec.shouldStop,
    onSpawn: spec.onSpawn,
  });
  if (!r.ok && claudeUnavailable(r)) {
    const reason = /self-test/.test(r.error ?? "") ? "Claude's isolation self-test has not passed yet" : /usage limit/.test(r.error ?? "") ? "Claude hit its usage limit" : "Claude could not start";
    return { ...r, error: reason, unavailable: true };
  }
  return r;
}

const runOn = (e: ThinkEngine, cfg: Config, spec: ThinkSpec) => (e === "codex" ? runCodex(cfg, spec) : runClaude(cfg, spec));

/** One run on the chosen engine, or on the other one when the chosen one cannot run (see the header). */
export async function think(reg: DB, cfg: Config, chosen: ThinkEngine, spec: ThinkSpec): Promise<ThinkResult> {
  let engine = chosen;
  let fallback: string | null = null;
  if (engine === "codex" && codexRunsLeft(reg, cfg) <= 0) {
    engine = "claude";
    fallback = `today's ${cfg.codexDailyRuns} Codex runs are used up`;
  }
  const first = await runOn(engine, cfg, spec);
  if (first.ok || fallback || !first.unavailable || !cfg.engineFallback || spec.shouldStop?.()) return { ...first, engine, fallback };
  const other: ThinkEngine = engine === "codex" ? "claude" : "codex";
  if (other === "codex" && codexRunsLeft(reg, cfg) <= 0) return { ...first, engine, fallback: null };
  const second = await runOn(other, cfg, { ...spec, timeoutMs: Math.max(10_000, spec.timeoutMs - first.durationMs) });
  return { ...second, costCents: second.costCents + first.costCents, engine: other, fallback: first.error ?? `${ENGINE_NAME[engine]} could not run` };
}

/** The sentence added to a message that came from the other engine. */
export const fallbackNote = (r: Pick<ThinkResult, "engine" | "fallback">): string => (r.fallback ? ` (${ENGINE_NAME[r.engine]} answered: ${r.fallback}.)` : "");

// ---------------------------------------------------------------------------------------------------------------
// Availability, for `pilot api settings` (never starts a login)

export interface EngineState {
  available: boolean;
  note: string | null;
}

function runs(bin: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], env: minimalEnv({ NO_COLOR: "1" }, CODEX_ENV) });
    return { ok: r.status === 0, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
  } catch {
    return { ok: false, out: "" };
  }
}

interface Probe {
  at: number;
  key: string;
  claude: boolean;
  codex: boolean;
  codexSignedIn: boolean;
}

/** Whether the binaries start and Codex is signed in; probed at most every 5 minutes (the UI asks every 60 s). */
function probe(reg: DB, cfg: Config, nowMs: number): Probe {
  const key = `${cfg.claudeBin}\n${cfg.codexBin}`;
  const row = reg.prepare("SELECT value FROM kv WHERE key = 'engine_probe'").get() as { value: string } | undefined;
  try {
    const p = row ? (JSON.parse(row.value) as Probe) : null;
    if (p && p.key === key && nowMs - p.at < 5 * 60_000) return p;
  } catch {
    /* re-probe */
  }
  const codex = runs(cfg.codexBin, ["--version"]).ok;
  const login = codex ? runs(cfg.codexBin, ["login", "status"]) : null;
  const p: Probe = { at: nowMs, key, claude: runs(cfg.claudeBin, ["--version"]).ok, codex, codexSignedIn: !!login && login.ok && !/not logged in/i.test(login.out) };
  reg.prepare("INSERT INTO kv(key, value) VALUES ('engine_probe', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(p));
  return p;
}

export function engineStates(reg: DB, cfg: Config, nowMs = Date.now()): { claude: EngineState; codex: EngineState & { runsLeftToday: number } } {
  const p = probe(reg, cfg, nowMs);
  const st = p.claude ? selfTestStatus(cfg) : null;
  const budget = p.claude ? machineBudget(cfg) : null;
  const noRoom = !!budget && budget.availableCents < cfg.promptCheckBudgetCents;
  const claude: EngineState = {
    available: p.claude && !noRoom,
    note: !p.claude
      ? "Claude Code is not installed"
      : noRoom
        ? `Daily budget reached ($${(budget!.spentCents / 100).toFixed(2)} of $${(budget!.capCents / 100).toFixed(2)})`
        : st && !st.ok
          ? "Runs a one-minute safety check before its first answer"
          : null,
  };
  const runsLeftToday = codexRunsLeft(reg, cfg, nowMs);
  const codex: EngineState = !p.codex
    ? { available: false, note: "Codex is not installed" }
    : !p.codexSignedIn
      ? { available: false, note: "Not signed in to Codex" }
      : runsLeftToday <= 0
        ? { available: false, note: "Daily Codex limit reached" }
        : { available: true, note: "Uses your Codex plan" };
  return { claude, codex: { ...codex, runsLeftToday } };
}
