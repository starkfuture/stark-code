// Entry point for hooks and launchers. Plain JavaScript, so it runs - and fails politely - on any Node version:
// Pilot needs Node >= 22.18 (TypeScript type stripping, node:sqlite). On an older Node it records the problem
// once a day in ~/.pilot/hook-errors.log and exits 0, so Claude Code is never blocked or spammed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  const home = path.resolve((process.env.PILOT_HOME || process.env.LOOKOUT_HOME || "~/.pilot").replace(/^~(?=$|\/)/, os.homedir()));
  const marker = path.join(home, ".node-too-old");
  const interactive = process.argv[2] !== "hook" && process.argv[2] !== "deliver";
  const problem = `needs Node >= 22.18, found ${process.version}`;
  // `pilot api` callers read one JSON object from stdout, errors included. A synchronous write, because
  // process.exit below would cut off a pending write to a pipe.
  if (process.argv[2] === "api") fs.writeSync(1, `${JSON.stringify({ api: 1, error: `Pilot ${problem}` })}\n`);
  else if (interactive) console.error(`pilot: ${problem}`);
  try {
    const last = fs.existsSync(marker) ? fs.statSync(marker).mtimeMs : 0;
    if (Date.now() - last > 86_400_000) {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(home, "hook-errors.log"), `${new Date().toISOString()} Pilot needs Node >= 22.18 but hooks run ${process.version} (${process.execPath}); nothing is captured until it is upgraded\n`);
      fs.writeFileSync(marker, "");
    }
  } catch {
    /* never fail the coding agent */
  }
  process.exit(interactive ? 1 : 0);
}
// Keep stderr clean (an asyncRewake hook's stderr IS the message shown to Claude): drop the default warning printer
// (node:sqlite is still flagged experimental on some Node versions).
process.removeAllListeners("warning");
await import("./cli.ts");
