/**
 * Read-only dry run of prompt watching over real prompts (docs/prompt-watch.md §9): what Pilot would have said.
 *
 *   PILOT_HOME=<scratch home holding a COPY of registry.db (+ selftest.json)> \
 *     node scripts/nudge-dryrun.ts --out <report.md> [--hours 24] [--limit 40] [--max-cents 280] [--transcripts]
 *       [--at <ISO>,<ISO>...]   only the checks whose last prompt was sent at these times (seconds precision)
 *
 * - Works only on the copy in PILOT_HOME (refuses ~/.pilot and ~/.lookout). Nothing is delivered, no chat message or
 *   run is stored; Pilot's would-be nudges are kept in memory for its spacing and dedupe rules.
 * - Reads the real CLAUDE.md chain and memory files read-only, as a live check would.
 * - --transcripts: Pilot 0.2 hooks did not store end-of-turn messages, so they are rebuilt from the sessions'
 *   transcripts (read-only) into the copy: for each prompt, the last assistant text before it.
 * - Each prompt group is checked as of its own time (later prompts and messages are not visible to it).
 * - The report quotes the person's prompts: write it outside any repository.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { loadConfig, loadEnv } from "../src/config.ts";
import { openRegistry, pilotHome } from "../src/home.ts";
import { loadPrompts, loadSessions, type PromptRow } from "../src/promptContext.ts";
import { checkPrompts, routesToSession, type PriorNudge } from "../src/promptWatch.ts";
import { capTurn } from "../src/sessionInfo.ts";

const { values } = parseArgs({
  options: { out: { type: "string" }, hours: { type: "string" }, limit: { type: "string" }, "max-cents": { type: "string" }, transcripts: { type: "boolean" }, at: { type: "string" } },
});
loadEnv();
const home = pilotHome();
for (const live of [path.join(os.homedir(), ".pilot"), path.join(os.homedir(), ".lookout")]) {
  if (path.resolve(home) === path.resolve(live)) throw new Error(`refusing to run on ${live}: point PILOT_HOME at a scratch copy`);
}
if (!values.out) throw new Error("--out <report.md> is required");
const hours = Number(values.hours ?? 24);
const limit = Number(values.limit ?? 40);
const maxCents = Number(values["max-cents"] ?? 280);
const reg = openRegistry();
const cfg = loadConfig(home, { cheap: true });
const now = Date.now();
const since = now - hours * 3600_000;

// End-of-turn messages from the transcripts (read-only), into the copy.
async function assistantTexts(file: string): Promise<Array<{ ts: number; text: string }>> {
  const out: Array<{ ts: number; text: string }> = [];
  if (!fs.existsSync(file)) return out;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"assistant"')) continue;
    try {
      const m = JSON.parse(line);
      if (m.type !== "assistant" || m.isSidechain) continue;
      const text = (Array.isArray(m.message?.content) ? m.message.content : []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim();
      const ts = Date.parse(m.timestamp ?? "");
      if (text && Number.isFinite(ts)) out.push({ ts, text });
    } catch {
      /* partial line */
    }
  }
  return out;
}

const all = loadPrompts(reg, since, now);
let rebuilt = 0;
if (values.transcripts) {
  const sessions = loadSessions(reg, all);
  const bySession = new Map<string, PromptRow[]>();
  for (const p of all) bySession.set(p.session, [...(bySession.get(p.session) ?? []), p]);
  const ins = reg.prepare("INSERT OR IGNORE INTO session_turns(session, ts_ms, text) VALUES (?, ?, ?)");
  for (const s of sessions.values()) {
    if (!s.transcriptPath || s.updatedMs < since) continue;
    const texts = await assistantTexts(s.transcriptPath);
    const wanted = new Set<number>();
    for (const p of bySession.get(s.session) ?? []) {
      const before = texts.findLast((t) => t.ts < p.tsMs);
      if (before) wanted.add(texts.indexOf(before));
    }
    if (texts.length) wanted.add(texts.length - 1); // the latest: open questions
    for (const i of wanted) rebuilt += Number(ins.run(s.session, texts[i].ts, capTurn(texts[i].text)).changes);
  }
}

// Group like the daemon: one session's prompts less than 8 s apart are one check.
const groups: PromptRow[][] = [];
for (const p of all) {
  const g = groups.findLast((x) => x[0].session === p.session);
  if (g && p.tsMs - g.at(-1)!.tsMs < cfg.promptQuietMs && g === groups.at(-1)) g.push(p);
  else groups.push([p]);
}
const only = values.at ? new Set(values.at.split(",").map((s) => s.trim().replace(/\.\d{3}Z$/, "Z"))) : null;
const picked = only ? groups.filter((g) => only.has(new Date(g.at(-1)!.tsMs).toISOString().replace(/\.\d{3}Z$/, "Z"))) : groups;
const sampled = picked.length > limit;
const chosen = picked.slice(-limit);
const sessions = loadSessions(reg, loadPrompts(reg, since - 48 * 3600_000, now));
const prior: PriorNudge[] = [];
const lines: string[] = [];
let spent = 0;
let checked = 0;
let modelRuns = 0;
const counts: Record<string, number> = {};
const t0 = Date.now();
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const quote = (s: string, max = 600) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

for (const [i, group] of chosen.entries()) {
  if (spent >= maxCents) {
    lines.push(`\n_Stopped after ${i} of ${chosen.length} groups: the $${(maxCents / 100).toFixed(2)} cap for this dry run was reached._`);
    break;
  }
  const s = sessions.get(group[0].session);
  const at = group.at(-1)!.tsMs;
  const out = await checkPrompts(reg, cfg, group, { nowMs: at, prior, nudgesForOpen: [], notUseful: {}, engine: "claude" });
  checked++;
  if (out.context) modelRuns++;
  spent += out.costCents;
  counts[out.status] = (counts[out.status] ?? 0) + 1;
  lines.push(`\n### ${i + 1}. ${s?.label ?? group[0].session.slice(0, 8)} · ${iso(at)}`);
  for (const p of group) lines.push(`> ${quote(p.text)}`);
  const v = out.verdict;
  if (v?.action === "nudge") {
    prior.push({ id: i + 1, session: group[0].session, kind: v.kind, atMs: at, fingerprint: v.fingerprint, ruleLines: v.kind === "rule" ? [...new Set(v.evidence.filter((e) => e.source === "rule" || e.source === "memory").map((e) => e.where))].sort() : undefined });
    lines.push(``, `**Pilot would say (${v.kind}, confidence ${v.confidence.toFixed(2)})${routesToSession(cfg, v.kind, v.confidence) ? ", and add it to the session's next turn" : ""}:** ${v.text}`);
    for (const e of v.evidence) lines.push(`- ${e.source} · ${e.where}: "${quote(e.quote, 300)}"`);
    for (const x of v.removed ?? []) lines.push(`- removed as unsupported: ~~${quote(x, 300)}~~`);
    lines.push(``, `<sub>why: ${v.why}</sub>`);
  } else if (v && (v.action === "dropped" || v.action === "held")) {
    lines.push(``, `**${v.action === "dropped" ? "Dropped" : "Held"}** (${v.why})${v.text ? `. It wanted to say (${v.kind ?? "?"}): ${v.text}` : ""}`);
    for (const e of v.evidence ?? []) lines.push(`- ${e.found ? "found" : "NOT FOUND"} · ${e.source} · ${e.where}: "${quote(e.quote, 300)}"`);
    for (const x of v.removed ?? []) lines.push(`- removed as unsupported: ~~${quote(x, 300)}~~`);
  } else if (v) {
    lines.push(``, `Silent. <sub>${v.why}</sub>`);
  } else {
    lines.push(``, `${out.status === "skipped" ? "Skipped, no model run" : "Failed"}: ${out.summary.replace(/^(skipped|failed): /, "")}${out.error ? ` (${out.error})` : ""}`);
  }
  const sz = out.context ? `${out.context.text.length} chars (${Object.entries(out.context.sizes).map(([k, n]) => `${k} ${n}`).join(", ")})` : "no context";
  const tok = out.usage ? ` · $${out.usage.costUsd.toFixed(4)} exact · tokens in ${out.usage.input} + cache write ${out.usage.cacheWrite} + cache read ${out.usage.cacheRead}, out ${out.usage.output}` : "";
  lines.push(``, `<sub>cost $${(out.costCents / 100).toFixed(3)} · context ${sz}${tok}</sub>`);
  process.stderr.write(`${i + 1}/${chosen.length} ${out.status} $${(out.costCents / 100).toFixed(2)} · ${sz}${tok}\n`);
}

const header = [
  `# Pilot dry run: what it would have said`,
  ``,
  `- When: ${iso(now)}, over the person's prompts from the last ${hours} h (a read-only copy of the registry).`,
  `- Prompts: ${all.length} typed by the person (task notifications, subagent hand-backs and subagent prompts excluded), in ${groups.length} checks after merging quick follow-ups${sampled ? `; **sampled: the most recent ${limit} checks**` : ""}.`,
  `- Checked: ${checked} (${modelRuns} model runs, the rest skipped by the rules without one). Results: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}.`,
  `- Engine: Claude ${cfg.promptCheckModel} (effort ${cfg.promptCheckEffort}). Cost: $${(spent / 100).toFixed(2)} (API-equivalent estimate). Took ${Math.round((Date.now() - t0) / 1000)} s.`,
  `- End-of-turn messages: ${values.transcripts ? `${rebuilt} rebuilt from the sessions' transcripts (read-only), since Lookout 0.2 hooks did not store them` : "only those already in the registry"}.`,
  `- Nothing was delivered or stored: no chat message, no run, no change to anything live.`,
];
fs.writeFileSync(values.out, `${header.join("\n")}\n${lines.join("\n")}\n`, { mode: 0o600 });
console.log(`wrote ${values.out}: ${checked} checked, ${counts.nudge ?? 0} nudge(s), $${(spent / 100).toFixed(2)}`);
