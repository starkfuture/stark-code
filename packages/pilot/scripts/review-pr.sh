#!/usr/bin/env bash
# Run lookout (local mode by default) on a GitHub PR as if its change were the developer's uncommitted work.
# Used to compare the lookout's independent findings with other reviews of the same PR.
#
#   scripts/review-pr.sh <local-clone> <owner/repo> <pr-number> <out-dir> [goal-file]
#
# - Creates a detached worktree of the clone at the PR's base, applies the PR diff as UNCOMMITTED changes
#   (the clone's own working tree is never touched).
# - Feeds the PR title/body in as the developer's request (a prompt to evaluate, not to trust) and a Stop
#   event, then runs one checkpoint assessment and prints the inbox. Findings stay in <out-dir>/home (private PILOT_HOME).
set -euo pipefail
CLONE="$1"; SLUG="$2"; PR="$3"; OUT="$4"; GOAL_FILE="${5:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CP="$ROOT/scripts/pilot"
set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a
export PILOT_MODE="${PILOT_MODE:-local}" PILOT_PROMPT_REVIEW=merge PILOT_QUIET_MS=1500 PILOT_POLL_MS=300 PILOT_REVIEW_WORK=1

mkdir -p "$OUT"
gh pr view "$PR" -R "$SLUG" --json number,title,body,baseRefName,headRefOid,url > "$OUT/pr.json"
BASE=$(node -e 'console.log(require(process.argv[1]).baseRefName)' "$OUT/pr.json")
HEAD=$(node -e 'console.log(require(process.argv[1]).headRefOid)' "$OUT/pr.json")
git -C "$CLONE" fetch -q origin "$BASE" "pull/$PR/head"
WT="$OUT/repo"
[ -e "$WT" ] && git -C "$CLONE" worktree remove --force "$WT" 2>/dev/null || true
# Apply at the merge-base: the PR's diff is against it, and the base branch may have moved on (conflicting PRs).
MB=$(git -C "$CLONE" merge-base "origin/$BASE" "$HEAD")
git -C "$CLONE" worktree add -q --detach "$WT" "$MB"
git -C "$CLONE" diff "$MB" "$HEAD" > "$OUT/pr.diff"
git -C "$WT" apply --whitespace=nowarn "$OUT/pr.diff"
echo "PR $SLUG#$PR applied as uncommitted work on its merge-base with origin/$BASE ($(git -C "$CLONE" rev-parse --short "$MB")): $(git -C "$WT" status --porcelain | wc -l | tr -d ' ') changed paths"

export PILOT_HOME="$OUT/home" PILOT_AUTOSTART=0 PILOT_MIN_RUN_INTERVAL_MIN=0
GOAL="Phase 1 of the env config overhaul: stop secrets leaking through config and CI, read frontend secrets at runtime, let backend receivers accept two service-to-service tokens, then rotate the leaked keys - without breaking production or the sandbox fleet."
[ -n "$GOAL_FILE" ] && GOAL="$(cat "$GOAL_FILE")"
"$CP" onboard --repo "$WT" --no-assess --goal "$GOAL" \
  --constraint "No secret values in images, build logs, CI from untrusted branches, or committed files." \
  --constraint "Production changes roll out in the order recorded by the team; every step must be reversible."

REQ=$(node -e 'const p=require(process.argv[1]); console.log(`PR #${p.number}: ${p.title}\n\n${(p.body||"").slice(0,6000)}`)' "$OUT/pr.json")
emit() { printf '%s' "$1" | PILOT_HOOK_VERBOSE=1 "$CP" hook --repo "$WT"; }
emit "$(node -e 'console.log(JSON.stringify({hook_event_name:"UserPromptSubmit",session_id:"pr-review",prompt_id:"pr-"+process.argv[2],cwd:process.argv[3],prompt:process.argv[1]}))' "$REQ" "$PR" "$WT")"
"$CP" assess --repo "$WT"   # the PR is the change to review; the prompt above is its request
"$CP" watch --until-idle --repo "$WT"
"$CP" runs --repo "$WT" | head -3
"$CP" inbox --all --repo "$WT"
