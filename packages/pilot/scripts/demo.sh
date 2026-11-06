#!/usr/bin/env bash
# End-to-end demo: development event -> queued assessment -> investigation -> finding in the inbox.
#
# Default: PILOT_MODE=offline. Investigations are LABELLED FIXTURES replayed through a fake of the
# Managed Agents session protocol (no Anthropic API calls). Everything else is real: hook command,
# SQLite queue, debounce/batching, snapshotting + secret filtering, bundle packing, the session driver,
# grounding checks, dedupe, stale detection, decisions, budget gates and restart recovery.
#
# Live: PILOT_MODE=live with ANTHROPIC_API_KEY set. The script runs `lookout setup` first and every
# assessment becomes a real Managed Agents session (costs money; bounded by the budgets below).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CP="$ROOT/scripts/pilot"
SIM="node $ROOT/scripts/simulate-claude.mjs"
export PILOT_MODE="${PILOT_MODE:-offline}"
WORK="${DEMO_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/lookout-demo.XXXXXX")}"
REPO="$WORK/orders-service"
export PILOT_HOME="$WORK/home" PILOT_PROFILES="*" PILOT_AUTOSTART=0 PILOT_MIN_RUN_INTERVAL_MIN=0 PILOT_REVIEW_WORK=1
export PILOT_QUIET_MS="${PILOT_QUIET_MS:-1500}" PILOT_PROMPT_QUIET_MS="${PILOT_PROMPT_QUIET_MS:-800}" PILOT_POLL_MS="${PILOT_POLL_MS:-200}"
export PILOT_DAILY_BUDGET_CENTS="${PILOT_DAILY_BUDGET_CENTS:-1500}"

hdr() { printf '\n\033[1;35m=== %s ===\033[0m\n' "$*"; }
note() { printf '\033[2m# %s\033[0m\n' "$*"; }
watch_idle() { "$CP" daemon --until-idle; }

hdr "0. Demo repository (intentional trap: POST /orders is not idempotent) + credential bait"
rm -rf "$REPO"; mkdir -p "$WORK"
cp -R "$ROOT/examples/orders-service" "$REPO"
cd "$REPO"
git init -q -b main && git config user.email demo@example.invalid && git config user.name demo
# Files that must never leave the laptop, and a secret-looking value inside normal code:
printf 'ORDERS_API_TOKEN=FAKE-DEMO-SECRET-0001\n' > .env
printf 'export const ordersApiToken = "FAKEDEMOTOKEN1234567890abcdef";\n' > src/config.js
git add -A -- . ':!.env' && git commit -qm "baseline: orders-service" && note "committed baseline at $(git rev-parse --short HEAD); .env left untracked"
note 'hooks: the Lookout plugin routes events by cwd and file path; here the simulator pipes them into lookout hook'
if [ "$PILOT_MODE" = "live" ]; then "$CP" setup; fi   # creates/updates the Managed Agents environment + agent once
"$CP" doctor

hdr "1. Onboarding: goal + requirements first, proposed approach second (two phases, one session)"
"$CP" onboard \
  --goal "Customers can complete checkout reliably, and each checkout results in exactly one order and one charge." \
  --requirement "R1: checkout must succeed despite transient Orders API failures (timeouts, 5xx)." \
  --requirement "R2: a customer must never be charged twice for one checkout." \
  --constraint "Only the Orders API v2 contract in docs/orders-api.md may be relied on." \
  --approach "Add client-side retries with exponential backoff around the Orders API calls (createOrder and getOrder) so transient timeouts and 5xx errors no longer fail checkout."
watch_idle
note "the uploaded bundle never contains .env or the token value:"
BUNDLE="$(ls -t "$PILOT_HOME"/repos/*/jobs/*/bundle.tgz | head -1)"
tar -tzf "$BUNDLE" | grep -E '(^|/)\.env$' && echo "!! .env leaked" || echo "  .env: not in bundle"
if tar -xzOf "$BUNDLE" 2>/dev/null | grep -q "FAKEDEMOTOKEN1234567890abcdef"; then echo "!! token leaked"; else echo "  token value: redacted"; fi
tar -xzOf "$BUNDLE" repo/src/config.js
"$CP" inbox

hdr "2. Legitimate change: retries for getOrder (read-only, safe) - no warning expected"
$SIM "$REPO" session-start
$SIM "$REPO" prompt 1-legit-get-retry
watch_idle                      # early intent review of the request
$SIM "$REPO" work 1-legit-get-retry --dup
watch_idle                      # burst of edits + test + Stop -> ONE checkpoint
git add -A -- . ':!.env' && git commit -qm "getOrder retries"
"$CP" inbox

hdr "3. Mistaken assumption: retries for order creation"
$SIM "$REPO" prompt 2-unsafe-create-retry
watch_idle                      # raised BEFORE the code exists (dedupes with onboarding finding)
$SIM "$REPO" work 2-unsafe-create-retry
watch_idle                      # confirmed with code + coding-agent claim; ungrounded fixture finding hidden
"$CP" inbox
PROBLEM_ID=order-create-retry-without-idempotency-key   # findings can be addressed by id or fingerprint
"$CP" show "$PROBLEM_ID"

hdr "4. Developer accepts and hands off to the coding agent (lookout never edits the repo)"
"$CP" accept "$PROBLEM_ID" -m "Agreed - must ship with an idempotency key."
"$CP" handoff "$PROBLEM_ID"
git add -A -- . ':!.env' && git commit -qm "createOrder retries (unsafe)"

hdr "5. Fix lands: evidence files change -> findings go stale -> re-checked -> resolved"
$SIM "$REPO" prompt 3-idempotency-fix
watch_idle
$SIM "$REPO" work 3-idempotency-fix
watch_idle
"$CP" inbox --all
git add -A -- . ':!.env' && git commit -qm "idempotency key"

hdr "6. Dismiss a question with a reason; it must not come back unless its evidence changes"
QID=idempotency-key-scoped-to-call-not-checkout
"$CP" dismiss "$QID" -m "Storefront disables the button and calls placeOrder once per checkout; per-call keys are enough."

hdr "7. Session budget: per-run cap of \$0.10 -> platform-style pause (budget_reached), overshoot recorded"
$SIM "$REPO" prompt 4-tests-only
watch_idle
$SIM "$REPO" work 4-tests-only
PILOT_RUN_BUDGET_CENTS=10 "$CP" daemon --until-idle
"$CP" runs | head -3
"$CP" show "$QID" | tail -6

hdr "8. Cumulative budget gate: cap below spend -> run held, events kept; raise cap -> runs"
SPENT="$("$CP" budget | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).spentCents))')"
"$CP" budget set "$((SPENT + 30))" >/dev/null
"$CP" assess -m "manual check after budget change"
watch_idle
"$CP" status
"$CP" budget set 1500 >/dev/null
watch_idle

hdr "9. Restart recovery: kill the watcher mid-investigation, restart, same session resumes"
"$CP" assess -m "recovery demo"
PILOT_FAKE_STEP_MS=600 "$CP" watch & WPID=$!
sleep 2.5; kill -9 "$WPID" 2>/dev/null || true; wait "$WPID" 2>/dev/null || true
note "watcher killed (SIGKILL). Job state on disk:"
"$CP" runs | head -1
"$CP" daemon --until-idle
"$CP" runs | head -1

hdr "10. Pause / resume"
"$CP" pause
"$CP" assess -m "while paused"
watch_idle
"$CP" resume
watch_idle

hdr "Final state"
"$CP" status
"$CP" runs
"$CP" inbox --all
note "demo repo kept at $REPO (state in $PILOT_HOME)"
