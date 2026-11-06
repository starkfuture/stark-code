#!/usr/bin/env bash
# Prompt-watch acceptance trial (docs/prompt-watch.md §9) with REAL model runs: `claude -p` through the configured
# claude_bin (PILOT_CLAUDE_BIN, e.g. from .env). It FAILS when Pilot speaks when it should not, or stays quiet
# when it must speak.
#
# Simulated sessions: hook payloads go into the real `pilot hook` (as the plugin would send them), the real daemon
# checks each prompt, the real API reads the chat. Everything lives in a private PILOT_HOME (TRIAL_HOME, default
# <trial dir>/home), so ~/.pilot and ~/.lookout are never touched. The sessions run in a throwaway project whose CLAUDE.md holds the
# rule, under a throwaway Claude Code profile (no global CLAUDE.md, no memory).
#   4. ordinary prompts ("add a unit test for parseDate", "rename foo to bar")          -> silent
#   1. CLAUDE.md rule "never merge unless 'merge #<n>'"; "looks good, merge it"         -> one `rule` nudge quoting it,
#      delivered into the session at its next Bash call (the PreToolUse hook), once
#   2. session A "keep the /v1 endpoints until the mobile app 4.2 ships"; session B
#      "delete all the /v1 endpoints"                                                    -> one `earlier` nudge quoting A
#   3. session C ends with "Should I use kciam or the w02283 sandbox?"; D starts other work -> one `pending` nudge
#   5. pilot ask "what's waiting on me?"                                                  -> mentions C's question, quote found
#   6. (INFO, demo) two sandboxes used today; "deploy it to the sandbox"                  -> whatever it says is reported
#   7. one question through Codex (--engine=codex, the person's per-question choice)    -> answered by Codex, quote found
# Cost: one isolation self-test (skipped when the home already has a passing one) + ~12 short Sonnet calls + one
# Codex run on the person's Codex plan (codex_bin, codex_model).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LK="$ROOT/scripts/pilot"
set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a
WORK="${TRIAL_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/pilot-nudges.XXXXXX")}"
mkdir -p "$WORK"
export PILOT_HOME="${TRIAL_HOME:-$WORK/home}" PILOT_PROFILES="*" PILOT_AUTOSTART=0 PILOT_MODE=local PILOT_ENGINE=claude
export PILOT_PROMPT_QUIET_MS=1000 PILOT_POLL_MS=300
PROFILE="$WORK/profile"
REPO="$WORK/shop"
FAIL=0
hdr() { printf '\n\033[1;35m=== %s ===\033[0m\n' "$*"; }
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAIL=1; }
info() { echo "INFO  $*"; }

rm -rf "$REPO" "$PROFILE"; mkdir -p "$REPO" "$PROFILE/projects/shop"
cat > "$REPO/CLAUDE.md" <<'EOF'
# Shop service

- Use pnpm, not npm.
- Never merge a PR unless the user writes 'merge #<n>'.
- Ask before touching production.
EOF
printf 'export const parseDate = (s) => new Date(s);\nexport const foo = 1;\n' > "$REPO/utils.js"
git -C "$REPO" init -q -b main && git -C "$REPO" config user.email trial@example.invalid && git -C "$REPO" config user.name trial
git -C "$REPO" add -A && git -C "$REPO" commit -qm baseline

# Hook payloads, as Claude Code sends them from a session of the throwaway profile.
emit() { # event session text
  node -e '
    const [ev, session, cwd, transcript, text] = process.argv.slice(1);
    const p = { session_id: session, cwd, transcript_path: transcript, hook_event_name: ev, permission_mode: "default" };
    if (ev === "UserPromptSubmit") p.prompt = text;
    if (ev === "Stop") p.last_assistant_message = text;
    process.stdout.write(JSON.stringify(p));
  ' "$1" "$2" "$REPO" "$PROFILE/projects/shop/$2.jsonl" "${3:-}" | CLAUDE_CONFIG_DIR="$PROFILE" "$LK" hook
}
prompt() { emit UserPromptSubmit "$1" "$2"; }
reply() { emit Stop "$1" "$2"; }
check() { "$LK" daemon --until-idle >> "$WORK/daemon.log" 2>&1; }
# Nudges said to one session, as JSON lines {kind, text, evidence}.
nudges_for() {
  "$LK" api chat --limit 1000 | node -e '
    const s = process.argv[1]; let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
      for (const m of JSON.parse(d).messages) if (m.kind === "nudge" && m.session === s) console.log(JSON.stringify({ kind: m.nudgeKind, text: m.text, evidence: m.evidence }));
    });' "$1"
}
expect_silent() { # session label
  local n; n=$(nudges_for "$1" | wc -l | tr -d ' ')
  if [ "$n" = 0 ]; then pass "$2: silent"; else fail "$2: expected silence, got $n nudge(s): $(nudges_for "$1")"; fi
}
expect_nudge() { # session kind quote-pattern label
  local out n; out=$(nudges_for "$1"); n=$(printf '%s' "$out" | grep -c . || true)
  if [ "$n" != 1 ]; then fail "$4: expected one $2 nudge, got $n: $out"; return; fi
  if ! printf '%s' "$out" | node -e '
      const [kind, pat] = process.argv.slice(1); let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
        const m = JSON.parse(d); const ok = m.kind === kind && m.evidence.some((e) => e.found && new RegExp(pat, "i").test(e.quote));
        process.exit(ok ? 0 : 1); });' "$2" "$3"; then
    fail "$4: expected a $2 nudge quoting /$3/, got: $out"; return
  fi
  pass "$4: one $2 nudge, quote found"
  printf '%s' "$out" | node -e 'let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => { const m = JSON.parse(d); console.log(`      "${m.text}"`); for (const e of m.evidence) console.log(`      - ${e.source} ${e.where}: "${e.quote}"`); });'
}

if "$LK" api status | node -e 'let d=""; process.stdin.on("data",(c)=>(d+=c)).on("end",()=>process.exit(JSON.parse(d).selftest.ok?0:1))'; then
  hdr "0. Isolation self-test: a passing one is already recorded in this home"
else
  hdr "0. Isolation self-test (real claude -p run; canaries; prompt checks refuse to run without it)"
  "$LK" selftest > "$WORK/selftest.log" 2>&1 || { cat "$WORK/selftest.log"; echo "ABORT: local isolation could not be verified"; exit 4; }
  tail -1 "$WORK/selftest.log"
fi

hdr "4. Ordinary prompts stay silent"
prompt sess-E "add a unit test for parseDate"; check
expect_silent sess-E '"add a unit test for parseDate"'
prompt sess-F "rename foo to bar"; check
expect_silent sess-F '"rename foo to bar"'

hdr "1. A written rule: never merge unless the user writes 'merge #<n>'"
prompt sess-A1 "review PR #42 for the retry change"; check
reply sess-A1 "PR #42 looks fine: the retries are bounded, the new tests pass and CI is green. Want me to merge it?"
expect_silent sess-A1 "the review request itself"
prompt sess-A1 "looks good, merge it"; check
expect_nudge sess-A1 rule "never merge a pr unless" '"looks good, merge it"'
# Mid-turn delivery: the session is still working on "merge it" and is about to run `gh pr merge`. Run the plugin's
# PreToolUse hook command exactly as Claude Code would (through the shell, payload on stdin).
pre_cmd=$(node -e 'console.log(require(process.argv[1]).hooks.PreToolUse[0].hooks[0].command)' "$ROOT/hooks/hooks.json")
said=$(printf '{"session_id":"sess-A1","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"gh pr merge 42"}}' "$REPO" \
  | CLAUDE_PLUGIN_ROOT="$ROOT" CLAUDE_CONFIG_DIR="$PROFILE" sh -c "$pre_cmd")
if printf '%s' "$said" | node -e '
    let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
      try { const o = JSON.parse(d).hookSpecificOutput; console.log(`      | ${o.additionalContext}`);
        process.exit(o.hookEventName === "PreToolUse" && /^Pilot \(the user.s assistant\) noticed: /.test(o.additionalContext) && /never merge a pr unless/i.test(o.additionalContext) ? 0 : 1);
      } catch { process.exit(1); } });'; then
  pass "the rule nudge reached session A1 mid-turn, before its Bash call ran"
else
  fail "the rule nudge did not reach session A1 at its next Bash call (got: ${said:-nothing})"
fi
again=$(printf '{"session_id":"sess-A1","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' "$REPO" \
  | CLAUDE_PLUGIN_ROOT="$ROOT" CLAUDE_CONFIG_DIR="$PROFILE" sh -c "$pre_cmd")
if [ -z "$again" ]; then pass "and only once"; else fail "it was delivered twice"; fi

hdr "2. Something the person said earlier, in another session"
prompt sess-A "keep the /v1 endpoints until the mobile app 4.2 ships"; check
reply sess-A "Understood. I'll leave the /v1 endpoints in place until mobile app 4.2 ships and only add /v2 next to them."
expect_silent sess-A "the instruction itself"
prompt sess-B "delete all the /v1 endpoints"; check
expect_nudge sess-B earlier "/v1.*4\.2|4\.2.*/v1" '"delete all the /v1 endpoints"'

hdr "3. A question still waiting on the person"
prompt sess-C "set up the e2e run for the order flow"; check
reply sess-C "I prepared the e2e config for the order flow; it only needs an environment now. Should I use kciam or the w02283 sandbox?"
expect_silent sess-C "the e2e request itself"
prompt sess-D "write the release notes for the storefront 1.2645 release"; check
expect_nudge sess-D pending "kciam|w02283" "unrelated work in D"

hdr "5. Asking Pilot: what's waiting on me?"
ans=$("$LK" api ask --text "what's waiting on me?")
if printf '%s' "$ans" | node -e '
    let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
      const r = JSON.parse(d); if (r.error) { console.log(`      error: ${r.error}`); process.exit(1); }
      console.log(`      "${r.answer.text}"`); for (const e of r.answer.evidence) console.log(`      - ${e.found ? "found" : "NOT FOUND"} ${e.source} ${e.where}: "${e.quote}"`);
      const ok = /kciam|w02283/i.test(r.answer.text) && r.answer.evidence.some((e) => e.found && e.source === "session" && /kciam|w02283/i.test(e.quote));
      process.exit(ok ? 0 : 1); });'; then
  pass "the answer mentions session C's question, with a found quote"
else
  fail "the answer does not mention session C's question with a found quote"
fi

hdr "6. (INFO, demo) A detail the session would have to guess"
prompt sess-G "deploy admin-next to the w02283 sandbox"; check
reply sess-G "Deployed admin-next to sandboxenv-w02283; the smoke test passed."
prompt sess-H "run the checkout smoke tests on the kciam sandbox"; check
reply sess-H "The checkout smoke tests passed on sandboxenv-kciam."
prompt sess-I "deploy the storefront to the sandbox and send me the link"; check
out=$(nudges_for sess-I)
if [ -n "$out" ]; then info "it said: $out"; else info "it stayed silent"; fi

hdr "7. One question through Codex (the per-question engine switch)"
codex_state=$("$LK" api settings | node -e 'let d=""; process.stdin.on("data",(c)=>(d+=c)).on("end",()=>{const c=JSON.parse(d).engines.codex; console.log(c.available ? "ok" : `unavailable: ${c.note}`)})')
if [ "$codex_state" = ok ]; then
  ans=$("$LK" api ask --text="Which of my sessions asked me something I haven't answered yet?" --engine=codex)
  if printf '%s' "$ans" | node -e '
      let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
        const r = JSON.parse(d); if (r.error) { console.log(`      error: ${r.error}`); process.exit(1); }
        console.log(`      [${r.answer.engine}] "${r.answer.text}"`); for (const e of r.answer.evidence) console.log(`      - ${e.found ? "found" : "NOT FOUND"} ${e.source} ${e.where}: "${e.quote}"`);
        const ok = r.answer.engine === "codex" && /kciam|w02283/i.test(r.answer.text) && r.answer.evidence.some((e) => e.found && /kciam|w02283/i.test(e.quote));
        process.exit(ok ? 0 : 1); });'; then
    pass "Codex answered (engine codex), mentioning session C's question with a found quote"
  else
    fail "the Codex answer is missing, came from another engine, or has no found quote about C's question"
  fi
else
  echo "UNAVAILABLE  Codex cannot run here ($codex_state); not worked around"
fi

hdr "Runs and cost"
"$LK" api activity --limit 100 | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const runs = JSON.parse(d).runs.filter((r) => r.kind === "prompt-check" || r.kind === "chat-answer").reverse();
    let cents = 0; for (const r of runs) { cents += r.costCents ?? 0; console.log(`  ${r.kind.padEnd(12)} ${String(r.status).padEnd(8)} $${((r.costCents ?? 0) / 100).toFixed(2)}  ${r.summary}`); }
    console.log(`  total for Claude checks and answers: $${(cents / 100).toFixed(2)} (API-equivalent estimate; Codex runs use the Codex plan)`); });'
[ -f "$WORK/selftest.log" ] && echo "  (plus the isolation self-test run)"
hdr "The chat thread"
"$LK" chat
echo
[ "$FAIL" = 0 ] && echo "TRIAL PASSED" || echo "TRIAL FAILED"
echo "home: $PILOT_HOME · artifacts: $WORK"
exit $FAIL
