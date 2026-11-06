import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildSnapshot, packBundle } from "../src/snapshot.ts";
import { tempRepo, testConfig, write } from "./helpers.ts";

test("snapshot includes uncommitted work, excludes credentials, redacts secrets, and packs only repo/ + context/", () => {
  const repo = tempRepo({ "src/a.js": "export const a = 1;\n", ".gitignore": "node_modules/\n" });
  const cfg = testConfig(repo);
  const clean = buildSnapshot(cfg);
  assert.equal(clean.dirty, false);
  assert.ok(!clean.revision.includes("+wt."), "clean tree revision is the commit");

  write(repo, "src/a.js", "export const a = 2;\n"); // uncommitted
  write(repo, "src/new.js", 'const password = "correct-horse-battery-staple";\n'); // untracked + secret
  write(repo, ".env", "TOKEN=abc\n");
  write(repo, "certs/server.pem", "-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----\n");
  write(repo, "node_modules/x/index.js", "ignored");
  const s = buildSnapshot(cfg);
  assert.equal(s.dirty, true);
  assert.match(s.revision, /\+wt\.[0-9a-f]{8}$/);
  assert.notEqual(s.id, clean.id);
  const included = s.manifest.included.map((i) => i.path);
  assert.deepEqual(included.sort(), [".gitignore", "src/a.js", "src/new.js"]);
  assert.deepEqual(s.manifest.excluded.map((e) => e.path).sort(), [".env", "certs/server.pem"]);
  assert.match(s.diffPatch, /export const a = 2/);
  assert.equal(buildSnapshot(cfg).id, s.id, "snapshot id is content-addressed");

  const ctx = path.join(cfg.stateDir, "jobs", "t", "context");
  fs.mkdirSync(ctx, { recursive: true });
  fs.writeFileSync(path.join(ctx, "job.json"), "{}");
  const out = path.join(cfg.stateDir, "jobs", "t", "bundle.tgz");
  packBundle(s, ctx, out);
  const list = execFileSync("tar", ["-tzf", out], { encoding: "utf8" });
  assert.doesNotMatch(list, /\.env|server\.pem|node_modules|\.lookout/);
  const all = execFileSync("tar", ["-xzOf", out], { encoding: "utf8" });
  assert.doesNotMatch(all, /correct-horse-battery-staple/);
  assert.match(all, /\[REDACTED:assigned-secret\]/);
});
