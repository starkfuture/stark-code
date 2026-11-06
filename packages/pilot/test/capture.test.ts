import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { enqueueEvent, normalizeHook } from "../src/events.ts";
import { redact } from "../src/secrets.ts";
import { tempRepo, testConfig } from "./helpers.ts";

const now = Date.parse("2026-11-04T10:00:00Z");

test("normalizes documented hook payloads into development events", () => {
  const repo = "/r";
  const prompt = normalizeHook({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", prompt: "add retries" }, repo, now);
  assert.equal(prompt?.kind, "prompt");
  assert.equal(prompt?.dedupeKey, "prompt:s:p1");

  const edit = normalizeHook(
    { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Edit", tool_use_id: "toolu_1", tool_input: { file_path: "/r/src/a.js", old_string: "a", new_string: "b" } },
    repo,
    now,
  );
  assert.deepEqual([edit?.kind, edit?.dedupeKey, edit?.payload.path], ["edit", "tool:toolu_1", "src/a.js"]);

  assert.equal(
    normalizeHook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "t2", tool_input: { file_path: "/elsewhere/x.js" } }, repo, now),
    null,
    "edits outside the repo are not ours",
  );
  assert.equal(normalizeHook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t3", tool_input: { command: "ls -la" } }, repo, now), null);

  const pass = normalizeHook(
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t4", tool_input: { command: "npm test" }, tool_response: { stdout: "# pass 3\n# fail 0" } },
    repo,
    now,
  );
  assert.deepEqual([pass?.kind, pass?.payload.status], ["test", "passed"]);
  const fail = normalizeHook(
    { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "t5", tool_input: { command: "npx vitest run" }, error: "1 failed" },
    repo,
    now,
  );
  assert.deepEqual([fail?.payload.status, fail?.payload.status_source], ["failed", "PostToolUseFailure hook"]);

  const stop = normalizeHook({ hook_event_name: "Stop", session_id: "s", prompt_id: "p1", last_assistant_message: "Done; tests pass." }, repo, now);
  assert.equal(stop?.kind, "stop");
  assert.equal(stop?.payload.coding_agent_message, "Done; tests pass.");
  assert.equal(normalizeHook({ hook_event_name: "PreToolUse" }, repo, now), null);
});

test("duplicate hook deliveries are ignored (insert-or-ignore on dedupe key)", () => {
  const repo = tempRepo({ "a.txt": "x" });
  const db = openDb(testConfig(repo).stateDir);
  const ev = normalizeHook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "toolu_dup", tool_input: { file_path: `${repo}/a.txt`, content: "y" } }, repo, now)!;
  assert.equal(enqueueEvent(db, ev, null, now), true);
  assert.equal(enqueueEvent(db, ev, null, now + 5), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 1);
});

test("credential files never contribute content, and truncation cannot split a secret past the redactor", () => {
  const ev = normalizeHook(
    { hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "t9", tool_input: { file_path: "/r/.env", old_string: "A=1", new_string: "DB_PASSWORD=hunter2hunter2" } },
    "/r",
    now,
  );
  assert.equal(ev?.payload.excluded, "env file");
  assert.equal(ev?.payload.new_preview, undefined);
  const long = `${"x".repeat(5990)}\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsecretsecretsecret\n-----END RSA PRIVATE KEY-----`;
  const stop = normalizeHook({ hook_event_name: "Stop", session_id: "s", last_assistant_message: long }, "/r", now);
  assert.doesNotMatch(String(stop?.payload.coding_agent_message), /MIIEpA|BEGIN RSA/);
  const json = redact('{"password": "hunter2hunter2", "apiToken":"abcdefghijkl"}\nSECRET_KEY=plainvalue123\nconst k = process.env.API_KEY;');
  assert.doesNotMatch(json.text, /hunter2|abcdefghijkl|plainvalue123/);
  assert.match(json.text, /process\.env\.API_KEY/, "code that only references a secret stays readable");
});

test("secrets in prompts and outputs are redacted before storage/upload", () => {
  const r = redact('const apiKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345"; db=postgres://u:hunter2pass@h/db AKIAABCDEFGHIJKLMNOP');
  assert.doesNotMatch(r.text, /abcdefghijklmnop|hunter2pass|AKIAABCDEFGHIJKLMNOP/);
  assert.ok(r.hits.includes("anthropic-key") && r.hits.includes("url-password") && r.hits.includes("aws-key-id"));
  const ev = normalizeHook({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "use token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB" }, "/r", now);
  assert.doesNotMatch(String(ev?.payload.prompt), /ghp_0123/);
});
