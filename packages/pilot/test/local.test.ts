import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getJob, kvGet, openDb } from "../src/db.ts";
import { LocalClaudeInvestigator } from "../src/investigator/local.ts";
import { runJob } from "../src/runner.ts";
import { enqueueJob } from "../src/scheduler.ts";
import { tempRepo, testConfig } from "./helpers.ts";

/** A stand-in `claude` executable that speaks the stream-json protocol and records how it was invoked. */
process.env.PILOT_WORK_ROOT = os.tmpdir(); // the fake claude binary does not need the short /private/tmp path

function fakeClaude(): { bin: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const log = path.join(dir, "calls.jsonl");
  const bin = path.join(dir, "claude");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), guard: process.env.PILOT_IN_INVESTIGATION, envKeys: Object.keys(process.env), files: fs.readdirSync(".") }) + "\\n");
const mode = process.env.FAKE_CLAUDE_MODE || "ok";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: "x", tools: [] });
if (mode === "sleep") { setTimeout(() => {}, 60000); return; }
if (mode === "quota-second" && /phase 2 of 2/.test(prompt)) { out({ type: "result", subtype: "success", is_error: true, api_error: "usage_limit_reached", api_error_status: 429, result: "You've hit your 5-hour limit", total_cost_usd: 0.05 }); process.exit(1); }
if (mode === "quota") { out({ type: "result", subtype: "success", is_error: true, api_error: "usage_limit_reached", api_error_status: 429, result: "You've hit your 5-hour limit", total_cost_usd: 0 }); process.exit(1); }
out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "node exp.mjs" } }] } });
out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "orders created: 3" }] } });
const phase = /phase 1 of 2/.test(prompt) ? "baseline" : /phase 2 of 2/.test(prompt) ? "comparison" : "checkpoint";
const bad = mode === "invalid-then-ok" && !/did not validate/.test(prompt);
const sub = bad ? { phase, summary: "x" } : { phase, summary: phase + " ok", findings: [{
  fingerprint: "dup-orders", issue_type: "defect", severity: "high", attribution: "introduced", proof: "source_proven", session_awareness: "unaware", risk_areas: ["money"], failure_case: "f", controls_checked: "c", category: "omission", title: "Retries duplicate orders", statement: "s", why_it_matters: "w",
  evidence: [{ type: "file", path: "src/a.js", quote: "export const a = 1;" }, { type: "command", command: "node exp.mjs", output_excerpt: "orders created: 3" }],
  confidence: 0.9, uncertainty: "u", suggested_next_action: "n", related_paths: ["src/a.js"] }] };
out({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.12, structured_output: sub, usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: [] });
`,
  );
  fs.chmodSync(bin, 0o755);
  return { bin, log };
}

const quiet = { shouldStop: () => false, log: () => {} };
const calls = (log: string) => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("local mode: two-phase onboarding via claude -p, resumed session, sandboxed, transcript-grounded", async () => {
  const { bin, log } = fakeClaude();
  process.env.AWS_SECRET_ACCESS_KEY = "AKIA-test-not-real";
  process.env.PILOT_TEST_SECRET = "x";
  const repo = tempRepo({ "src/a.js": "export const a = 1;\n" });
  const cfg = testConfig(repo, { mode: "local", claudeBin: bin, localEnvPassthrough: ["FAKE_CLAUDE_MODE"] });
  const db = openDb(cfg.stateDir);
  const jobId = enqueueJob(db, "onboarding", "quick", "onboard", { approach: "retry everything" });
  const r = await runJob(cfg, db, new LocalClaudeInvestigator(cfg, db), jobId, quiet);
  assert.equal(r.state, "finished");
  const job = getJob(db, jobId)!;
  assert.deepEqual([job.status, job.runtime, job.list_cost_cents, job.cost_source], ["done", "local-claude", 24, "subscription-estimate"]);

  const [c1, c2] = calls(log);
  const flag = (c: any, f: string) => c.args[c.args.indexOf(f) + 1];
  assert.equal(flag(c1, "--session-id"), flag(c2, "--resume"), "phase 2 resumes the phase 1 session");
  assert.match(flag(c1, "-p"), /phase 1 of 2/);
  assert.doesNotMatch(flag(c1, "-p"), /retry everything/, "approach hidden from phase 1");
  assert.match(flag(c2, "-p"), /retry everything/);
  assert.ok(!c1.cwd.startsWith(repo), "runs outside the repo (its .claude settings/hooks are not loaded)");
  assert.deepEqual(c1.files.sort(), ["context", "repo"]);
  assert.equal(c1.guard, "1", "hook recursion guard set");
  assert.equal(flag(c1, "--setting-sources"), "local", "no user/project settings inherited");
  assert.ok(c1.args.includes("--safe-mode"), "CLAUDE.md, plugins, hooks, MCP off");
  assert.ok(!c1.envKeys.includes("AWS_SECRET_ACCESS_KEY") && !c1.envKeys.includes("PILOT_TEST_SECRET"), "watcher env secrets are not inherited");
  assert.ok(c1.envKeys.includes("PATH") && c1.envKeys.includes("HOME"));
  const settings = JSON.parse(flag(c1, "--settings"));
  assert.equal(settings.disableAllHooks, true);
  assert.ok(settings.sandbox.filesystem.denyRead.includes("/Volumes") && settings.sandbox.filesystem.denyRead.includes("~/"));
  assert.ok(!settings.permissions.allow.includes("Read"), "file tools are not allowed outside the work dir");
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.ok(c1.args.includes("--strict-mcp-config") && c1.args.includes("WebFetch"));
  assert.equal(flag(c1, "--permission-mode"), "dontAsk");

  const f = db.prepare("SELECT status, grounding FROM findings").get() as { status: string; grounding: string };
  const g = JSON.parse(f.grounding);
  assert.equal(g.status, "grounded");
  assert.equal(g.verified, 2, "command evidence verified against the local run's own transcript");
});

test("local mode: a usage limit in phase 2 keeps the cost already spent on the job's books", async () => {
  const { bin } = fakeClaude();
  process.env.FAKE_CLAUDE_MODE = "quota-second";
  try {
    const repo = tempRepo({ "src/a.js": "export const a = 1;\n" });
    const cfg = testConfig(repo, { mode: "local", claudeBin: bin, localEnvPassthrough: ["FAKE_CLAUDE_MODE"] });
    const db = openDb(cfg.stateDir);
    const jobId = enqueueJob(db, "onboarding", "quick", "onboard", { approach: "x" });
    const r = await runJob(cfg, db, new LocalClaudeInvestigator(cfg, db), jobId, quiet);
    assert.equal(r.state, "blocked");
    const j = getJob(db, jobId)!;
    assert.equal(j.status, "queued");
    assert.equal(j.prior_cost_cents, 17, "12c phase 1 + 5c of the limited phase 2 stay counted");
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }
});

test("local mode: invalid structured output gets one correction turn", async () => {
  const { bin, log } = fakeClaude();
  process.env.FAKE_CLAUDE_MODE = "invalid-then-ok";
  try {
    const repo = tempRepo({ "src/a.js": "export const a = 1;\n" });
    const cfg = testConfig(repo, { mode: "local", claudeBin: bin, localEnvPassthrough: ["FAKE_CLAUDE_MODE"] });
    const db = openDb(cfg.stateDir);
    const jobId = enqueueJob(db, "manual", "quick", "manual", undefined);
    await runJob(cfg, db, new LocalClaudeInvestigator(cfg, db), jobId, quiet);
    assert.equal(calls(log).length, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM findings").get()?.n, 1);
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }
});

test("local mode: a usage limit holds the job (queued, not failed); a deadline kills the run", async () => {
  const { bin } = fakeClaude();
  const repo = tempRepo({ "src/a.js": "export const a = 1;\n" });
  const cfg = testConfig(repo, { mode: "local", claudeBin: bin, localEnvPassthrough: ["FAKE_CLAUDE_MODE"] });
  const db = openDb(cfg.stateDir);
  process.env.FAKE_CLAUDE_MODE = "quota";
  try {
    const jobId = enqueueJob(db, "manual", "quick", "manual", undefined);
    const r = await runJob(cfg, db, new LocalClaudeInvestigator(cfg, db), jobId, quiet);
    assert.equal(r.state, "blocked");
    assert.equal(getJob(db, jobId)?.status, "queued");
    assert.ok(kvGet<{ until: string } | null>(db, "quota_hold", null)?.until);

    process.env.FAKE_CLAUDE_MODE = "sleep";
    const cfg2 = { ...cfg, runTimeoutSec: 1 };
    const j2 = enqueueJob(db, "deep", "deep", "manual", undefined);
    const t0 = Date.now();
    const r2 = await runJob({ ...cfg2, deepRunTimeoutSec: 1 }, db, new LocalClaudeInvestigator(cfg2, db), j2, quiet);
    assert.equal(r2.state, "finished");
    assert.equal(getJob(db, j2)?.status, "timed_out");
    assert.ok(Date.now() - t0 < 55_000, "killed at the deadline, not after the fake's 60 s sleep (the bound is loose: under machine load the snapshot alone takes many seconds)");
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }
});
