import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { envVar, repoStateDir, setting } from "./home.ts";

export const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let envLoaded = false;
/** Load the tool's own .env (development checkouts only; never the watched repo's .env). Existing env vars win. */
export function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const p = path.join(TOOL_ROOT, ".env");
  if (fs.existsSync(p)) process.loadEnvFile(p);
}

export type Mode = "live" | "local" | "offline";
export type PromptReview = "early" | "merge" | "off";
export type Delivery = "session" | "inbox";

export interface Config {
  repoRoot: string;
  stateDir: string;
  mode: Mode;
  model: string;
  quickEffort: "low" | "medium" | "high" | "xhigh" | "max";
  deepEffort: "low" | "medium" | "high" | "xhigh" | "max";
  runBudgetCents: number;
  deepRunBudgetCents: number;
  dailyBudgetCents: number;
  budgetWindowHours: number;
  overshootCents: number;
  minRunCents: number;
  runTimeoutSec: number;
  deepRunTimeoutSec: number;
  maxConcurrent: number;
  minRunIntervalMin: number;
  staleEventHours: number;
  quietMs: number;
  promptQuietMs: number;
  maxBatchAgeMs: number;
  pollMs: number;
  promptReview: PromptReview;
  autoDeep: boolean;
  permissionPolicy: "auto" | "always_allow";
  workspace: string;
  deleteUploads: boolean;
  maxFileBytes: number;
  maxSnapshotBytes: number;
  fixturesDir: string;
  fakeStepMs: number;
  simulatedCostScale: number;
  claudeBin: string;
  localMaxTurns: number;
  deepLocalMaxTurns: number;
  quotaBackoffMin: number;
  keepWorkdirs: boolean;
  localSafeMode: boolean;
  localEnvPassthrough: string[];
  delivery: Delivery;
  snapshotUntracked: "work" | "all";
  speakMinConfidence: number;
  speakSpacingMin: number;
  speakMaxFindings: number;
  speakRiskAreas: string[];
  demoteAfterDismissals: number;
  deliverWaitSec: number;
  autostart: boolean;
  daemonIdleExitMin: number;
  /** The old job: review finished work (edits, tests, stops). Off by default; events are still recorded as context. */
  reviewWork: boolean;
  /** Prompt watching (promptWatch.ts): the model that checks each prompt and answers chat questions. Never Haiku. */
  promptCheckModel: string;
  promptCheckEffort: "low" | "medium" | "high" | "xhigh" | "max";
  promptCheckTimeoutSec: number;
  promptCheckBudgetCents: number;
  askTimeoutSec: number;
  nudgeMinConfidence: number;
  nudgeToSession: NudgeToSession;
  /** What Pilot thinks with for prompt checks and chat answers (engines.ts). */
  engine: ThinkEngine;
  engineFallback: boolean;
  codexBin: string;
  codexModel: string;
  codexDailyRuns: number;
}

export type NudgeToSession = "risky" | "all" | "off";
export const THINK_ENGINES = ["claude", "codex"] as const;
export type ThinkEngine = (typeof THINK_ENGINES)[number];

/** Haiku is never used for prompt checks or answers (owner rule); such a setting falls back to Sonnet. */
export const notHaiku = (model: string): string => (/haiku/i.test(model) ? "sonnet" : model);

// Every setting: env PILOT_X (else LOOKOUT_X) > ~/.pilot/config.json "x" > default.
const num = (name: string, def: number): number => {
  const v = setting(name);
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
};
const str = <T extends string>(name: string, def: T, allowed?: readonly T[]): T => {
  const v = (setting(name) ?? "").trim();
  if (!v) return def;
  if (allowed && !allowed.includes(v as T)) throw new Error(`${name} must be one of ${allowed.join("|")}, got "${v}"`);
  return v as T;
};
const list = (name: string, def: string[]): string[] => {
  const v = setting(name);
  return v === undefined ? def : v.split(",").map((x) => x.trim()).filter(Boolean);
};
const bool = (name: string, def: boolean): boolean => {
  const v = setting(name);
  if (v === undefined || v === "") return def;
  return /^(1|true|yes|on)$/i.test(v);
};

/** Resolve a repository: explicit flag > PILOT_REPO > CLAUDE_PROJECT_DIR > git toplevel of cwd. */
export function resolveRepo(explicit?: string): string {
  const candidate = explicit || envVar("REPO") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const abs = path.resolve(candidate);
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: abs, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return abs;
  }
}

export function loadConfig(repoArg?: string, opts: { cheap?: boolean } = {}): Config {
  loadEnv();
  // The hook path must stay fast: skip the git subprocess when the repo is given explicitly.
  const repoRoot = opts.cheap && repoArg ? path.resolve(repoArg) : resolveRepo(repoArg);
  const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
  return {
    repoRoot,
    stateDir: repoStateDir(repoRoot),
    mode: str<Mode>("PILOT_MODE", "local", ["live", "local", "offline"]),
    model: str("PILOT_MODEL", "claude-opus-5-5"),
    quickEffort: str("PILOT_QUICK_EFFORT", "medium", efforts),
    deepEffort: str("PILOT_DEEP_EFFORT", "high", efforts),
    runBudgetCents: num("PILOT_RUN_BUDGET_CENTS", 75),
    deepRunBudgetCents: num("PILOT_DEEP_RUN_BUDGET_CENTS", 300),
    dailyBudgetCents: num("PILOT_DAILY_BUDGET_CENTS", 1000),
    budgetWindowHours: num("PILOT_BUDGET_WINDOW_HOURS", 24),
    overshootCents: num("PILOT_OVERSHOOT_CENTS", 40),
    minRunCents: num("PILOT_MIN_RUN_CENTS", 20),
    runTimeoutSec: num("PILOT_RUN_TIMEOUT_SEC", 600),
    deepRunTimeoutSec: num("PILOT_DEEP_RUN_TIMEOUT_SEC", 1500),
    maxConcurrent: Math.max(1, num("PILOT_MAX_CONCURRENT", 1)),
    minRunIntervalMin: num("PILOT_MIN_RUN_INTERVAL_MIN", 5),
    staleEventHours: num("PILOT_STALE_EVENT_HOURS", 12),
    quietMs: num("PILOT_QUIET_MS", 20_000),
    promptQuietMs: num("PILOT_PROMPT_QUIET_MS", 8_000),
    maxBatchAgeMs: num("PILOT_MAX_BATCH_AGE_MS", 300_000),
    pollMs: num("PILOT_POLL_MS", 1_000),
    promptReview: str<PromptReview>("PILOT_PROMPT_REVIEW", "merge", ["early", "merge", "off"]),
    autoDeep: bool("PILOT_AUTO_DEEP", false),
    permissionPolicy: str("PILOT_PERMISSION_POLICY", "auto", ["auto", "always_allow"] as const),
    workspace: str("PILOT_CONSOLE_WORKSPACE", "default"),
    deleteUploads: bool("PILOT_DELETE_UPLOADS", true),
    maxFileBytes: num("PILOT_MAX_FILE_BYTES", 256 * 1024),
    maxSnapshotBytes: num("PILOT_MAX_SNAPSHOT_BYTES", 15 * 1024 * 1024),
    fixturesDir: envVar("FIXTURES_DIR") || path.join(TOOL_ROOT, "fixtures", "offline"),
    fakeStepMs: num("PILOT_FAKE_STEP_MS", 20),
    simulatedCostScale: num("PILOT_SIMULATED_COST_SCALE", 1),
    claudeBin: setting("PILOT_CLAUDE_BIN") || "claude",
    localMaxTurns: num("PILOT_LOCAL_MAX_TURNS", 40),
    deepLocalMaxTurns: num("PILOT_DEEP_LOCAL_MAX_TURNS", 100),
    quotaBackoffMin: num("PILOT_QUOTA_BACKOFF_MIN", 30),
    keepWorkdirs: bool("PILOT_KEEP_WORKDIRS", false),
    localSafeMode: bool("PILOT_LOCAL_SAFE_MODE", true),
    localEnvPassthrough: list("PILOT_LOCAL_ENV_PASSTHROUGH", []),
    delivery: str<Delivery>("PILOT_DELIVERY", "session", ["session", "inbox"]),
    snapshotUntracked: str("PILOT_SNAPSHOT_UNTRACKED", "work", ["work", "all"] as const),
    speakMinConfidence: num("PILOT_SPEAK_MIN_CONFIDENCE", 0.7),
    speakSpacingMin: num("PILOT_SPEAK_SPACING_MIN", 30),
    speakMaxFindings: Math.max(1, num("PILOT_SPEAK_MAX_FINDINGS", 2)),
    speakRiskAreas: list("PILOT_SPEAK_RISK_AREAS", ["money", "security", "privacy", "data_loss", "production", "irreversible"]),
    demoteAfterDismissals: num("PILOT_DEMOTE_AFTER_DISMISSALS", 3),
    deliverWaitSec: num("PILOT_DELIVER_WAIT_SEC", 900),
    autostart: bool("PILOT_AUTOSTART", true),
    daemonIdleExitMin: num("PILOT_DAEMON_IDLE_EXIT_MIN", 120),
    reviewWork: bool("PILOT_REVIEW_WORK", false),
    promptCheckModel: notHaiku(str("PILOT_PROMPT_CHECK_MODEL", "sonnet")),
    promptCheckEffort: str("PILOT_PROMPT_CHECK_EFFORT", "low", efforts),
    promptCheckTimeoutSec: num("PILOT_PROMPT_CHECK_TIMEOUT_SEC", 90),
    promptCheckBudgetCents: num("PILOT_PROMPT_CHECK_BUDGET_CENTS", 30),
    askTimeoutSec: num("PILOT_ASK_TIMEOUT_SEC", 60),
    nudgeMinConfidence: num("PILOT_NUDGE_MIN_CONFIDENCE", 0.7),
    nudgeToSession: str<NudgeToSession>("PILOT_NUDGE_TO_SESSION", "all", ["risky", "all", "off"]),
    engine: str<ThinkEngine>("PILOT_ENGINE", "claude", THINK_ENGINES),
    engineFallback: bool("PILOT_ENGINE_FALLBACK", true),
    codexBin: setting("PILOT_CODEX_BIN") || "codex",
    codexModel: str("PILOT_CODEX_MODEL", "gpt-6.1-sol"),
    codexDailyRuns: num("PILOT_CODEX_DAILY_RUNS", 40),
  };
}

/**
 * True when the Anthropic SDK can find a credential without us reading it:
 * API key, auth token, or an `ant auth login` profile directory with content.
 */
export function hasAnthropicCredentials(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE) return true;
  if (process.env.ANTHROPIC_FEDERATION_RULE_ID && process.env.ANTHROPIC_ORGANIZATION_ID) return true;
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "anthropic");
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
