import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, type Config } from "../src/config.ts";

// Tests never touch the real ~/.lookout: one private home per test process.
process.env.PILOT_HOME = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lookout-home-"));
process.env.PILOT_PROFILES = "*";
// Most suites exercise the work review, which is off by default since prompt watching took over (README).
process.env.PILOT_REVIEW_WORK ??= "1";
// Never a real model run from unit tests (the tool's .env names a real claude wrapper): tests that need one pass a fake.
process.env.PILOT_CLAUDE_BIN = path.join(os.tmpdir(), "no-real-claude-in-unit-tests");
process.env.PILOT_CODEX_BIN = path.join(os.tmpdir(), "no-real-codex-in-unit-tests");

export function tempRepo(files: Record<string, string> = {}, commit = true): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lookout-test-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  if (commit && Object.keys(files).length) {
    git("add", "-A");
    git("commit", "-qm", "init");
  }
  return dir;
}

export function testConfig(repo: string, over: Partial<Config> = {}): Config {
  process.env.PILOT_MODE = "offline";
  process.env.PILOT_LOCAL_SKIP_SELFTEST = "1"; // unit tests use a fake claude binary; the real check is `lookout selftest`
  return { ...loadConfig(repo), fakeStepMs: 1, ...over };
}

export const write = (repo: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
};

export interface FakeRule {
  /** Every one of these substrings must appear in the prompt sent on stdin. */
  match: string[];
  output?: unknown;
  sleepMs?: number;
  costUsd?: number;
}

/**
 * A stand-in `claude` for one-shot runs (prompt checks, chat answers): reads the prompt from stdin, logs the call,
 * answers with the first rule whose substrings all appear (else a silent verdict), in stream-json.
 */
export function fakeOneShot(rules: FakeRule[]): { bin: string; log: string; calls: () => Array<{ args: string[]; stdin: string; env: string[] }> } {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fake-oneshot-"));
  const log = path.join(dir, "calls.jsonl");
  const bin = path.join(dir, "claude");
  fs.writeFileSync(path.join(dir, "rules.json"), JSON.stringify(rules));
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), stdin, env: Object.keys(process.env) }) + "\\n");
  const rules = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, "rules.json"))}, "utf8"));
  const rule = rules.find((r) => r.match.every((m) => stdin.includes(m)));
  const silent = { why: "nothing forgotten", speak: false, kind: "none", confidence: 0, evidence: [], text: "", for_session: "" };
  // ref "auto": the id of the source block the quote sits in, as a model would cite it.
  const refFor = (q) => { const i = stdin.indexOf(q); if (i < 0) return "R999"; const m = [...stdin.slice(0, i).matchAll(/\\[([PSRN]\\d+)\\]/g)].pop(); return m ? m[1] : "R999"; };
  if (rule && rule.output && Array.isArray(rule.output.evidence)) rule.output.evidence = rule.output.evidence.map((e) => (e.ref === "auto" ? { ...e, ref: refFor(e.quote) } : e));
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "system", subtype: "init", tools: ["StructuredOutput"] });
  const done = () => out({ type: "result", subtype: "success", is_error: false, total_cost_usd: rule && rule.costUsd !== undefined ? rule.costUsd : 0.04, structured_output: rule && rule.output !== undefined ? rule.output : silent });
  if (rule && rule.sleepMs) setTimeout(done, rule.sleepMs); else done();
});
`,
  );
  fs.chmodSync(bin, 0o755);
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin, log, calls };
}

/**
 * A stand-in `codex`: `--version`, `login status` and `exec` (prompt on stdin; answer written to the `-o` file).
 * mode "signed-out" answers like a signed-out CLI; "slow" waits before answering.
 */
export function fakeCodex(rules: FakeRule[], mode: "ok" | "signed-out" | "slow" = "ok"): { bin: string; calls: () => Array<{ args: string[]; stdin: string }> } {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fake-codex-"));
  const log = path.join(dir, "calls.jsonl");
  const bin = path.join(dir, "codex");
  fs.writeFileSync(path.join(dir, "rules.json"), JSON.stringify(rules));
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
if (args[0] === "--version") { console.log("codex-cli 0.0.0-fake"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { if (mode === "signed-out") { console.error("Not logged in"); process.exit(1); } console.log("Logged in using ChatGPT"); process.exit(0); }
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin }) + "\\n");
  if (mode === "signed-out") { console.error("Error: Not logged in. Run codex login."); process.exit(1); }
  const rules = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, "rules.json"))}, "utf8"));
  const rule = rules.find((r) => r.match.every((m) => stdin.includes(m)));
  const silent = { why: "nothing forgotten", speak: false, kind: "none", confidence: 0, evidence: [], text: "", for_session: "" };
  const out = args[args.indexOf("-o") + 1];
  setTimeout(() => { fs.writeFileSync(out, JSON.stringify(rule && rule.output !== undefined ? rule.output : silent)); process.exit(0); }, mode === "slow" ? 20000 : 0);
});
`,
  );
  fs.chmodSync(bin, 0o755);
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin, calls };
}
