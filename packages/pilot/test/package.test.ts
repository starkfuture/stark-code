// What ships: Stark Code copies the files package.json lists into ~/.pilot/plugin/<version> and Claude Code runs
// them from there, without node_modules. These checks keep that copy complete and dependency-free.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
const pkg = readJson("package.json") as { version: string; files: string[] };
const shipped = (rel: string) => pkg.files.some((entry) => rel === entry || rel.startsWith(`${entry}/`));

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(rel) : [rel];
  });
}

test("the plugin and the package carry one version, and every listed file exists", () => {
  assert.equal(readJson(".claude-plugin/plugin.json").version, pkg.version);
  assert.equal(readJson(".claude-plugin/plugin.json").name, "pilot");
  assert.equal(readJson(".claude-plugin/marketplace.json").name, "pilot");
  for (const entry of pkg.files) assert.ok(fs.existsSync(path.join(ROOT, entry)), `${entry} is listed but missing`);
});

test("hooks and commands only run shipped files", () => {
  const texts = [fs.readFileSync(path.join(ROOT, "hooks/hooks.json"), "utf8"), ...walk("commands").map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"))];
  const used = texts.flatMap((text) => [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\\\s`]+)/g)].map((match) => match[1]!));
  assert.ok(used.includes("src/boot.mjs"));
  for (const rel of used) assert.ok(shipped(rel), `${rel} is run by a hook or command but not shipped`);
});

test("the runtime imports only Node built-ins, except live mode's SDK, which is loaded by URL", () => {
  const outside: string[] = [];
  for (const file of walk("src").filter((rel) => /\.(ts|mjs)$/.test(rel))) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const specifier = match[1] ?? match[2]!;
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      outside.push(`${file}: ${specifier}`);
    }
  }
  assert.deepEqual(outside, [path.join("src", "investigator", "managed.ts") + ": @anthropic-ai/sdk"]);
  assert.match(fs.readFileSync(path.join(ROOT, "src/cli.ts"), "utf8"), /import\(new URL\("\.\/investigator\/managed\.ts", import\.meta\.url\)\.href\)/);
});
