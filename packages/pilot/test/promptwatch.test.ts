import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { actOnNudge, apiMessage, claimQueued, displayQuote, formatForSession, getMessage, insertMessage, listMessages, markAllSeen, unreadCount } from "../src/chat.ts";
import { openRegistry, type DB } from "../src/home.ts";
import { buildCheckContext, CHECK_CAPS, loadPrompts, loadSessions, locateQuote, resolveEvidence, type PromptRow } from "../src/promptContext.ts";
import { applyGrounding, checkPrompts, duePrompts, evaluate, fingerprintOf, groundingInput, minConfidenceFor, priorNudges, recordNudge, routesToSession, skipReason, splitSentences } from "../src/promptWatch.ts";
import { endsWithQuestion, isHumanPrompt, readableText, sessionLabel, transcriptLastMessage } from "../src/sessionInfo.ts";
import { daemon } from "../src/watcher.ts";
import { fakeOneShot, tempRepo } from "./helpers.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PILOT_WORK_ROOT = os.tmpdir(); // fake claude: no short /private/tmp work dir needed
process.env.PILOT_LOCAL_SKIP_SELFTEST = "1";
process.env.PILOT_MODE = "local";

const RULE = "Never merge a PR unless the user writes 'merge #<n>'";

function freshHome(): DB {
  process.env.PILOT_HOME = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lookout-pw-home-"));
  return openRegistry();
}

/** A profile with no global CLAUDE.md and a project (a git repo) whose CLAUDE.md holds RULE, plus a memory index. */
function workspace(): { profile: string; repo: string; transcript: (s: string) => string } {
  const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lookout-pw-profile-"));
  const repo = tempRepo({ "CLAUDE.md": `# Team rules\n\n- Run the tests before pushing.\n- ${RULE}.\n- Ask before touching production.\n`, "src/a.ts": "export const a = 1;\n" });
  const proj = path.join(profile, "projects", "p1");
  fs.mkdirSync(path.join(proj, "memory"), { recursive: true });
  fs.writeFileSync(path.join(proj, "memory", "MEMORY.md"), "# Memory Index\n\n## Feedback\n- [merge rule](feedback_merge.md) — merge only on an explicit go\n- [cooking](project_recipes.md) — pasta notes\n");
  fs.writeFileSync(path.join(proj, "memory", "feedback_merge.md"), "Merge only when the user says merge #N; blanket approvals don't carry.\n");
  fs.writeFileSync(path.join(proj, "memory", "project_recipes.md"), "Boil water.\n");
  return { profile, repo, transcript: (s) => path.join(proj, `${s}.jsonl`) };
}

function seedSession(reg: DB, session: string, cwd: string, profile: string, transcript: string | null, first: string | null = null): void {
  reg.prepare("INSERT OR REPLACE INTO sessions(session, profile, cwd, transcript_path, updated_ms, first_prompt) VALUES (?, ?, ?, ?, ?, ?)").run(session, profile, cwd, transcript, Date.now(), first);
}
let seq = 0;
function seedPrompt(reg: DB, session: string, tsMs: number, text: string, extra: Record<string, unknown> = {}): PromptRow {
  const key = `prompt:${session}:${tsMs}:${seq++}`;
  reg.prepare("INSERT INTO session_prompts(dedupe_key, session, ts_ms, head, payload) VALUES (?, ?, ?, NULL, ?)").run(key, session, tsMs, JSON.stringify({ prompt: text, ...extra }));
  return { key, session, tsMs, text, checkId: null };
}
const seedTurn = (reg: DB, session: string, tsMs: number, text: string) => reg.prepare("INSERT INTO session_turns(session, ts_ms, text) VALUES (?, ?, ?)").run(session, tsMs, text);

function cli(args: string[], env: Record<string, string> = {}, stdin = ""): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(path.join(ROOT, "scripts", "pilot"), args, { env: { ...process.env, PILOT_AUTOSTART: "0", ...env } });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code, stdout, stderr }));
    c.stdin.end(stdin);
  });
}

/** The fake engine's answer to a sentence check: every sentence supported. */
const allSupported = { match: ["# Message sentences, to the person"], output: { sentences: Array.from({ length: 12 }, (_, i) => ({ n: i + 1, supported: true, why: "quoted" })) } };

const ruleNudge = { why: "approval without merge #N", speak: true, kind: "rule", confidence: 0.9, evidence: [{ ref: "auto", quote: RULE }], text: "Your rule says merge only on 'merge #N'; this just says 'merge it'.", for_session: "The user's rule says to merge only when they write 'merge #<n>'." };

test("trigger, debounce and skip rules", () => {
  const reg = freshHome();
  const now = Date.now();
  const a1 = seedPrompt(reg, "A", now - 20_000, "rename foo to bar in utils");
  const a2 = seedPrompt(reg, "A", now - 10_000, "and in the tests too please");
  seedPrompt(reg, "B", now - 3_000, "add a unit test for parseDate");
  seedPrompt(reg, "C", now - 11 * 60_000, "an old prompt nobody checked");
  seedPrompt(reg, "D", now - 30_000, "<task-notification> <task-id>x</task-id> done </task-notification>");
  seedPrompt(reg, "D", now - 29_000, "a subagent prompt", { agent_id: "sub-1" });
  seedPrompt(reg, "E", now - 40_000, "every one of the skills was rewritten?");
  seedPrompt(reg, "E", now - 38_000, "every one of the skills was rewritten?"); // resubmitted
  const rows = loadPrompts(reg, now - 3600_000, now);
  assert.deepEqual(
    rows.map((r) => r.session),
    ["C", "E", "A", "A", "B"],
    "automated turns and subagent prompts are not the person's; a resubmit is one prompt",
  );
  const { due, waiting, stale } = duePrompts(rows, now, 8_000);
  assert.deepEqual(due.map((g) => g.map((p) => p.key)), [[rows[1].key], [a1.key, a2.key]], "quick follow-ups in one session merge into one check");
  assert.equal(waiting, 1, "B is still typing (8 s debounce)");
  assert.deepEqual(stale.map((p) => p.session), ["C"], "prompts older than 10 min are not checked");
  assert.equal(duePrompts(rows.map((r) => ({ ...r, checkId: 1 })), now, 8_000).due.length, 0, "checked prompts are done");
  const split = duePrompts(rows, now, 8_000, 600_000, new Map([["A", [now - 15_000]]]));
  assert.deepEqual(split.due.map((g) => g.map((p) => p.key)), [[rows[1].key], [a1.key], [a2.key]], "a finished turn between two prompts keeps them apart");

  const p = (text: string): PromptRow[] => [{ key: "k", session: "s", tsMs: now, text, checkId: null }];
  assert.equal(skipReason(p("add a unit test for parseDate"), null), null);
  assert.match(skipReason(p("ok"), null) ?? "", /short prompt/);
  assert.match(skipReason(p("yes"), "Done. All 12 tests pass.") ?? "", /short prompt/);
  assert.equal(skipReason(p("yes"), "The PR is green. Want me to merge #42?"), null, "a short yes to a risky proposal is checked");
  assert.equal(skipReason(p("go"), "Ready to deploy to production?"), null);

  assert.equal(isHumanPrompt("<agent-message from=\"a1\"> [Subagent hand-back]"), false);
  assert.equal(isHumanPrompt("fix it"), true);
  assert.equal(isHumanPrompt("fix it", { agent_id: "x" }), false);
  assert.equal(endsWithQuestion("Ran the e2e suite.\n\nShould I use kciam or the w02283 sandbox?"), true);
  assert.equal(endsWithQuestion("Is it fixed? Yes.\n\nAll done."), false);
});

test("context builder: sections, refs, line numbers, and the 40k cap", () => {
  const reg = freshHome();
  const ws = workspace();
  const now = Date.now();
  seedSession(reg, "me", path.join(ws.repo, "src"), ws.profile, ws.transcript("me"));
  seedSession(reg, "other", ws.repo, ws.profile, ws.transcript("other"));
  for (let i = 0; i < 30; i++) seedPrompt(reg, "me", now - 3600_000 + i * 1000, `earlier ${i} ${"x".repeat(2000)}`);
  for (let i = 0; i < 60; i++) seedPrompt(reg, "other", now - 7200_000 + i * 1000, `other ${i} ${"y".repeat(2000)}`);
  seedTurn(reg, "me", now - 60_000, `Reviewed PR #42. ${"z".repeat(5000)} Want me to merge it?`);
  const target = seedPrompt(reg, "me", now, `looks good, merge it ${"w".repeat(20_000)}`);
  const ctx = buildCheckContext(reg, { session: "me", prompts: [target] }, { nowMs: now, nudges: [] });
  assert.ok(ctx.text.length <= CHECK_CAPS.total + 1_500, `about 40k characters, got ${ctx.text.length}`);
  for (const [name, cap] of Object.entries(CHECK_CAPS)) if (name !== "total") assert.ok((ctx.sizes[name] ?? 0) <= cap, `${name} within its cap`);
  for (const h of ["# 1. The new prompt", "# 2. Earlier in the same session", "# 3. The person's prompts in other sessions", "# 4. The person's written rules and memory", "# 5. Open items"]) assert.ok(ctx.text.includes(h), h);
  assert.ok(ctx.text.includes(`4| - ${RULE}.`), "rules are line-numbered");
  assert.ok(ctx.text.includes("feedback_merge.md (memory)"), "a memory file sharing words with the prompt is included");
  assert.ok(!ctx.text.includes("project_recipes.md (memory)"), "unrelated memory files are not");
  assert.ok(ctx.text.includes("the session's last end-of-turn message"));
  assert.equal([...ctx.newRefs].length, 1);
  const otherRefs = [...ctx.sources.values()].filter((s) => s.kind === "prompt" && s.session === "other");
  assert.ok(otherRefs.length <= 40, "at most 40 prompts from other sessions");
  const same = [...ctx.sources.values()].filter((s) => s.kind === "prompt" && s.session === "me");
  assert.ok(same.length <= 16, "at most 15 earlier prompts of the same session (plus the new one)");
  assert.ok(ctx.text.indexOf("earlier 29") < ctx.text.indexOf("earlier 28"), "newest first");
});

test("quote checking: exact text (case, spacing, quote marks and markdown aside), path:line, and a mismatch drops the nudge", () => {
  const text = "# Rules\n\n- **Never** merge a PR unless\n  the user writes 'merge #<n>'.\n- Ask first.";
  assert.deepEqual(locateQuote(text, "Never merge a PR unless the user writes ‘merge #<n>’"), { found: true, line: 3 });
  assert.deepEqual(locateQuote(text, "never MERGE a pr"), { found: true, line: 3 });
  assert.equal(locateQuote(text, "Ask first").line, 5);
  assert.equal(locateQuote(text, "…merge a PR unless the user writes").found, true);
  assert.equal(locateQuote(text, "Never merge a PR … 'merge #<n>'").found, true, "an inner ellipsis: both parts in order");
  assert.equal(locateQuote(text, "Ask first … Never merge a PR").found, false, "parts out of order");
  assert.equal(locateQuote(text, "Never merge … PR").found, false, "too-short parts around an ellipsis");
  assert.equal(locateQuote(text, "Always merge a PR").found, false);

  const sources = new Map([
    ["R1", { ref: "R1", kind: "rule" as const, text, path: "/w/CLAUDE.md" }],
    ["P1", { ref: "P1", kind: "prompt" as const, text: "looks good, merge it", label: "app · fix retries", atMs: Date.parse("2026-11-06T10:00:00Z"), session: "s" }],
  ]);
  assert.deepEqual(resolveEvidence(sources, [{ ref: "R1", quote: "Ask first." }, { ref: "[P1]", quote: "merge it" }, { ref: "R7", quote: "x" }]), [
    { source: "rule", where: "/w/CLAUDE.md:5", quote: "Ask first.", found: true },
    { source: "prompt", where: "app · fix retries · 2026-11-06T10:00:00Z", quote: "merge it", found: true },
    { source: "prompt", where: "unknown source R7", quote: "x", found: false },
  ]);
  const o = { session: "s", nowMs: Date.now(), minConfidence: () => 0.7, prior: [], newRefs: new Set(["P1"]) };
  const base = { why: "w", speak: true, kind: "rule", confidence: 0.9, text: "Your rule says merge #N.", for_session: "f" };
  assert.equal(evaluate({ ...base, evidence: [{ ref: "R1", quote: "Never merge a PR unless the user writes 'merge #<n>'" }] }, { sources }, o).action, "nudge");
  const bad = evaluate({ ...base, evidence: [{ ref: "R1", quote: "Never merge a PR unless" }, { ref: "R1", quote: "Never merge on Fridays" }] }, { sources }, o);
  assert.equal(bad.action, "dropped", "one quote that does not match drops the whole nudge");
  assert.match(bad.why, /did not match/);
  assert.equal(evaluate({ ...base, evidence: [{ ref: "P1", quote: "merge it" }] }, { sources }, o).action, "dropped", "quoting only the new prompt is not evidence");
  assert.equal(evaluate({ ...base, evidence: [] }, { sources }, o).action, "dropped");
  assert.equal(evaluate({ ...base, confidence: 0.5, evidence: [{ ref: "R1", quote: "Ask first." }] }, { sources }, o).action, "silent");
  assert.equal(evaluate({ ...base, speak: false }, { sources }, o).action, "silent");
  assert.equal(evaluate({ ...base, kind: "style", evidence: [{ ref: "R1", quote: "Ask first." }] }, { sources }, o).action, "dropped");
});

test("dedupe, spacing and the raised bar after 'not useful'", async () => {
  const sources = new Map([["R1", { ref: "R1", kind: "rule" as const, text: `- ${RULE}\n- Ask before touching production.`, path: "/w/CLAUDE.md" }]]);
  const now = Date.now();
  const out = (kind: string, quote: string, confidence = 0.9) => ({ why: "w", speak: true, kind, confidence, evidence: [{ ref: "R1", quote }], text: "t", for_session: "f" });
  const fp = fingerprintOf("rule", [RULE]);
  const o = (prior: Array<{ id: number; session: string | null; kind: string; atMs: number; fingerprint: string | null }>) => ({ session: "s", nowMs: now, minConfidence: () => 0.7, prior, newRefs: new Set<string>() });
  assert.equal(fingerprintOf("rule", [`  ${RULE.toUpperCase()} `]), fp, "normalised quotes");
  assert.match(evaluate(out("rule", RULE), { sources }, o([{ id: 4, session: "other", kind: "rule", atMs: now - 86_400_000, fingerprint: fp }])).why, /repeats nudge #4/, "never repeated, in any session");
  const recent = [{ id: 5, session: "s", kind: "earlier", atMs: now - 3 * 60_000, fingerprint: "x" }];
  assert.equal(evaluate(out("rule", RULE), { sources }, o(recent)).action, "held", "one nudge per session per 10 min");
  assert.equal(evaluate(out("risky", "Ask before touching production."), { sources }, o(recent)).action, "nudge", "risky passes the spacing");
  assert.equal(evaluate(out("rule", RULE), { sources }, o([{ ...recent[0], atMs: now - 11 * 60_000 }])).action, "nudge");

  // The same waiting question attached to another prompt is the same reminder.
  const waitSrc = new Map([
    ["S1", { ref: "S1", kind: "session" as const, text: "Should I use kciam or the w02283 sandbox?", label: "shop · e2e", atMs: now - 60_000, session: "c" }],
    ["P2", { ref: "P2", kind: "prompt" as const, text: "run the smoke tests on kciam", label: "shop · smoke", atMs: now - 30_000, session: "h" }],
  ]);
  const pend = (ev: Array<{ ref: string; quote: string }>) => ({ why: "w", speak: true, kind: "pending", confidence: 0.9, evidence: ev, text: "C is waiting", for_session: "f" });
  const first = evaluate(pend([{ ref: "S1", quote: "Should I use kciam or the w02283 sandbox?" }]), { sources: waitSrc }, { ...o([]), session: "d" });
  assert.equal(first.action, "nudge");
  const again = evaluate(pend([{ ref: "S1", quote: "Should I use kciam or the w02283 sandbox?" }, { ref: "P2", quote: "run the smoke tests on kciam" }]), { sources: waitSrc }, {
    ...o([{ id: 9, session: "d", kind: "pending", atMs: now - 20 * 60_000, fingerprint: (first as { fingerprint: string }).fingerprint }]),
    session: "i",
  });
  assert.match(again.why, /repeats nudge #9/);

  // The same rule line told to the same session again within a day, whatever the new prompt and the exact wording.
  const ruleSrc = new Map([["R1", { ref: "R1", kind: "rule" as const, text: "- Claude may open PRs, but a **human** always performs the merge. Merging to main is a deploy.", path: "/w/argo/CLAUDE.md" }]]);
  const r1 = evaluate(out("rule", "a human always performs the merge"), { sources: ruleSrc }, o([]));
  assert.equal(r1.action, "nudge");
  const prior1 = [{ id: 7, session: "s", kind: "rule", atMs: now - 40 * 60_000, fingerprint: (r1 as { fingerprint: string }).fingerprint, ruleLines: ["/w/argo/CLAUDE.md:1"] }];
  assert.match(evaluate(out("rule", "Merging to main is a deploy"), { sources: ruleSrc }, o(prior1)).why, /repeats nudge #7 \(same rule/);
  assert.equal(evaluate(out("rule", "Merging to main is a deploy"), { sources: ruleSrc }, { ...o(prior1), session: "other" }).action, "nudge", "another session hears it");
  assert.equal(evaluate(out("rule", "Merging to main is a deploy"), { sources: ruleSrc }, { ...o([{ ...prior1[0], atMs: now - 25 * 3600_000 }]) }).action, "nudge", "and so does this one, a day later");

  const min = minConfidenceFor({ nudgeMinConfidence: 0.7 }, { earlier: 3, rule: 2 });
  assert.equal(min("earlier"), 0.85);
  assert.equal(min("rule"), 0.7);

  // The spacing also saves the model run when nothing in the prompt is risky.
  const reg = freshHome();
  const fake = fakeOneShot([]);
  const cfg = { ...loadConfig(process.env.PILOT_HOME!, { cheap: true }), claudeBin: fake.bin };
  const group = [seedPrompt(reg, "s", now, "rename foo to bar everywhere")];
  const skipped = await checkPrompts(reg, cfg, group, { nowMs: now, prior: recent, nudgesForOpen: [], notUseful: {} });
  assert.equal(skipped.status, "skipped");
  assert.equal(fake.calls().length, 0, "no model run");
  const risky = await checkPrompts(reg, cfg, [seedPrompt(reg, "s", now, "delete the old /v1 endpoints in prod")], { nowMs: now, prior: recent, nudgesForOpen: [], notUseful: {} });
  assert.equal(risky.status, "silent");
  assert.equal(fake.calls().length, 1, "a risky prompt is still checked");
  const call = fake.calls()[0];
  const flag = (f: string) => call.args[call.args.indexOf(f) + 1];
  assert.equal(flag("--tools"), "", "no tools");
  assert.equal(flag("--model"), "sonnet");
  assert.ok(call.args.includes("--safe-mode") && flag("--setting-sources") === "local", "the isolated runner");
  assert.ok(!call.args.some((a) => a.includes("delete the old /v1")), "the prompt goes in on stdin, not argv");
  assert.ok(call.stdin.includes("delete the old /v1 endpoints in prod"));
});

test("delivery routing: rule/risky >= 0.8 go to the session's next turn once; others on request; ended sessions refuse", async () => {
  const reg = freshHome();
  const ws = workspace();
  const now = Date.now();
  const cfg = loadConfig(process.env.PILOT_HOME!, { cheap: true });
  assert.equal(cfg.nudgeToSession, "all", "by default every nudge that passed the checks goes to its session");
  assert.equal(routesToSession(cfg, "earlier", 0.72), true);
  assert.equal(routesToSession(cfg, "pending", 0.7), true);
  const risky = { ...cfg, nudgeToSession: "risky" as const };
  assert.equal(routesToSession(risky, "rule", 0.85), true);
  assert.equal(routesToSession(risky, "risky", 0.8), true);
  assert.equal(routesToSession(risky, "rule", 0.79), false);
  assert.equal(routesToSession(risky, "earlier", 0.95), false);
  assert.equal(routesToSession({ ...cfg, nudgeToSession: "off" }, "risky", 0.99), false);
  assert.equal(routesToSession({ ...cfg, delivery: "inbox" }, "risky", 0.99), false);

  seedSession(reg, "s1", ws.repo, ws.profile, null, "review PR #42 for the retry change");
  const sources = new Map([["R1", { ref: "R1", kind: "rule" as const, text: `- ${RULE}.`, path: path.join(ws.repo, "CLAUDE.md") }]]);
  const v = evaluate(ruleNudge.evidence ? { ...ruleNudge, evidence: [{ ref: "R1", quote: RULE }] } : null, { sources }, { session: "s1", nowMs: now, minConfidence: () => 0.7, prior: [], newRefs: new Set() });
  assert.equal(v.action, "nudge");
  const m = recordNudge(reg, cfg, v as Extract<typeof v, { action: "nudge" }>, "s1", now);
  assert.equal(m.state, "sent");
  assert.ok(m.queued_at_ms);
  assert.equal(m.session_label, `${path.basename(ws.repo)} · review PR #42 for the retry change`);
  assert.equal(unreadCount(reg), 1, "sent to the session, still unread for the person");

  const hook = { session_id: "s1", cwd: ws.repo, hook_event_name: "UserPromptSubmit", prompt: "ok" };
  const first = await cli(["deliver", "--context"], { PILOT_PROFILES: "*" }, JSON.stringify(hook));
  assert.equal(first.code, 0);
  assert.match(first.stdout, /The user's rule says to merge only when they write 'merge #<n>'/);
  assert.ok(first.stdout.includes(`"${RULE}"`), "with the quote");
  assert.match(first.stdout, /^Pilot \(the user's assistant\) noticed: The user's rule says/);
  assert.match(first.stdout, /Check with the user before acting on it\.\n$/);
  const second = await cli(["deliver", "--context"], { PILOT_PROFILES: "*" }, JSON.stringify(hook));
  assert.equal(second.stdout, "", "once");

  const earlier = insertMessage(reg, { atMs: now, role: "pilot", kind: "nudge", nudgeKind: "earlier", queued: false, text: "You said keep /v1.", evidence: [{ source: "prompt", where: "x · t", quote: "keep /v1", found: true }], session: "s1", confidence: 0.9, forSession: "Earlier the user said to keep /v1." });
  assert.equal(earlier.state, "new");
  assert.equal(claimQueued(reg, "s1", now), "", "not queued unless the person sends it");
  const sent = await cli(["api", "nudge", "--id", String(earlier.id), "--action", "send"]);
  assert.equal(JSON.parse(sent.stdout).message.state, "sent");
  assert.match(claimQueued(reg, "s1", now), /Earlier the user said to keep \/v1/);

  reg.prepare("UPDATE sessions SET ended_ms = updated_ms WHERE session = 's1'").run();
  const late = insertMessage(reg, { atMs: now, role: "pilot", kind: "nudge", nudgeKind: "missing", text: "Which sandbox?", session: "s1" });
  const ended = await cli(["api", "nudge", "--id", String(late.id), "--action", "send"]);
  assert.equal(ended.code, 1);
  assert.equal(JSON.parse(ended.stdout).error, "session ended");
});

test("chat storage: thread order, since/limit, unread, states, and redaction before storage", () => {
  const reg = freshHome();
  const now = Date.now();
  const key = `sk-ant-api03-${"A".repeat(40)}`;
  const n1 = insertMessage(reg, { atMs: now, role: "pilot", kind: "nudge", nudgeKind: "rule", text: `Your rule. token ${key}`, evidence: [{ source: "prompt", where: "w", quote: `export KEY=${key}`, found: true }], session: "s" });
  insertMessage(reg, { atMs: now + 1, role: "you", kind: "message", text: "what's waiting on me?" });
  insertMessage(reg, { atMs: now + 2, role: "pilot", kind: "answer", text: "Session C asked which sandbox to use." });
  const n2 = insertMessage(reg, { atMs: now + 3, role: "pilot", kind: "nudge", nudgeKind: "pending", text: "C is waiting.", session: "c" });
  const all = listMessages(reg, { limit: 50 });
  assert.deepEqual(all.map((m) => m.role + ":" + m.kind), ["pilot:nudge", "you:message", "pilot:answer", "pilot:nudge"]);
  assert.deepEqual(listMessages(reg, { limit: 2 }).map((m) => m.id), [all[2].id, all[3].id], "the latest N, oldest first");
  assert.deepEqual(listMessages(reg, { since: all[1].id, limit: 10 }).map((m) => m.id), [all[2].id, all[3].id]);
  assert.ok(!getMessage(reg, n1.id)!.text.includes(key) && !getMessage(reg, n1.id)!.evidence_json.includes(key), "secrets are redacted before storage");
  assert.equal(unreadCount(reg), 2);
  assert.equal(actOnNudge(reg, n1.id, "seen", now).state, "seen");
  assert.equal(unreadCount(reg), 1);
  assert.equal(actOnNudge(reg, n1.id, "not_useful", now).state, "not_useful");
  assert.equal(actOnNudge(reg, n2.id, "dismiss", now).state, "dismissed");
  assert.equal(unreadCount(reg), 0);
  assert.throws(() => actOnNudge(reg, all[2].id, "seen", now), /not a nudge/);
  assert.throws(() => actOnNudge(reg, 999, "seen", now), /no message 999/);
  insertMessage(reg, { atMs: now, role: "pilot", kind: "nudge", nudgeKind: "missing", text: "x", session: "s" });
  assert.equal(markAllSeen(reg, now), 1);
  assert.equal(unreadCount(reg), 0);
  assert.equal(priorNudges(reg).length, 3);
});

test("hooks store the person's prompts, each session's end-of-turn message (or the transcript's tail) and its end", async () => {
  const reg = freshHome();
  const ws = workspace();
  const transcript = ws.transcript("s9");
  fs.writeFileSync(
    transcript,
    [
      { type: "user", message: { content: "hi" } },
      { type: "assistant", message: { content: [{ type: "text", text: "First answer." }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Should I use kciam or the w02283 sandbox?" }] } },
      { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent chatter" }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n"),
  );
  assert.equal(transcriptLastMessage(transcript), "Should I use kciam or the w02283 sandbox?");
  const base = { session_id: "s9", cwd: ws.repo, transcript_path: transcript };
  const run = (input: Record<string, unknown>) => cli(["hook"], { PILOT_PROFILES: "*" }, JSON.stringify(input));
  await run({ ...base, hook_event_name: "SessionStart", source: "startup" });
  await run({ ...base, hook_event_name: "UserPromptSubmit", prompt: "<task-notification>done</task-notification>" });
  await run({ ...base, hook_event_name: "UserPromptSubmit", prompt: "set up the e2e run for the order flow" });
  await run({ ...base, hook_event_name: "UserPromptSubmit", prompt: "and keep it short" });
  await run({ ...base, hook_event_name: "Stop", last_assistant_message: "Done. Want me to merge #7?" });
  await run({ ...base, hook_event_name: "Stop" }); // no message in the payload: read the transcript's tail
  const s = reg.prepare("SELECT first_prompt, ended_ms FROM sessions WHERE session = 's9'").get() as { first_prompt: string; ended_ms: number | null };
  assert.equal(s.first_prompt, "set up the e2e run for the order flow", "automated turns are not the first prompt");
  const turns = reg.prepare("SELECT text FROM session_turns WHERE session = 's9' ORDER BY ts_ms").all() as Array<{ text: string }>;
  assert.deepEqual(turns.map((t) => t.text), ["Done. Want me to merge #7?", "Should I use kciam or the w02283 sandbox?"]);
  assert.equal(loadPrompts(reg, 0).length, 2);
  await run({ ...base, hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
  assert.ok((reg.prepare("SELECT ended_ms FROM sessions WHERE session = 's9'").get() as { ended_ms: number }).ended_ms > 0);
});

test("the daemon checks a prompt end to end and the API shows the chat, status and activity", async () => {
  freshHome();
  const ws = workspace();
  const fake = fakeOneShot([
    {
      match: ["# 1. The person's question\nwhat's waiting on me?"],
      output: { text: "Session C asked whether to use kciam or the w02283 sandbox.", evidence: [{ ref: "auto", quote: "Should I use kciam or the w02283 sandbox?" }, { ref: "P1", quote: "a quote nobody wrote" }] },
    },
    allSupported,
    { match: ["looks good, merge it"], output: ruleNudge, costUsd: 0.05 },
  ]);
  Object.assign(process.env, { PILOT_CLAUDE_BIN: fake.bin, PILOT_PROMPT_QUIET_MS: "0", PILOT_POLL_MS: "50", PILOT_PROFILES: "*" });
  try {
    const run = (input: Record<string, unknown>) => cli(["hook"], {}, JSON.stringify(input));
    const a = { session_id: "A1", cwd: ws.repo, transcript_path: ws.transcript("A1") };
    const c = { session_id: "C", cwd: ws.repo, transcript_path: ws.transcript("C") };
    await run({ ...c, hook_event_name: "UserPromptSubmit", prompt: "set up the e2e run for the order flow" });
    await run({ ...c, hook_event_name: "Stop", last_assistant_message: "I can run it on kciam or on the sandbox.\n\nShould I use kciam or the w02283 sandbox?" });
    await run({ ...a, hook_event_name: "UserPromptSubmit", prompt: "review PR #42 for the retry change" });
    await run({ ...a, hook_event_name: "Stop", last_assistant_message: "PR #42 looks fine. Want me to merge it?" });
    await run({ ...a, hook_event_name: "UserPromptSubmit", prompt: "looks good, merge it" });
    const logs: string[] = [];
    await daemon({ log: (m) => logs.push(m), untilIdle: true, promptWatch: true, engine: false, makeInvestigator: async () => { throw new Error("no reviews here"); } });
    assert.equal(fake.calls().length, 4, `three prompts, three checks, and one sentence check for the nudge:\n${logs.join("\n")}`);
    assert.ok(logs.some((l) => /check #\d+ .*nudge #\d+ \(rule/.test(l)), logs.join("\n"));

    const chat = JSON.parse((await cli(["api", "chat"])).stdout);
    assert.equal(chat.unread, 1);
    assert.equal(chat.messages.length, 1);
    const m = chat.messages[0];
    assert.deepEqual(Object.keys(m).sort(), ["at", "engine", "evidence", "id", "kind", "nudgeKind", "repo", "role", "session", "sessionLabel", "state", "text"].sort());
    assert.equal(m.engine, "claude");
    assert.deepEqual([m.role, m.kind, m.nudgeKind, m.session, m.state, m.repo], ["pilot", "nudge", "rule", "A1", "sent", path.basename(ws.repo)]);
    assert.equal(m.sessionLabel, `${path.basename(ws.repo)} · review PR #42 for the retry change`);
    assert.deepEqual(m.evidence, [{ source: "rule", where: `${path.join(ws.repo, "CLAUDE.md").replace(os.homedir(), "~")}:4`, quote: RULE, found: true }]);
    assert.ok(!Number.isNaN(Date.parse(m.at)));

    const st = JSON.parse((await cli(["api", "status"])).stdout);
    assert.equal(st.unread, 1);
    assert.equal(st.sessions, 2);
    assert.equal(st.reviewWork, true, "helpers turn it on for the other suites");
    assert.equal(st.budget.spentCents, 5 + 4 + 4 + 4, "prompt checks (and the sentence check) count against the daily budget");

    const act = JSON.parse((await cli(["api", "activity"])).stdout);
    const checks = act.runs.filter((r: any) => r.kind === "prompt-check");
    assert.equal(checks.length, 3);
    assert.ok(checks.every((r: any) => r.repo === path.basename(ws.repo) && r.trigger === "prompt"));
    assert.ok(!JSON.stringify(act).includes("merge it") && !JSON.stringify(act).includes(RULE), "activity never carries prompt text or quotes");

    const asked = await cli(["api", "ask", "--text", "what's waiting on me?"]);
    assert.equal(asked.code, 0, asked.stdout + asked.stderr);
    const r = JSON.parse(asked.stdout);
    assert.deepEqual(Object.keys(r).sort(), ["answer", "api", "question"]);
    assert.deepEqual([r.question.role, r.question.kind, r.question.text], ["you", "message", "what's waiting on me?"]);
    assert.deepEqual([r.answer.role, r.answer.kind, r.answer.nudgeKind, r.answer.engine, r.question.engine], ["pilot", "answer", null, "claude", null]);
    assert.equal(r.answer.evidence[0].found, true);
    assert.equal(r.answer.evidence[0].source, "session");
    assert.match(r.answer.evidence[0].where, / · \d{4}-\d\d-\d\dT/);
    assert.equal(r.answer.evidence[1].found, false, "an answer keeps a quote that does not match, marked not found");

    const seen = JSON.parse((await cli(["api", "nudge", "--all", "--action", "seen"])).stdout);
    assert.deepEqual(seen, { api: 1, ok: true, message: null, updated: 1 });
    const one = JSON.parse((await cli(["api", "nudge", "--id", String(m.id), "--action", "useful"])).stdout);
    assert.equal(one.message.state, "useful");
    const since = JSON.parse((await cli(["api", "chat", "--since", String(m.id)])).stdout);
    assert.deepEqual(since.messages.map((x: any) => x.kind), ["message", "answer"]);
    assert.equal(since.unread, 0);
    for (const bad of [["chat", "--since", "x"], ["nudge", "--id", "1"], ["nudge", "--all", "--action", "dismiss"], ["ask"], ["ask", "--text", "x".repeat(4001)], ["nudge", "--id", "1", "--action", "explode"]]) {
      const res = await cli(["api", ...bad]);
      assert.equal(res.code, 1, bad.join(" "));
      assert.ok(JSON.parse(res.stdout).error);
    }
  } finally {
    for (const k of ["PILOT_PROMPT_QUIET_MS", "PILOT_POLL_MS"]) delete process.env[k];
    process.env.PILOT_CLAUDE_BIN = path.join(os.tmpdir(), "no-real-claude-in-unit-tests");
  }
});

test("ask: a timeout is an error, and the thread says so", async () => {
  freshHome();
  const fake = fakeOneShot([{ match: ["slow question"], sleepMs: 5_000, output: { text: "late", evidence: [] } }]);
  const res = await cli(["api", "ask", "--text", "slow question"], { PILOT_CLAUDE_BIN: fake.bin, PILOT_ASK_TIMEOUT_SEC: "1" });
  assert.equal(res.code, 1);
  assert.match(JSON.parse(res.stdout).error, /^No answer within 1 s\.$/);
  const chat = JSON.parse((await cli(["api", "chat"])).stdout);
  assert.deepEqual(chat.messages.map((m: any) => [m.role, m.kind]), [["you", "message"], ["pilot", "note"]]);
});

test("grounding: sentences the quotes and the prompt do not support are removed; none left drops the nudge", async () => {
  assert.deepEqual(splitSentences("In argo-cd Claude never merges. You also said 3 minutes ago that you wanted to wait till Monday. Has 4.2 shipped?"), [
    "In argo-cd Claude never merges.",
    "You also said 3 minutes ago that you wanted to wait till Monday.",
    "Has 4.2 shipped?",
  ]);
  assert.deepEqual(splitSentences("Use e.g. kciam. Then ask."), ["Use e.g. kciam.", "Then ask."]);
  const v = {
    action: "nudge" as const,
    kind: "rule" as const,
    text: "In argo-cd Claude never merges PRs; you merge yourself. You also said 3 minutes ago that you wanted to wait till Monday.",
    forSession: "The user's rule says a human performs every merge in argo-cd. The user wants to wait till Monday.",
    confidence: 0.85,
    evidence: [{ source: "rule" as const, where: "~/w/argo-cd/CLAUDE.md:7", quote: "a **human** always performs the merge", found: true }],
    fingerprint: "f",
    why: "w",
  };
  const prompt = [{ key: "k", session: "s", tsMs: Date.now(), text: "No, I said we should not wait for Monday. Let's merge the fixes right now.", checkId: null }];
  const line7 = "Merging to main here is a deploy. Claude may open PRs, but a **human** always performs the merge, even with explicit approval.";
  const g = groundingInput(prompt, v, new Map([["R1", { ref: "R1", kind: "rule" as const, text: `# argo-cd\n\n${line7}\n`, path: "/w/argo-cd/CLAUDE.md" }]]));
  assert.ok(g.input.includes(`where it sits: ${line7}`), "the check sees the whole quoted line");
  const heading = groundingInput(prompt, { ...v, evidence: [{ source: "rule", where: "~/w/argo-cd/CLAUDE.md:1", quote: "# argo-cd", found: true }] }, new Map([["R1", { ref: "R1", kind: "rule" as const, text: `# argo-cd\n\n${line7}\n\n## Other\nnot this`, path: "/w/argo-cd/CLAUDE.md" }]]));
  assert.ok(heading.input.includes(line7) && !heading.input.includes("not this"), "a quoted heading comes with its section, up to the next heading");
  assert.match(g.input, /# The new prompt\nNo, I said we should not wait for Monday/);
  assert.match(g.input, /- rule \(~\/w\/argo-cd\/CLAUDE\.md:7\): "a \*\*human\*\* always performs the merge"/);
  assert.match(g.input, /\n1\. In argo-cd Claude never merges PRs; you merge yourself\.\n2\. You also said 3 minutes ago/);
  assert.match(g.input, /\n3\. The user's rule says a human performs every merge in argo-cd\.\n4\. The user wants to wait till Monday\./);
  const kept = applyGrounding(v, g, { sentences: [{ n: 1, supported: true }, { n: 2, supported: false }, { n: 3, supported: true }, { n: 4, supported: false }] });
  assert.equal(kept.action, "nudge");
  assert.equal(kept.text, "In argo-cd Claude never merges PRs; you merge yourself.");
  assert.equal((kept as { forSession: string }).forSession, "The user's rule says a human performs every merge in argo-cd.");
  assert.deepEqual(kept.removed, ["You also said 3 minutes ago that you wanted to wait till Monday.", "The user wants to wait till Monday."]);
  const none = applyGrounding(v, g, { sentences: [{ n: 1, supported: false }, { n: 2, supported: false }, { n: 3, supported: true }] });
  assert.equal(none.action, "dropped");
  assert.match(none.why, /no sentence of the message was supported/);
  assert.equal(applyGrounding(v, g, { nonsense: true }).action, "dropped", "an answer without sentences supports nothing");

  // End to end with a fake engine: the check produces the nudge, the sentence check trims it; activity says so.
  const reg = freshHome();
  const ws = workspace();
  seedSession(reg, "g1", ws.repo, ws.profile, null, "merge the retry PR");
  seedSession(reg, "g2", ws.repo, ws.profile, null, "merge the other PR");
  const check = { ...ruleNudge, evidence: [{ ref: "auto", quote: RULE }], text: "Your rule says merge only on 'merge #N'. You also said yesterday to wait for QA." };
  const fake = fakeOneShot([
    { match: ["# Message sentences, to the person"], output: { sentences: [{ n: 1, supported: true, why: "rule" }, { n: 2, supported: false, why: "not in sources" }, { n: 3, supported: true, why: "rule" }] } },
    { match: ["looks good, merge it"], output: check },
  ]);
  const cfg = { ...loadConfig(process.env.PILOT_HOME!, { cheap: true }), claudeBin: fake.bin };
  const now = Date.now();
  const out = await checkPrompts(reg, cfg, [seedPrompt(reg, "g1", now, "looks good, merge it")], { nowMs: now, prior: [], nudgesForOpen: [], notUseful: {} });
  assert.equal(out.status, "nudge");
  assert.equal(out.verdict?.text, "Your rule says merge only on 'merge #N'.");
  assert.match(out.summary, /1 unsupported sentence removed/);
  assert.equal(fake.calls().length, 2, "one check, one sentence check");
  assert.equal(out.costCents, 4 + 4);

  // The sentence check cannot run: the nudge is not shown.
  const broken = fakeOneShot([{ match: ["# Message sentences, to the person"], output: "not an object" }, { match: ["looks good, merge it"], output: check }]);
  const out2 = await checkPrompts(reg, { ...cfg, claudeBin: broken.bin }, [seedPrompt(reg, "g2", now, "looks good, merge it")], { nowMs: now, prior: [], nudgesForOpen: [], notUseful: {} });
  assert.equal(out2.status, "dropped");
  assert.match(out2.summary, /the sentence check did not run/);
});

test("labels lose paste markup and reminders; quotes lose Markdown dressing, only after they were checked", () => {
  assert.equal(readableText('<pasted_content id="55f4"> #584 is a big PR</pasted_content>'), "#584 is a big PR");
  assert.equal(readableText("<system-reminder>internal note</system-reminder> <command-name>/review</command-name>"), "/review");
  assert.equal(sessionLabel("work", '<pasted_content id="55f4"> #584 is a big change to the deploy flow for prod</pasted_content>', "s"), "work · #584 is a big change to the deploy flow…");
  assert.equal(sessionLabel("work", "<system-reminder>only this</system-reminder>", "s"), "work · untitled");
  assert.equal(sessionLabel(null, null, "s"), "no repo · untitled");

  // A first prompt with nothing readable gives way to the next prompt.
  const reg = freshHome();
  const ws = workspace();
  const now = Date.now();
  seedSession(reg, "p1", ws.repo, ws.profile, null, '<pasted_content id="9"></pasted_content>');
  seedPrompt(reg, "p1", now - 2_000, '<pasted_content id="9"></pasted_content>');
  seedPrompt(reg, "p1", now - 1_000, "fix the retry in checkout");
  seedSession(reg, "p2", ws.repo, ws.profile, null, '<pasted_content id="7"></pasted_content>');
  const sessions = loadSessions(reg, loadPrompts(reg, now - 3600_000, now));
  assert.equal(sessions.get("p1")?.label, `${path.basename(ws.repo)} · fix the retry in checkout`);
  assert.equal(sessions.get("p2")?.label, `${path.basename(ws.repo)} · untitled`);

  assert.equal(displayQuote("- Never merge a PR unless the user writes 'merge #<n>'."), "Never merge a PR unless the user writes 'merge #<n>'.");
  assert.equal(displayQuote("**Your calls:** use `kciam` or __w02283__"), "Your calls: use kciam or w02283");
  assert.equal(displayQuote("## Rules"), "Rules");
  assert.equal(displayQuote("1. keep /v1\n> until 4.2 ships"), "keep /v1\nuntil 4.2 ships");

  // Stored exactly as checked; apps and sessions get the readable text.
  const m = insertMessage(reg, {
    atMs: now,
    role: "pilot",
    kind: "nudge",
    nudgeKind: "rule",
    text: "Your rule.",
    evidence: [{ source: "rule", where: "~/w/CLAUDE.md:4", quote: "- **Never** merge a PR", found: true }, { source: "prompt", where: 'work · <pasted_content id="1"> #584… · 2026-11-06T10:00:00Z', quote: "`merge it`", found: true }],
    session: "p1",
    sessionLabel: 'work · <pasted_content id="1"> #584 is a…',
    forSession: "The user's rule.",
    queued: true,
  });
  assert.match(getMessage(reg, m.id)!.evidence_json, /- \*\*Never\*\* merge a PR/);
  const api = apiMessage(m) as { sessionLabel: string; evidence: Array<{ quote: string; where: string }> };
  assert.equal(api.sessionLabel, "work · #584 is a…");
  assert.deepEqual(api.evidence.map((e) => [e.where, e.quote]), [["~/w/CLAUDE.md:4", "Never merge a PR"], ["work · #584… · 2026-11-06T10:00:00Z", "merge it"]]);
  assert.match(formatForSession([m]), /"Never merge a PR"/);
});

/** Runs a hook command from hooks.json the way Claude Code does: through the shell, payload on stdin. */
function hookCommand(event: string, matcher: string | undefined, input: Record<string, unknown>, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; ms: number }> {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8")).hooks[event] as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
  const entry = hooks.find((h) => h.matcher === matcher && h.hooks.some((x) => x.command.includes("deliver --tool")))!;
  const command = entry.hooks.find((x) => x.command.includes("deliver --tool"))!.command;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn("/bin/sh", ["-c", command], { env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, PILOT_AUTOSTART: "0", ...env } });
    let stdout = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.on("close", (code) => resolve({ code, stdout, ms: Date.now() - t0 }));
    c.stdin.end(JSON.stringify(input));
  });
}

test("mid-turn delivery: a queued nudge reaches its session at the next tool call (before Bash), once; the turn end wakes it otherwise", async () => {
  const reg = freshHome();
  const ws = workspace();
  const now = Date.now();
  seedSession(reg, "m1", ws.repo, ws.profile, null, "review PR #42");
  const flag = path.join(process.env.PILOT_HOME!, "outbox-pending");
  const base = { session_id: "m1", cwd: ws.repo, tool_name: "Bash", tool_input: { command: "gh pr merge 42" } };

  // Nothing queued: the shell test skips Node entirely and the hook says nothing.
  assert.equal(fs.existsSync(flag), false);
  const idle = await hookCommand("PreToolUse", "Bash", { ...base, hook_event_name: "PreToolUse" });
  assert.deepEqual([idle.code, idle.stdout], [0, ""]);

  const m = insertMessage(reg, {
    atMs: now,
    role: "pilot",
    kind: "nudge",
    nudgeKind: "rule",
    text: "Your rule says merge only on 'merge #N'.",
    evidence: [{ source: "rule", where: "~/w/CLAUDE.md:4", quote: `- ${RULE}.`, found: true }],
    session: "m1",
    sessionLabel: "shop · review PR #42",
    forSession: "The user's rule says to merge only when they write 'merge #<n>'.",
    queued: true,
  });
  assert.ok(fs.existsSync(flag), "the flag file says something is queued");
  // Another session's tool call finds nothing for itself and leaves the nudge alone.
  const other = await hookCommand("PostToolUse", "*", { ...base, session_id: "zz", hook_event_name: "PostToolUse" });
  assert.equal(other.stdout, "");
  const pre = await hookCommand("PreToolUse", "Bash", { ...base, hook_event_name: "PreToolUse" });
  assert.equal(pre.code, 0);
  const out = JSON.parse(pre.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse", "before the Bash call runs");
  assert.equal(
    out.hookSpecificOutput.additionalContext,
    `Pilot (the user's assistant) noticed: The user's rule says to merge only when they write 'merge #<n>'. Quote: "${RULE}." (~/w/CLAUDE.md:4). Check with the user before acting on it.`,
  );
  assert.ok(getMessage(reg, m.id)!.delivered_at_ms, "marked delivered");
  assert.equal(fs.existsSync(flag), false, "nothing queued any more");
  assert.equal((await hookCommand("PostToolUse", "*", { ...base, hook_event_name: "PostToolUse" })).stdout, "", "once");

  // After any tool: PostToolUse carries it.
  insertMessage(reg, { atMs: now, role: "pilot", kind: "nudge", nudgeKind: "pending", text: "C is waiting.", session: "m1", forSession: "Session C asked the user which sandbox to use.", queued: true });
  const post = JSON.parse((await hookCommand("PostToolUse", "*", { ...base, tool_name: "Read", hook_event_name: "PostToolUse" })).stdout);
  assert.equal(post.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(post.hookSpecificOutput.additionalContext, /^Pilot \(the user's assistant\) noticed: Session C asked the user which sandbox to use\. Check with the user/);

  // Turn end: while this session's prompt check runs, the Stop hook waits; then it wakes Claude with the nudge.
  const p = seedPrompt(reg, "m1", Date.now(), "looks good, merge it");
  const run = Number(reg.prepare("INSERT INTO watch_runs(kind, session, created_ms, status) VALUES ('check', 'm1', ?, 'running')").run(Date.now()).lastInsertRowid);
  reg.prepare("UPDATE session_prompts SET check_id = ? WHERE dedupe_key = ?").run(run, p.key);
  const rewake = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const c = spawn(path.join(ROOT, "scripts", "pilot"), ["deliver", "--rewake"], { env: { ...process.env, PILOT_AUTOSTART: "0", PILOT_PROFILES: "*" } });
    let stderr = "";
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code, stderr }));
    c.stdin.end(JSON.stringify({ session_id: "m1", cwd: ws.repo, hook_event_name: "Stop" }));
  });
  await new Promise((r) => setTimeout(r, 2_500));
  insertMessage(reg, { atMs: Date.now(), role: "pilot", kind: "nudge", nudgeKind: "rule", text: "Merge only on merge #N.", session: "m1", forSession: "The user's rule says merge only on 'merge #<n>'.", queued: true });
  reg.prepare("UPDATE watch_runs SET status = 'nudge' WHERE id = ?").run(run);
  const woke = await rewake;
  assert.equal(woke.code, 2, "asyncRewake: exit 2 wakes Claude with stderr");
  assert.match(woke.stderr, /^Pilot \(the user's assistant\) noticed: The user's rule says merge only on 'merge #<n>'\. Check with the user before acting on it\.\n$/);
});
