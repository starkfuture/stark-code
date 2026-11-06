#!/usr/bin/env bash
# Acceptance trial with REAL model runs (no fixtures) on examples/orders-service. It FAILS when Lookout speaks
# when it should not, or stays quiet when it must speak.
#   PILOT_MODE=local (default): `claude -p` on your Claude Code login (set PILOT_CLAUDE_BIN for a wrapper)
#
# Simulated coding sessions (hook payloads into the real `lookout hook`, routed by cwd/file path as the plugin
# would), real Lookout reviews, real delivery decisions:
#   1. session A makes a legitimate change (retries on read-only getOrder)        -> must stay SILENT
#   2. session B makes the unsafe change (retries on order creation, no key)      -> must SPEAK once, to B only
#   3. session B adds the idempotency key                                          -> reported (finding resolved?)
# Runs in a private PILOT_HOME, so it never touches ~/.lookout. Three review runs + one isolation self-test.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LK="$ROOT/scripts/pilot"
SIM="node $ROOT/scripts/simulate-claude.mjs"
set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a
WORK="${TRIAL_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/lookout-trial.XXXXXX")}"
export PILOT_HOME="$WORK/home" PILOT_PROFILES="*" PILOT_AUTOSTART=0 PILOT_REVIEW_WORK=1
export PILOT_MODE="${PILOT_MODE:-local}" PILOT_QUIET_MS=1500 PILOT_POLL_MS=300 PILOT_MIN_RUN_INTERVAL_MIN=0
REPO="$WORK/orders-service"
FAIL=0
hdr() { printf '\n\033[1;35m=== %s ===\033[0m\n' "$*"; }
check() { if [ "$1" = "$2" ]; then echo "PASS  $3"; else echo "FAIL  $3 (expected $2, got $1)"; FAIL=1; fi; }
commit() { git -C "$REPO" add -A && git -C "$REPO" commit -qm "$1"; }
rewake() { # what the Stop hook would deliver to session $1 right now
  printf '{"session_id":"%s","cwd":"%s","hook_event_name":"Stop"}' "$1" "$REPO" | PILOT_DELIVER_WAIT_SEC=60 "$LK" deliver --rewake 2>"$WORK/said-$1-$2.txt"
  echo $?
}

rm -rf "$REPO"; mkdir -p "$WORK"; cp -R "$ROOT/examples/orders-service" "$REPO"
git -C "$REPO" init -q -b main && git -C "$REPO" config user.email trial@example.invalid && git -C "$REPO" config user.name trial
commit "baseline"

if [ "$PILOT_MODE" = "local" ]; then
  hdr "0. Isolation self-test (real claude -p run; canaries; fail-closed)"
  "$LK" selftest || { echo "ABORT: local isolation could not be verified"; exit 4; }
fi

run_step() { # session step
  hdr "Session $1: $2"
  SIM_SESSION="$1" $SIM "$REPO" prompt "$2" >/dev/null
  SIM_SESSION="$1" $SIM "$REPO" work "$2"
  "$LK" daemon --until-idle
}

run_step sess-A 1-legit-get-retry
check "$(rewake sess-A 1)" 0 "legitimate change: Lookout stays silent"
commit "1-legit-get-retry"

run_step sess-B 2-unsafe-create-retry
check "$(rewake sess-A 2)" 0 "unsafe change: nothing is said to session A, which did not make it"
code=$(rewake sess-B 2)
check "$code" 2 "unsafe change: Lookout speaks to session B"
if grep -qiE "idempot|twice|duplicate|second order" "$WORK/said-sess-B-2.txt"; then echo "PASS  the message is about the duplicate order/charge"; else echo "FAIL  the message is not about the duplicate order"; FAIL=1; fi
check "$(rewake sess-B 2b)" 0 "it says it once"
commit "2-unsafe-create-retry"

run_step sess-B 3-idempotency-fix
code=$(rewake sess-B 3)
echo "INFO  after the fix, rewake exit $code (2 = it spoke; see $WORK/said-sess-B-3.txt)"
commit "3-idempotency-fix"

hdr "What Lookout said"
for f in "$WORK"/said-*.txt; do [ -s "$f" ] && { echo "--- $(basename "$f")"; cat "$f"; }; done
hdr "Inbox (including what it kept quiet about, and why)"
"$LK" inbox --all --repo "$REPO"
hdr "Runs and cost"
"$LK" runs --repo "$REPO"
"$LK" status --repo "$REPO"
echo
[ "$FAIL" = 0 ] && echo "TRIAL PASSED" || echo "TRIAL FAILED"
echo "artifacts: $WORK"
exit $FAIL
