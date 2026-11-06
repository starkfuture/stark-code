import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.ts";
import { codexArgs, codexFailure, think } from "../src/engines.ts";
import { macKeychain } from "../src/engine.ts";
import { openRegistry, setting, type DB } from "../src/home.ts";
import { fakeCodex, fakeOneShot } from "./helpers.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PILOT_WORK_ROOT = os.tmpdir();
process.env.PILOT_LOCAL_SKIP_SELFTEST = "1";
process.env.PILOT_MODE = "local";

function freshHome(): DB {
  process.env.PILOT_HOME = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pilot-home-"));
  return openRegistry();
}

function cli(args: string[], env: Record<string, string | undefined> = {}, o: { onSpawn?: (pid: number) => void } = {}): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const full: NodeJS.ProcessEnv = { ...process.env, PILOT_AUTOSTART: "0", ...env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete full[k];
    const c = spawn(path.join(ROOT, "scripts", "pilot"), args, { env: full });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    c.stdin.end();
    if (c.pid) o.onSpawn?.(c.pid);
  });
}

const SCHEMA = { type: "object", properties: { text: { type: "string" }, evidence: { type: "array" } }, required: ["text", "evidence"] };
const spec = (input: string) => ({ system: "You are Pilot.", input, schema: SCHEMA, timeoutMs: 10_000, prefix: "cpa-" as const });

test("PILOT_* settings win, the older LOOKOUT_* still work, config.json last", () => {
  freshHome();
  fs.writeFileSync(path.join(process.env.PILOT_HOME!, "config.json"), JSON.stringify({ speak_spacing_min: 12 }));
  assert.equal(setting("PILOT_SPEAK_SPACING_MIN"), "12");
  process.env.LOOKOUT_SPEAK_SPACING_MIN = "20";
  assert.equal(setting("PILOT_SPEAK_SPACING_MIN"), "20", "the old name still works");
  process.env.PILOT_SPEAK_SPACING_MIN = "30";
  assert.equal(setting("PILOT_SPEAK_SPACING_MIN"), "30", "the new name wins");
  delete process.env.LOOKOUT_SPEAK_SPACING_MIN;
  delete process.env.PILOT_SPEAK_SPACING_MIN;
  assert.equal(loadConfig(process.env.PILOT_HOME!, { cheap: true }).engine, "claude", "Claude is the default engine");
});

test("first start: ~/.lookout is copied to ~/.pilot through SQLite, locks cleared, the original left exactly as it was", async () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pilot-userhome-"));
  const old = path.join(home, ".lookout");
  fs.mkdirSync(path.join(old, "repos", "shop-1"), { recursive: true });
  fs.mkdirSync(path.join(old, "bin"));
  fs.mkdirSync(path.join(old, "repos", "shop-1", "snapshots", "ws_1"), { recursive: true });
  fs.writeFileSync(path.join(old, "repos", "shop-1", "snapshots", "ws_1", "big.txt"), "x".repeat(1000));
  fs.writeFileSync(path.join(old, "bin", "lookout"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(old, "config.json"), JSON.stringify({ daily_budget_cents: 777 }));
  // A live registry: WAL mode, with the newest rows still in the WAL (no checkpoint), and a running daemon's lock.
  const reg = new DatabaseSync(path.join(old, "registry.db"));
  reg.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE marker (v TEXT)");
  reg.prepare("INSERT INTO kv VALUES ('daemon', ?), ('paused', 'true')").run(JSON.stringify({ pid: process.pid, host: os.hostname(), heartbeat: Date.now() }));
  reg.prepare("INSERT INTO marker VALUES ('only in the WAL')").run();
  const repo = new DatabaseSync(path.join(old, "repos", "shop-1", "lookout.db"));
  repo.exec("PRAGMA journal_mode=WAL; CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv VALUES ('watcher', '{\"pid\":1}'), ('tree_fp', '\"x\"')");
  const digest = (dir: string) =>
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => `${path.relative(dir, path.join(e.parentPath, e.name))}:${crypto.createHash("sha256").update(fs.readFileSync(path.join(e.parentPath, e.name))).digest("hex")}`)
      .sort()
      .join("\n");
  const before = digest(old);
  const r = await cli(["api", "status"], { HOME: home, PILOT_HOME: undefined, LOOKOUT_HOME: undefined });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const st = JSON.parse(r.stdout);
  const pilot = path.join(home, ".pilot");
  assert.equal(st.home, pilot);
  assert.equal(st.paused, true, "the copied registry is in use");
  assert.equal(st.budget.capCents, 777, "the copied config is in use");
  assert.equal(digest(old), before, "~/.lookout is untouched");
  assert.ok(fs.existsSync(path.join(pilot, "migrated-from-lookout.json")));
  assert.ok(!fs.existsSync(path.join(pilot, "bin", "lookout")), "the old launcher is not copied");
  assert.ok(!fs.existsSync(path.join(pilot, "repos", "shop-1", "snapshots")), "review snapshots are not copied");
  const copy = new DatabaseSync(path.join(pilot, "registry.db"));
  assert.equal((copy.prepare("SELECT v FROM marker").get() as { v: string }).v, "only in the WAL", "rows still in the WAL were copied");
  assert.equal(copy.prepare("SELECT value FROM kv WHERE key = 'daemon'").get(), undefined, "the old daemon's lock is not carried over");
  const copyRepo = new DatabaseSync(path.join(pilot, "repos", "shop-1", "lookout.db"));
  assert.deepEqual((copyRepo.prepare("SELECT key FROM kv ORDER BY key").all() as Array<{ key: string }>).map((x) => x.key), ["tree_fp"]);
  reg.close();
  repo.close();
  // Never again once ~/.pilot exists.
  fs.writeFileSync(path.join(old, "config.json"), JSON.stringify({ daily_budget_cents: 1 }));
  assert.equal(JSON.parse((await cli(["api", "status"], { HOME: home, PILOT_HOME: undefined, LOOKOUT_HOME: undefined })).stdout).budget.capCents, 777);
});

test("engines: Codex runs read-only with the same schema; signed out or used up falls back to Claude and says so", async () => {
  const reg = freshHome();
  const answer = { text: "C asked which sandbox to use.", evidence: [] };
  const codex = fakeCodex([{ match: ["what's waiting"], output: answer }]);
  const claude = fakeOneShot([{ match: ["what's waiting"], output: { text: "from Claude", evidence: [] } }]);
  const cfg = { ...loadConfig(process.env.PILOT_HOME!, { cheap: true }), codexBin: codex.bin, claudeBin: claude.bin, codexDailyRuns: 2 };

  const r = await think(reg, cfg, "codex", spec("what's waiting on me?"));
  assert.deepEqual([r.ok, r.engine, r.fallback, r.costCents], [true, "codex", null, 0]);
  assert.deepEqual(r.output, answer);
  const call = codex.calls()[0];
  const flag = (f: string) => call.args[call.args.indexOf(f) + 1];
  assert.equal(call.args[0], "exec");
  assert.equal(flag("-m"), "gpt-6.1-sol");
  assert.equal(flag("-s"), "read-only");
  for (const f of ["--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--output-schema", "-o"]) assert.ok(call.args.includes(f), f);
  assert.equal(call.args.at(-1), "-", "the prompt goes in on stdin");
  assert.ok(call.stdin.startsWith("You are Pilot.") && call.stdin.includes("what's waiting on me?"));
  assert.deepEqual(codexArgs(cfg, "/w", "/w/s.json", "/w/o.json").slice(0, 3), ["exec", "-m", "gpt-6.1-sol"]);

  const signedOut = fakeCodex([], "signed-out");
  const fb = await think(reg, { ...cfg, codexBin: signedOut.bin }, "codex", spec("what's waiting on me?"));
  assert.deepEqual([fb.ok, fb.engine, fb.fallback], [true, "claude", "Codex is signed out"]);
  const noFb = await think(reg, { ...cfg, codexBin: signedOut.bin, engineFallback: false }, "codex", spec("what's waiting on me?"));
  assert.deepEqual([noFb.ok, noFb.engine, noFb.error], [false, "codex", "Codex is signed out"]);
  const missing = await think(reg, { ...cfg, codexBin: path.join(os.tmpdir(), "no-such-codex") }, "codex", spec("what's waiting on me?"));
  assert.deepEqual([missing.engine, missing.fallback], ["claude", "Codex is not installed"]);
  assert.deepEqual(codexFailure(1, "stream error: 429 Too Many Requests"), { reason: "Codex hit its usage limit", unavailable: true });

  // The daily cap counts Codex runs Pilot recorded; past it, Claude answers (with or without engine_fallback).
  for (let i = 0; i < 2; i++) reg.prepare("INSERT INTO watch_runs(kind, created_ms, status, engine) VALUES ('ask', ?, 'done', 'codex')").run(Date.now());
  const capped = await think(reg, { ...cfg, engineFallback: false }, "codex", spec("what's waiting on me?"));
  assert.deepEqual([capped.ok, capped.engine, capped.fallback], [true, "claude", "today's 2 Codex runs are used up"]);

  // And the other way: Claude cannot run (no self-test) -> Codex.
  delete process.env.PILOT_LOCAL_SKIP_SELFTEST;
  try {
    const viaCodex = await think(reg, { ...cfg, codexDailyRuns: 40 }, "claude", spec("what's waiting on me?"));
    assert.deepEqual([viaCodex.ok, viaCodex.engine, viaCodex.fallback], [true, "codex", "Claude's isolation self-test has not passed yet"]);
  } finally {
    process.env.PILOT_LOCAL_SKIP_SELFTEST = "1";
  }
});

test("api settings, ask --engine, and engine on messages and status", async () => {
  freshHome();
  const codex = fakeCodex([{ match: ["# 1. The person's question\nwho asked me something?"], output: { text: "Nobody yet.", evidence: [] } }]);
  const signedOut = fakeCodex([], "signed-out");
  const claude = fakeOneShot([{ match: ["# 1. The person's question\n"], output: { text: "Claude here.", evidence: [] } }]);
  const env = { PILOT_CODEX_BIN: codex.bin, PILOT_CLAUDE_BIN: claude.bin };

  const s0 = JSON.parse((await cli(["api", "settings"], env)).stdout);
  assert.deepEqual(Object.keys(s0).sort(), ["api", "engine", "engines"]);
  assert.equal(s0.engine, "claude");
  assert.deepEqual(Object.keys(s0.engines.claude).sort(), ["available", "note"]);
  assert.deepEqual(Object.keys(s0.engines.codex).sort(), ["available", "note", "runsLeftToday"]);
  assert.equal(s0.engines.codex.available, true);
  assert.equal(s0.engines.codex.runsLeftToday, 40);
  assert.equal(s0.engines.codex.note, "Uses your Codex plan");

  const s1 = JSON.parse((await cli(["api", "settings", "--engine=codex"], env)).stdout);
  assert.equal(s1.engine, "codex", "saved as the default");
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.PILOT_HOME!, "config.json"), "utf8")).engine, "codex");
  assert.equal(JSON.parse((await cli(["api", "status"], env)).stdout).engine, "codex");
  const bad = await cli(["api", "settings", "--engine=gpt"], env);
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.stdout).error, '--engine must be claude or codex, got "gpt"');
  const out = JSON.parse((await cli(["api", "settings"], { ...env, PILOT_CODEX_BIN: signedOut.bin })).stdout);
  assert.equal(out.engines.codex.available, false, "a different codex binary is probed again");
  assert.equal(out.engines.codex.note, "Not signed in to Codex");

  const viaCodex = JSON.parse((await cli(["api", "ask", "--text=who asked me something?"], env)).stdout);
  assert.deepEqual([viaCodex.answer.engine, viaCodex.answer.text, viaCodex.question.engine], ["codex", "Nobody yet.", null]);
  const oneOff = JSON.parse((await cli(["api", "ask", "--text=-and with Claude, once?", "--engine=claude"], env)).stdout);
  assert.deepEqual([oneOff.question.text, oneOff.answer.engine, oneOff.answer.text], ["-and with Claude, once?", "claude", "Claude here."]);
  const fb = JSON.parse((await cli(["api", "ask", "--text=who asked me something?"], { ...env, PILOT_CODEX_BIN: signedOut.bin })).stdout);
  assert.equal(fb.answer.engine, "claude");
  assert.equal(fb.answer.text, "Claude here. (Claude answered: Codex is signed out.)");
  assert.equal(JSON.parse((await cli(["api", "settings"], env)).stdout).engines.codex.runsLeftToday, 39, "only runs Codex actually made count");
});

test("cancel: SIGTERM stops the engine, stores no answer, keeps the question", async () => {
  freshHome();
  const slow = fakeCodex([], "slow");
  let pid = 0;
  const run = cli(["api", "ask", "--text=what's waiting on me?", "--engine=codex"], { PILOT_CODEX_BIN: slow.bin }, { onSpawn: (p) => (pid = p) });
  for (let i = 0; i < 100 && slow.calls().length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(slow.calls().length, 1, "codex started");
  process.kill(pid, "SIGTERM");
  const r = await run;
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).error, "Cancelled.");
  assert.ok(r.ms < 6_000, `stopped quickly (${r.ms} ms)`);
  const chat = JSON.parse((await cli(["api", "chat", "--limit=10"])).stdout);
  assert.deepEqual(chat.messages.map((m: any) => [m.role, m.kind]), [["you", "message"]]);
});

test("the Agent Engine key is read from the old Lookout Keychain item until a Pilot one exists", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pilot-fake-security-"));
  const bin = path.join(dir, "security");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/argv.log"\nif [ "$1" = find-generic-password ] && [ "$3" = lookout-agent-engine ]; then echo "ae_old_key"; exit 0; fi\nexit 44\n`, { mode: 0o755 });
  const kc = macKeychain(undefined, bin);
  assert.equal(kc.get("https://agent-engine.example.test"), "ae_old_key");
  assert.match(fs.readFileSync(path.join(dir, "argv.log"), "utf8"), /^find-generic-password -s pilot-agent-engine .*\nfind-generic-password -s lookout-agent-engine /m);
});
