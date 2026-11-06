> **Superseded** by [prompt-watch.md](prompt-watch.md) (2026-11-06): Pilot (was Lookout) now watches the person's prompts and talks in a chat. Reviewing finished work is optional (`review_work`, off by default). This document describes the earlier design and is kept for its history.

# Redesign v2: quiet by default, watches every local session

Status: **implemented 2026-11-05 as Lookout**, with the owner's changes: it watches only the `claude` profile by default (configurable via `profiles`), and it speaks when the evidence is concrete AND the finding is risky, outside the session's context, or something the session doesn't know about and caused itself (see README "When Lookout speaks"). Delivery default is `session`, not `inbox`. Distribution is a Claude Code plugin. The pre- and post-implementation Codex reviews stayed in the original dev-copilot repository. Sources:
- Codex review (`gpt-6.1-sol`, xhigh effort), kept in the original dev-copilot repository.
- Web research, linked at the bottom.
- The real runs on 2026-11-05.

## What the real runs showed

- **It finds real things.** Trial on `examples/orders-service`:
  - It flagged the double charge before any code existed, reproduced it on the unsafe change (3 POSTs, 3 orders) and resolved it after the fix.
  - It also found 2 real issues that weren't planted: a 5 s timeout against the documented 10 s latency, and an idempotency key generated per call.
- **It also delivers.** A real Claude Code session was woken by the `asyncRewake` hook. The coding agent relayed the 3 findings and changed no code, as the message asked.
- **On real PRs** (#1672, #1653, #630):
  - It found the one code-visible fleet finding on #1672, but filed it as an "optional improvement".
  - It found 2 verified errors in the fleet's own fix, #630.
  - It found none of the 3 issues already recorded on #1653, and raised 2 new questions there.
  - No false positives were confirmed.
- **But it talks too much.** Every one of the 4 trial runs returned `intervention_needed: true`, including the legitimate change. On that change it raised a new "problem" (dropped sockets) that was true but not worth an interruption. The delivery check pushed that same minor point as a "confirmed problem".

## Principles (from the research)

1. **Silence is a chosen action, and the default.** Log what was withheld so silence can be measured. (Agentic Coding Needs Proactivity.)
2. **Speak at task boundaries,** such as the end of a turn or after tests, never during idle "deep thought". Space interruptions out, and back off after one is ignored. (CHI '25, "Assistance or Disruption?")
3. **Precision over recall.** Tools with low false-positive counts are the ones teams keep. Tune for actionable comments and learn from dismissals by category. (AI review tool comparisons.)
4. **The application decides delivery, not the model.** The model reports evidence; code applies the thresholds. (Codex B/A5.)

## Changes

### 1. Prompt and schema

Rewrites are in the Codex review, section A.
- **Remit:** only material failures that the current request or change *introduced*, *amplified* or *made imminent*. No opportunity hunting at checkpoints.
- **Schema:**
  - **Replace** `kind` with `issue_type` (`defect` | `decision` | `suggestion`) plus `severity` (`critical` | `high` | `medium` | `low`).
  - **Add** `attribution` (`introduced` | `amplified` | `pre_existing` | `proposed`), `proof` (`reproduced` | `source_proven` | `unconfirmed`), `failure_case` and `controls_checked`.
  - **Remove** the model-owned `intervention_needed` field.
- **Requirements:** explicit constraints in developer prompts count as requirements again. The model's own guesses at requirements are hypotheses.
- **Evidence:** a matching quote proves text exists, not that a defect exists. Every decisive evidence item must verify.

### 2. Interruption policy (`src/deliver.ts`)

| Outcome | When | How |
|---|---|---|
| Interrupt now | Critical or high severity, reproduced or proven reachable, about to be committed or shipped | One short message to the session that caused it |
| Next boundary | Confirmed high severity, relevant to current work, not already being addressed | At the next Stop or prompt; no wake-up |
| Digest | Medium severity with a concrete action | Inbox, plus an optional daily digest of at most 3 items |
| Silent | Legitimate work, suggestions, speculation, duplicates, accepted risks | Recorded only |

Further rules:
- **Default delivery:** `inbox` until the trial below passes. `asyncRewake` is used only for the "interrupt now" row.
- **Rate limits:** at most 1 ordinary interruption per project per 30 minutes and 1 per turn. Critical findings bypass the limit.
- **Routing:** a finding goes only to the session whose work produced it. Today the first hook to claim it wins, whichever session that is.
- **Learning from decisions:** dismissals carry a reason (`incorrect`, `out_of_scope`, `already_addressing`, `accepted_risk`). Repeated dismissals in a category demote it to the digest; they never switch off security checks.

### 3. Watching every local session

- **Install user-level capture hooks** in `~/.claude/settings.json` and in the second profile's `$CLAUDE_CONFIG_DIR/settings.json`, merging with any existing hooks. Each Claude Code profile is registered explicitly.
- **Run one machine-wide daemon** that owns scheduling, budgets, concurrency and delivery. State moves from `<repo>/.copilot` to private user storage.
- **Reconcile against transcripts** (`<config>/projects/*/*.jsonl`) to recover what hooks missed. Use the Agent SDK readers where possible, and keep JSONL parsing behind a versioned adapter, since the format is internal.
- **Identity per event:** profile, session, prompt and agent IDs, cwd, worktree, common git dir, HEAD and snapshot hash. Don't decode project-directory names.
- **Exclusions:** per profile and per project. The investigator's own sessions are excluded by recorded ID.
- **Costs:** one global budget, one investigator at a time, fairness across projects. Identical snapshots are merged, and history is never replayed after a restart.

### 4. Cuts

- **Optional by default:** onboarding, routine "improvement" hunting and automatic deep escalation.
- **Paused:** further hosted Managed Agents work, until the local mode is quiet and useful.
- **Diffs:** checkpoints review what changed since the last assessed snapshot, not the whole diff against HEAD.

### 5. Acceptance: the trial must fail on unwanted speech

- **Legitimate changes:** no delivered message. Target: silence on at least 95% of legitimate changes.
- **Planted double charge:** still delivered, once, to the right session.
- **New cases:** a minor true gap (must go to the digest, not interrupt), a stale result, and two sessions at once (correct routing).
- **Metrics to track:** interruption precision, interruptions per developer-hour and warning latency.

## Name

The current working name is "dev-copilot". Candidates: **Lookout** (Codex's pick and mine: it watches quietly and warns when it matters), Scout, Lens, Margin, Beacon.

## Existing tools to compare against

- **Claude Code `/code-review`:** local review of the branch and uncommitted changes in a separate context.
- **CodeRabbit CLI:** local-change review with coding-agent integration.
- **agent-watch:** rule-based flags on transcripts, after the fact.
- **Claude Code agent view** (`claude agents --json`): session state for background sessions only.

None of these does quiet, machine-wide, prompt-aware oversight. That is still the hypothesis this prototype tests.

## Sources

- [Assistance or Disruption? (CHI '25)](https://arxiv.org/html/2502.18658v4)
- [Agentic Coding Needs Proactivity, Not Just Autonomy](https://arxiv.org/html/2605.06717v1)
- [Developer Interaction Patterns with Proactive AI: five-day field study](https://dl.acm.org/doi/10.1145/3742413.3789148)
- [Signal65: Evaluating AI Code Review Tools](https://signal65.com/wp-content/uploads/2026/03/Signal65-Insights_Evaluating-AI-Code-Review-Tools.pdf)
- [agent-watch](https://github.com/ADWilkinson/agent-watch)
- [Claude Code agent view](https://code.claude.com/docs/en/agent-view)
- [Claude Code channels](https://code.claude.com/docs/en/channels)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [OpenRouter: automatic code review with a Stop hook](https://openrouter.ai/docs/cookbook/coding-agents/automatic-code-review)
