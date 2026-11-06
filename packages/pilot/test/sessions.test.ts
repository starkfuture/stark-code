import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { listRepos, openRegistry, repoStateDir } from "../src/home.ts";
import { OfflineFixtureInvestigator } from "../src/investigator/offline.ts";
import { daemon } from "../src/watcher.ts";
import { tempRepo, testConfig, write } from "./helpers.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function hook(input: Record<string, unknown>, env: Record<string, string> = {}): Promise<number | null> {
  return new Promise((resolve) => {
    const c = spawn(path.join(ROOT, "scripts", "pilot"), ["hook"], { env: { ...process.env, PILOT_AUTOSTART: "0", ...env }, stdio: ["pipe", "ignore", "inherit"] });
    c.on("close", resolve);
    c.stdin.end(JSON.stringify(input));
  });
}

const events = (repo: string) =>
  openDb(repoStateDir(repo)).prepare("SELECT kind, cc_session FROM events ORDER BY id").all() as Array<{ kind: string; cc_session: string }>;

test("one user-level hook routes every session's events to the repositories it actually works in", async () => {
  testConfig(tempRepo({ "x.txt": "x" }));
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "not-a-repo-"));
  const a = tempRepo({ "src/a.js": "a\n" });
  const b = tempRepo({ "src/b.js": "b\n" });
  const base = { session_id: "s1", cwd: outside, transcript_path: "/x/s1.jsonl" };

  // The session starts outside any repository and asks for a change: nothing to route yet, the prompt is kept.
  await hook({ ...base, hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "make createOrder retry" });
  assert.equal(listRepos(openRegistry()).length, 0);
  // It reads a file in repo b (recorded as seen, b is not registered) and edits a file in repo a.
  await hook({ ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "r1", tool_input: { file_path: path.join(b, "src/b.js") } });
  await hook({ ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "e1", tool_input: { file_path: path.join(a, "src/a.js"), old_string: "a", new_string: "aa" } });
  assert.deepEqual(listRepos(openRegistry()).map((r) => r.root), [a]);
  assert.deepEqual(events(a).map((e) => e.kind), ["prompt", "edit"], "the request that led to the edit is backfilled");
  const seen = openRegistry().prepare("SELECT path, how FROM session_files WHERE session = 's1' ORDER BY how").all() as Array<{ path: string; how: string }>;
  assert.deepEqual(seen.map((s) => [s.how, s.path]), [["edit", path.join(a, "src/a.js")], ["read", path.join(b, "src/b.js")]]);

  // Stop goes to the repo edited during this turn; a second Stop with no new edits goes nowhere.
  await hook({ ...base, hook_event_name: "Stop", last_assistant_message: "done" });
  assert.deepEqual(events(a).map((e) => e.kind), ["prompt", "edit", "stop"]);
  await hook({ ...base, hook_event_name: "Stop", last_assistant_message: "anything else?" });
  assert.equal(events(a).length, 3);

  // A second session in repo b keeps its own events.
  await hook({ session_id: "s2", cwd: b, hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "w2", tool_input: { file_path: path.join(b, "src/new.js"), content: "n" } });
  assert.deepEqual(events(b).map((e) => [e.kind, e.cc_session]), [["edit", "s2"]]);
});

test("profiles that are not watched, excluded projects, and Lookout's own runs are ignored", async () => {
  testConfig(tempRepo({ "x.txt": "x" }));
  const a = tempRepo({ "src/a.js": "a\n" });
  const edit = (id: string) => ({ session_id: `s-${id}`, cwd: a, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: id, tool_input: { file_path: path.join(a, "src/a.js"), old_string: "a", new_string: "b" } });
  const other = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "profile-"));
  await hook(edit("p1"), { PILOT_PROFILES: "~/.claude", CLAUDE_CONFIG_DIR: other });
  await hook(edit("p2"), { PILOT_EXCLUDE: path.dirname(a) });
  await hook(edit("p3"), { PILOT_IN_INVESTIGATION: "1" });
  assert.equal(fs.existsSync(path.join(repoStateDir(a), "lookout.db")) ? events(a).length : 0, 0);
  await hook(edit("p4"), { PILOT_PROFILES: other, CLAUDE_CONFIG_DIR: other });
  assert.equal(events(a).length, 1, "a profile listed in config is watched");
});

test("the daemon schedules every registered repository with one shared concurrency limit", async () => {
  const a = tempRepo({ "src/a.js": "a\n" });
  const b = tempRepo({ "src/b.js": "b\n" });
  testConfig(a);
  Object.assign(process.env, { PILOT_QUIET_MS: "0", PILOT_POLL_MS: "50", PILOT_MIN_RUN_INTERVAL_MIN: "0", PILOT_FAKE_STEP_MS: "1" });
  for (const [repo, file] of [[a, "src/a.js"], [b, "src/b.js"]]) {
    write(repo, file, "changed\n");
    await hook({ session_id: `s-${file}`, cwd: repo, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: `t-${file}`, tool_input: { file_path: path.join(repo, file), old_string: "a", new_string: "b" } });
    await hook({ session_id: `s-${file}`, cwd: repo, hook_event_name: "Stop", last_assistant_message: "done" });
  }
  const logs: string[] = [];
  let maxActive = 0;
  let active = 0; // across all repositories
  await daemon({
    log: (m) => logs.push(m),
    untilIdle: true,
    makeInvestigator: async (cfg) => {
      const inv = new OfflineFixtureInvestigator({ ...cfg, fakeStepMs: 1 });
      const run = inv.run.bind(inv);
      inv.run = async (spec) => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          return await run(spec);
        } finally {
          active--;
        }
      };
      return inv;
    },
  });
  for (const repo of [a, b]) {
    const jobs = openDb(loadConfig(repo).stateDir).prepare("SELECT kind, status FROM jobs").all() as Array<{ kind: string; status: string }>;
    assert.deepEqual(jobs.map((j) => [j.kind, j.status]), [["checkpoint", "done"]], `${repo}: ${logs.join("\n")}`);
  }
  assert.equal(maxActive, 1);
  assert.equal(openRegistry().prepare("SELECT value FROM kv WHERE key = 'daemon'").get()?.value, "null", "lock released on exit");
});

test("edits spelled through a symlink (e.g. /tmp -> /private/tmp) still reach the repository", async () => {
  testConfig(tempRepo({ "x.txt": "x" }));
  const a = tempRepo({ "src/a.js": "a\n" });
  const link = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "link-")), "repo-link");
  fs.symlinkSync(a, link);
  await hook({ session_id: "s-link", cwd: link, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "l1", tool_input: { file_path: path.join(link, "src/a.js"), old_string: "a", new_string: "b" } });
  const rows = openDb(repoStateDir(a)).prepare("SELECT payload FROM events").all() as Array<{ payload: string }>;
  assert.deepEqual(rows.map((r) => JSON.parse(r.payload).path), ["src/a.js"]);
});
