#!/usr/bin/env node
// SIMULATED Claude Code activity for the demo: applies a prepared change to the demo repo and pipes
// hook payloads (shapes from code.claude.com/docs/en/hooks) into the REAL `lookout hook` command, exactly as
// Claude Code would with the Lookout plugin installed (no --repo: events are routed by cwd and file path).
// SIM_SESSION sets the simulated session id (default cc-demo-session-0001).
//
//   node scripts/simulate-claude.mjs <repo> session-start
//   node scripts/simulate-claude.mjs <repo> prompt <step>
//   node scripts/simulate-claude.mjs <repo> work <step> [--dup]
import { spawnSync, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "pilot");
const [repo, action, step] = process.argv.slice(2);
const dup = process.argv.includes("--dup");
const SESSION = process.env.SIM_SESSION || "cc-demo-session-0001";

const STEPS = {
  "1-legit-get-retry": {
    prompt: "Add retries with exponential backoff to getOrder so the order-status page survives transient Orders API errors.",
    stop: "Added src/retry.js (withRetry with exponential backoff, retries timeouts and 5xx) and wrapped getOrder with it. createOrder is unchanged. New test covers a transient 503 on getOrder; all 3 tests pass.",
  },
  "2-unsafe-create-retry": {
    prompt: "Checkout fails whenever the Orders API times out. Add retries with exponential backoff to order creation so transient timeouts and 5xx errors don't fail checkout.",
    stop: "Wrapped createOrder in withRetry (3 attempts, exponential backoff). Added a test that a transient 503 is retried; all 4 tests pass. Retries are safe here because a failed request doesn't create an order.",
  },
  "3-idempotency-fix": {
    prompt: "Make order creation safe to retry: send an Idempotency-Key that stays the same across retries of one checkout.",
    stop: "createOrder now requires an idempotencyKey and sends it as the Idempotency-Key header on every attempt; placeOrder generates one per checkout with randomUUID(). Added a test where the first POST times out after the order was committed: exactly one order exists. All 5 tests pass.",
  },
  "4-tests-only": {
    prompt: "Add a test that getOrder surfaces a 404.",
    stop: "Added a 404 test for getOrder. All 6 tests pass.",
  },
};

function emit(payload, label) {
  const body = JSON.stringify({ session_id: SESSION, transcript_path: "/dev/null", cwd: repo, permission_mode: "acceptEdits", ...payload });
  const t0 = process.hrtime.bigint();
  const r = spawnSync(CLI, ["hook"], { input: body, encoding: "utf8", env: { ...process.env, PILOT_HOOK_VERBOSE: "1" } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const note = (r.stderr || "").trim().replace(/^\[lookout hook\] /, "");
  console.log(`  hook ${payload.hook_event_name.padEnd(18)} ${label.padEnd(44)} -> ${note || "ignored (not relevant)"} [process ${ms.toFixed(0)}ms]`);
  return body;
}

const listFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));

function runTests() {
  try {
    const out = execFileSync("npm", ["test", "--silent"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    return { output: out, failed: false, real: true };
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    if (/EPERM|operation not permitted/i.test(out)) {
      // Sandboxed shells may forbid binding localhost; keep the demo going with a labelled stand-in.
      return { output: "# [demo stand-in: tests could not bind localhost in this sandbox]\n# pass ?\n# fail 0", failed: false, real: false };
    }
    return { output: out, failed: true, real: true };
  }
}

if (action === "session-start") {
  emit({ hook_event_name: "SessionStart", source: "startup", model: "claude-opus-5-5" }, "startup");
} else if (action === "prompt") {
  emit({ hook_event_name: "UserPromptSubmit", prompt_id: crypto.randomUUID(), prompt: STEPS[step].prompt }, `"${STEPS[step].prompt.slice(0, 40)}..."`);
} else if (action === "work") {
  const promptId = crypto.randomUUID();
  const src = path.join(ROOT, "examples", "steps", step);
  let last = null;
  for (const file of listFiles(src).sort()) {
    const rel = path.relative(src, file);
    const dest = path.join(repo, rel);
    const existed = fs.existsSync(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const content = fs.readFileSync(file, "utf8");
    fs.writeFileSync(dest, content);
    last = emit(
      {
        hook_event_name: "PostToolUse",
        prompt_id: promptId,
        tool_name: "Write",
        tool_use_id: `toolu_${crypto.randomBytes(8).toString("hex")}`,
        tool_input: { file_path: dest, content },
        tool_response: { filePath: dest, type: existed ? "update" : "create" },
        duration_ms: 3,
      },
      `Write ${rel}`,
    );
  }
  if (dup && last) {
    // Same tool_use_id delivered twice (e.g. hook configured at two settings levels): must be ignored.
    const again = JSON.parse(last);
    const r = spawnSync(CLI, ["hook"], { input: JSON.stringify(again), encoding: "utf8", env: { ...process.env, PILOT_HOOK_VERBOSE: "1" } });
    console.log(`  hook PostToolUse (redelivered)    same tool_use_id as previous                  -> ${(r.stderr || "").trim().replace(/^\[lookout hook\] /, "")}`);
  }
  const t = runTests();
  emit(
    {
      hook_event_name: t.failed ? "PostToolUseFailure" : "PostToolUse",
      prompt_id: promptId,
      tool_name: "Bash",
      tool_use_id: `toolu_${crypto.randomBytes(8).toString("hex")}`,
      tool_input: { command: "npm test", description: "Run test suite" },
      tool_response: { stdout: t.output, stderr: "", interrupted: false, isImage: false },
    },
    `Bash npm test (${t.real ? "real run" : "stand-in"})`,
  );
  emit({ hook_event_name: "Stop", prompt_id: promptId, stop_hook_active: false, last_assistant_message: STEPS[step].stop }, "turn finished");
} else {
  console.error("usage: simulate-claude.mjs <repo> session-start|prompt <step>|work <step> [--dup]");
  process.exit(2);
}
