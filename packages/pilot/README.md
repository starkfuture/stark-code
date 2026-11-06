# Pilot

Pilot (it was called Lookout) watches what **you** ask your Claude Code sessions and tells **you**, in a chat, when you are about to forget something. It always quotes the thing you are forgetting, and it stays silent otherwise.

It thinks with **Claude** (default) or **Codex**, your choice.

Each message is one of five kinds:

| Kind | Shown as | When | Example |
|---|---|---|---|
| `rule` | Your rule | The prompt goes against, or skips, a rule you wrote in a `CLAUDE.md` or a memory file. | "looks good, merge it" while your `CLAUDE.md` says "Never merge a PR unless the user writes 'merge #<n>'". |
| `earlier` | You said earlier | Something you said earlier, in this session or another one in the last 48 h, that this prompt drops or contradicts. | You told session A "keep the /v1 endpoints until the mobile app 4.2 ships", then tell session B "delete all the /v1 endpoints". |
| `pending` | Waiting on you | Something waiting on you that this prompt moves past. | Session C ended its turn with "Should I use kciam or the w02283 sandbox?", and you started other work in D. |
| `missing` | Missing detail | The prompt lacks a detail the session will likely guess wrong, and the answer is in what you wrote. | "deploy it to the sandbox" after using two sandboxes today. |
| `risky` | Hard to undo | The prompt starts something hard to undo (prod, merge, delete, send, money), and a relevant fact is not in it. | — |

Pilot does not comment on style, give general advice or praise, repeat your prompt back, or raise anything it cannot quote exactly.

The full design is [docs/prompt-watch.md](docs/prompt-watch.md).

This package is Pilot's home in Stark Code. It was copied from the `dev-copilot` repository at commit `468af36` (2026-11-06); that repository's review notes and local files were not copied. Since then, the only code change is that live mode loads its SDK at run time (see "Development").

## Install

You need Claude Code 2.1.275+, Node ≥ 22.18 and git. Codex CLI is optional.

**From Stark Code (the usual way).** Open the Pilot panel (the eye in the chat's top bar) and press **Install**. The panel first says what it will change. Stark Code then:
1. copies the Pilot it ships to `~/.pilot/plugin/<version>/`, a folder nothing edits afterwards;
2. removes Lookout, and any Pilot that Claude Code reads from another folder such as a checkout, so only one set of hooks runs;
3. runs `claude plugin install pilot --marketplace ~/.pilot/plugin/<version> --scope user`;
4. asks a running daemon to stop, so the next Claude Code session starts the new copy.

A newer Stark Code offers **Update** the same way. The installed copy has no `.env`: settings such as `claude_bin` and `mode` belong in `~/.pilot/config.json`. If the Pilot being replaced reads settings from its folder's `.env`, the panel names them and installs only after they are in `config.json`.

**From a checkout (development):**

```bash
scripts/pilot install                           # into ~/.claude, hooks read this folder
scripts/pilot install --profile ~/.claude-work  # another profile
```

That is the whole setup. The plugin's hooks run in every session of that profile, with nothing to configure per repository. The first session:
- starts Pilot's background daemon;
- writes a launcher to `~/.pilot/bin/pilot`. Add that folder to your `PATH`, or use the slash commands `/pilot:chat`, `/pilot:ask`, `/pilot:status`, `/pilot:pause` and `/pilot:resume`.

The first prompt check runs a one-time isolation self-test. It takes about a minute and uses Sonnet.

**Coming from Lookout:** on its first start, Pilot copies `~/.lookout` to `~/.pilot`. Databases are copied through SQLite. Review snapshots, job files and the old launcher are left out, and the daemon locks are cleared in the copy. `~/.lookout` is never moved or deleted. Other old names keep working:
- `LOOKOUT_*` variables are read when the `PILOT_*` name is unset;
- `scripts/lookout` runs `scripts/pilot`;
- the Agent Engine key is read from the old Keychain item until a new one is stored.

## Using it

Most people use the Pilot panel in Stark Code. From a terminal:

```bash
pilot chat                                  # the thread: nudges, your questions, Pilot's answers
pilot ask "what's waiting on me?"           # ask about your own sessions
pilot ask --engine codex "what did I ask in the keycloak session yesterday?"
pilot pause | resume                        # stop/start checking prompts (they are still recorded)
pilot status | doctor | config
```

### How a prompt is checked

All of this happens in the daemon (`src/promptWatch.ts`), never in a hook. Hooks only record what happens and return in milliseconds.

1. **Trigger.** Each prompt you type triggers a check.
   - Prompts from subagents, task notifications and subagent hand-backs are context only.
   - Pilot waits until the session has been quiet for 8 s, so quick follow-ups merge into one check. A finished turn between two prompts keeps them apart.
2. **Skip.** These are skipped without a model run:
   - Prompts under 15 characters ("yes", "go"), unless they approve something risky the session just proposed (its last message mentions merge, prod, deploy, delete, send, publish or push).
   - A session Pilot spoke to in the last 10 minutes, unless the prompt starts something risky.
   - Everything while Pilot is paused.
3. **Context.** Code builds it, capped at 16k characters (usually 9-12k), newest first and trimmed per section (`src/promptContext.ts`):
   - the new prompt;
   - the session's earlier prompts and its last end-of-turn message;
   - the 15 prompts from your other sessions (last 48 h) closest to the new one;
   - the lines of your written rules that may apply: they share word stems with the prompt, or they are rules about something hard to undo. These come from:
     - the profile's `CLAUDE.md`;
     - each `CLAUDE.md`, `CLAUDE.local.md` and `.claude/CLAUDE.md` from the top folder down to the session's folder;
     - the project's `MEMORY.md`, and up to 2 memory files that share words with the prompt;
   - open items: questions other sessions asked you that got no answer, and nudges you never saw (30 min or older).
4. **One model run.** It has no tools and a 90 s limit, and returns at most one nudge.
5. **Code decides, not the model:**
   - Every quote must match its source exactly. Only case, spacing, quote marks and markdown `*`/`` ` `` are ignored. A quote that does not match drops the whole nudge.
   - At least one quote must be something other than the new prompt.
   - Confidence must be ≥ `nudge_min_confidence` (0.7). After you mark three nudges of one kind "Not useful", that kind needs 0.85.
   - A nudge is never repeated (same kind and same quotes). A reminder of the same waiting question counts as a repeat, and so does the same rule line told to the same session within a day.
   - At most one nudge per session per 10 minutes, except `risky`.
   - **Sentence check.** A nudge gets a second, small run of the same engine. It sees the new prompt and the checked quotes, with the rest of each quoted rule's section. It marks each sentence supported or not. Unsupported sentences are removed, such as an added time or a claim about what you said that the new prompt takes back. A nudge with nothing supported left, or whose check cannot run, is dropped.
6. **Delivery.** Every nudge goes into the chat.
   - It also goes into its session on its own (`nudge_to_session: "all"`, the default), as plain text for Claude, for example: `Pilot (the user's assistant) noticed: The user's CLAUDE.md rule says … Quote: "…" (~/…/CLAUDE.md:7). Check with the user before acting on it.`
   - **Mid-turn.** A check finishes 10-20 s after the prompt, while the session is already working on it. So the nudge goes in at the session's next tool call:
     - **PreToolUse (Bash).** It lands before a command such as `gh pr merge` runs.
     - **PostToolUse (every tool).** It lands after any other tool call.
     - Both hooks first test for `~/.pilot/outbox-pending` in the shell and start Node only when something is queued. Then they make one indexed registry read and return the text as `hookSpecificOutput.additionalContext`.
     - Claude Code 2.1.319 accepts `additionalContext` from both events.
   - **Fallbacks.** If the turn makes no more tool calls, the nudge goes in at the next prompt (`deliver --context`). If the turn ends first, the Stop hook waits for the turn's check (at most 2 minutes) and wakes the session with it (`deliver --rewake`, exit 2).
   - Any nudge can be sent to its session from the chat ("Send to session").
   - Dropped and held nudges are recorded in `pilot api activity`, never shown.

Each check is cheap. On the owner's real prompts, a cold-cache Sonnet check costs about $0.02, or $0.03 when it nudges, plus about $0.008 for the sentence check. Before the context was trimmed it was about $0.06. In the acceptance trial, with small rule files, a check cost about $0.01 and took about 4 s.

### Choosing Claude or Codex

| | Claude (default) | Codex |
|---|---|---|
| Runs | `claude -p` through the isolated runner: an empty private work dir, `--safe-mode`, `--setting-sources local`, no MCP, a minimal environment, no tools | `codex exec -m gpt-6.1-sol -s read-only --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check` in an empty private work dir, with the prompt on stdin, `--output-schema` and `-o` for the answer |
| Paid by | your Claude plan; counted against `daily_budget_cents` as an API-equivalent estimate | your Codex plan; capped at `codex_daily_runs` (40) per rolling 24 h |
| Self-test | required (isolation is checked with a real run) | not applicable |

- **Setting.** `engine` sets the default. The chat can send one question to the other engine (`--engine`).
- **Fallback.** With `engine_fallback` (default on), a run whose engine cannot run uses the other one for that run, and the message says so. "Cannot run" means not installed, signed out, at its usage limit, Claude's self-test missing, or Claude's budget used up. When Codex's daily runs are used up, Claude answers, whatever the fallback setting.
- **Never a login.** Pilot never starts a login for either engine.
- **Privacy.** With Codex, the same context (your prompts, your rules, your sessions' messages) goes to OpenAI.

## Configuration

Settings live in `~/.pilot/config.json`. Each key can also be set as an environment variable `PILOT_<KEY>` (or the older `LOOKOUT_<KEY>`), which wins over the file. `pilot config` prints the effective values.

```json
{
  "profiles": ["~/.claude"],
  "engine": "claude",
  "claude_bin": "claude",
  "nudge_to_session": "all",
  "daily_budget_cents": 1000
}
```

| Key | Default | Meaning |
|---|---|---|
| `profiles` | `["~/.claude"]` | Claude Code profiles to watch (`CLAUDE_CONFIG_DIR` values). `"*"` watches every profile the plugin is installed in. `pilot install --profile` adds one. |
| `exclude` | none | Folders whose repositories are never watched. |
| `engine` | `claude` | What Pilot thinks with for prompt checks and answers: `claude` or `codex`. `pilot api settings --engine` sets it. |
| `engine_fallback` | `true` | Use the other engine for a run when the chosen one cannot run, and say so. |
| `claude_bin` | `claude` | The Claude Code binary, for example a wrapper for another account. |
| `prompt_check_model` | `sonnet` | Claude model for checks and answers. Haiku is never used: a Haiku setting falls back to Sonnet. |
| `prompt_check_effort` | `low` | Claude effort for checks and answers. It also sets Codex's reasoning effort. |
| `prompt_check_timeout_sec`, `ask_timeout_sec` | 90, 60 | Time limits for a check and for an answer. |
| `prompt_check_budget_cents` | 30 | Cap for one Claude check or answer. |
| `prompt_quiet_ms` | 8000 | How long a session must be quiet before its new prompts are checked. |
| `codex_bin`, `codex_model` | `codex`, `gpt-6.1-sol` | The Codex CLI and model. |
| `codex_daily_runs` | 40 | Codex runs per rolling 24 h (checks and answers). |
| `nudge_min_confidence` | 0.7 | Below this a nudge is not shown. |
| `nudge_to_session` | `all` | Which nudges also go into their session on their own: `all` (every nudge that passed the checks), `risky` (rule and risky nudges with confidence ≥ 0.8), or `off` (only when you press "Send to session"). |
| `delivery` | `session` | `inbox` keeps Pilot out of sessions entirely; nudges then stay in the chat until you send them. |
| `daily_budget_cents` | 1000 | Rolling 24-hour cap on Claude runs (checks, answers and reviews), as an API-equivalent estimate. |
| `autostart`, `daemon_idle_exit_min` | `true`, 120 | Whether sessions start the daemon, and how long it lingers when idle. |
| `review_work` | `false` | The old job: review each finished turn's code change in an isolated copy (see "Reviewing finished work" below). When off, edits, tests and stops are still recorded as context, but no review is scheduled and nothing is spent on one. |
| `engine_url`, `engine_poll_min`, `engine_repos` | see below | Agent Engine (production monitoring); unrelated to `engine`. |

The review settings (`model`, `quick_effort`, `run_budget_cents`, `min_run_interval_min`, `speak_*`, `snapshot_*`, `prompt_review`) apply only when `review_work` is on.

## JSON API (for apps)

Desktop apps such as Stark Code read and control Pilot through one command (api version 1, `src/api.ts`):

```bash
$PILOT_HOME/bin/pilot api <method> [flags]   # PILOT_HOME defaults to ~/.pilot
```

- **Invocation:** call the stable launcher with `execFile` (no shell). Flags can be written `--name=value`, and a value may contain newlines or start with `-`.
- **Output:** stdout is exactly one JSON object and nothing else, with no colours or warnings. Every response has `"api": 1`.
- **Errors:** exit 1 with `{"api":1,"error":"<message>"}`, in plain English. That covers an unknown method, a flag the method does not take, and a missing value.

### Chat

| Method | Returns |
|---|---|
| `chat [--since <id>] [--limit N]` | `messages[]` and `unread`. It returns the newest `N` messages (default 50; 200 with `--since`; max 1000), only those with an id above `--since` when given, oldest first. |
| `ask --text "<≤4000 chars>" [--engine claude\|codex]` | `{question, answer}`. It waits up to `ask_timeout_sec` (60 s). On a timeout or failure, the question stays in the thread, a `note` says why, and the reply is an error. `--engine` sends this one question to that engine. On SIGTERM the engine's process is stopped, no answer or note is stored, the question stays, and the reply is `{"error":"Cancelled."}`. |
| `nudge --id <id> --action send\|seen\|dismiss\|useful\|not_useful` | `{ok: true, message}`. `send` queues the nudge for its session's next turn; when that session has ended, the error is "session ended". |
| `nudge --all --action seen` | `{ok: true, message: null, updated: n}` |
| `settings [--engine claude\|codex]` | `{engine, engines: {claude: {available, note}, codex: {available, note, runsLeftToday}}}`. With `--engine` it sets the default first. `note` is plain English, for example "Not signed in to Codex" or "Daily Codex limit reached". Binary and sign-in checks are cached for 5 minutes. |

A **Message** looks like this:

```
{
  "id": n, "at": ISO, "role": "you" | "pilot", "kind": "nudge" | "answer" | "message" | "note",
  "nudgeKind": "rule" | "earlier" | "pending" | "missing" | "risky" | null,
  "text": string,
  "evidence": [{"source": "rule" | "memory" | "prompt" | "session" | "nudge", "where": string, "quote": string, "found": bool}],
  "session": string | null, "sessionLabel": string | null,   // label = repo name + " · " + first prompt (≤ 40 chars)
  "repo": string | null,
  "state": "new" | "seen" | "sent" | "dismissed" | "useful" | "not_useful",
  "engine": "claude" | "codex" | null                        // null for your own messages
}
```

- **`where`:** `path:line` for files (home folder shown as `~`). For prompts, session messages and nudges it is `"<session label> · <ISO time>"`.
- **`quote`:** the checked text as people read it. Markdown emphasis (`**`, `__`), backticks, heading marks and leading list or quote markers are removed. They are removed only after the exact stored text passed its check.
- **`sessionLabel`:** the repository plus the first prompt with readable text: paste markup (`<pasted_content …>`), other tags and system reminders are removed. If no prompt has readable text, it is "untitled".
- **`found`:** always true on nudges, because a nudge with a quote that does not match is never shown. On answers, a quote that does not match is kept with `found: false`.
- **Read state:** a nudge is unread until it is marked `seen`, `useful`, `not_useful`, `dismissed` or sent by you. A nudge Pilot sent to its session on its own is `sent`, and stays unread until you see it.

### Status, activity and the rest

| Method | Returns |
|---|---|
| `status` | `generatedAt`, `daemon {running, pid, heartbeatAt}`, `paused`, `profiles`, `home`, `mode`, `claudeBin`, `delivery`, `selftest {ok, reason}`, `budget {windowHours, capCents, spentCents, availableCents}` (prompt checks and answers included), `unread` (always present), `sessions` (active in the last 6 h), `reviewWork`, `engine`, and `repos[]`. |
| `activity [--repo r] [--limit n]` | `events[]` and `runs[]`, newest first. `runs[]` includes prompt checks (`kind` `prompt-check`) and answers (`chat-answer`): `status` is `nudge`, `silent`, `dropped`, `held`, `skipped`, `failed`, `done` or `cancelled`, and `summary` says why in plain words. |
| `findings [--repo r] [--all]`, `decide --ref <repo#id> --action …`, `production [--limit n]`, `pause \| resume [--repo r]` | As before; see "Reviewing finished work" and "Agent Engine" below. |

**Privacy:**
- `chat` returns quotes of your own prompts, rules and sessions' messages. It is a local interface for your own apps. Every text and quote is redacted for secrets (keys, tokens, passwords, credential URLs) before it is stored, and `chat` never returns tokens or secrets.
- `activity` never returns prompt text, quotes, agent messages, commands, test output or file contents.

## What Pilot stores

Everything is in `~/.pilot` (0700):
- **`registry.db`:**
  - your prompts (72 h) and each session's first prompt;
  - each session's last five end-of-turn messages (redacted, capped at 4k characters; from the Stop hook's `last_assistant_message`, else the transcript's tail);
  - when each session ended;
  - the chat thread (`chat_messages`) and prompt-check and answer runs (`watch_runs`);
  - the review registry.
- **`repos/<key>/`:** the review state per working tree.
- **`selftest.json`, `daemon.log`, `bin/pilot`.**

Nothing is shared between people. What leaves the machine is the context of each check or answer, sent to Claude, or to OpenAI with Codex.

## Reviewing finished work (optional, `review_work`)

With `review_work: true`, Pilot also does its old job. When a session finishes a turn that changed code, it reviews the change in an isolated copy of the repository against what you asked for, and speaks into the session only with concrete evidence and a reason (`src/policy.ts`). The design is in [docs/redesign-v2.md](docs/redesign-v2.md) (superseded as the main job, still how reviews work).

- **No automatic retries of timeouts:** a batch whose review timed out is not retried automatically. A later automatic job for the same working tree is skipped; `pilot assess` retries it on purpose.
- **Explicit reviews:** `pilot assess` and `pilot onboard` run even with `review_work` off, and get the recorded prompts, claims and test runs.

```bash
pilot inbox | show <ref> | accept|dismiss|defer <ref> -m "<reason>" | handoff <ref>
pilot assess [--deep] [--repo r]
```

## Agent Engine (production monitoring)

Pilot can read the [Agent Engine](https://agent-engine.starkfuture.com) findings feed: the critical and major production issues the engine reports. If a session is changing a repository that one of those issues affects, the session hears about it once.

- **The key:** it is an engine API key (`findings:read`). It is stored only in the macOS Keychain (service `pilot-agent-engine`; the older `lookout-agent-engine` item is read when the new one is missing), written through the `security` CLI's stdin. It is never in argv, `config.json`, the registry, logs or output.
- **What is read:** `GET /api/v1/findings` (read-only), polled every `engine_poll_min` minutes while the daemon runs. Lookback is at most 48 h.
- **Mapping:** `engine_repos` maps a service, or `owner/name`, to a local path. Without it, Pilot matches issues against the git remotes of watched repositories.

```bash
pilot engine connect [--url <u>]   # paste the key at the hidden prompt (or pipe it in)
pilot engine status | disconnect
```

## How it works

```
any Claude Code session (watched profile)
  └─ plugin hooks (async; Stop sync) ─► pilot hook ─► ~/.pilot/registry.db (prompts, end-of-turn messages, sessions)
                                                 └─► ~/.pilot/repos/<repo>/lookout.db (edits, tests, stops: context)
  └─ PreToolUse (Bash) / PostToolUse ─► pilot deliver --tool ─► a queued nudge, mid-turn, once (only while ~/.pilot/outbox-pending exists)
  └─ UserPromptSubmit ─► pilot deliver --context ─► the same, at the next prompt
  └─ Stop ─► pilot deliver --rewake ─► waits for the turn's check, wakes the session with its nudge
pilot daemon (one per machine, started by the first session)
  ├─ prompt watch: debounce → skip rules → context (≤ 40k chars) → Claude or Codex, no tools → code checks the
  │  quotes, dedupe and spacing → chat message (+ session's next turn for rule/risky ≥ 0.8)
  ├─ review_work (off by default): checkpoint reviews of changed code
  └─ Agent Engine poll (when connected)
pilot api …  (Stark Code) ─► chat, ask, nudge, settings, status, activity
```

## Verification

| Area | How | Result |
|---|---|---|
| Unit tests | `npm test` (no network, fake `claude` and `codex` binaries):<br>• prompt-watch trigger, debounce and skip rules<br>• context caps<br>• quote checking<br>• dedupe and spacing<br>• delivery routing<br>• chat storage and redaction<br>• hooks<br>• API shapes, settings and engines<br>• fallback and the Codex cap<br>• cancel<br>• the `~/.lookout` migration and old names<br>• review_work, timed-out batches<br>• the earlier review, engine and API suites | `npm test`, `npm run typecheck` |
| Prompt watch, real model | `npm run trial-nudges` (`scripts/trial-nudges.sh`): the spec's acceptance scenarios with real Sonnet runs in a private home, plus one question through Codex (`gpt-6.1-sol`) | 2026-11-06, third run: **passed**, 11/11 (silent ×5, `rule`, `earlier`, `pending`, the Claude answer and the Codex answer each with found quotes); $0.16 for 12 Sonnet checks and 1 answer, plus 1 Codex run. Earlier runs: run 1 missed `pending` (prompt wording fixed); run 2 had one Claude answer time out at 60 s (a re-ask took 11.5 s) and resurfaced the same waiting question twice (dedupe fixed) |
| Real prompts, read-only | `scripts/nudge-dryrun.ts` over a copy of the registry: no delivery, nothing stored | 2026-11-06, the owner's last 24 h: 37 prompts, 36 checks (1 skipped), 3 nudges (2 `rule`, 1 `risky`), $1.99. One `rule` nudge was the same rule repeated to the same session for a resubmitted prompt; that is now a repeat. The report is kept outside the repository because it quotes prompts. |
| Local isolation, real | `pilot selftest`: a real `claude -p` run with canaries | required before Claude checks |

## Development

```bash
vp run --filter @starkfuture/pilot test        # node --test, no network
vp run --filter @starkfuture/pilot typecheck
vp run --filter @starkfuture/pilot trial-nudges  # prompt watch with real model runs (private PILOT_HOME)
claude --plugin-dir packages/pilot             # try the plugin in one session without installing it
```

- **What ships.** Stark Code copies only the files `package.json` lists (`files`), with no `node_modules`. Everything those files run imports Node built-ins only; `test/package.test.ts` checks that.
- **Live mode** (hosted Managed Agents, `mode: "live"`) is the one exception: it needs `@anthropic-ai/sdk` 1.4, which this package does not install, because adding it would change the version the Stark Code server resolves. `src/cli.ts` loads it at run time and says so plainly when it is missing; the package typecheck leaves `src/investigator/managed.ts` out.
- **Versions.** Change `version` in `package.json` and `.claude-plugin/plugin.json` together whenever what ships changes. Stark Code offers an update only for a newer version.
- **Style.** The repository's formatter, linter and Vitest skip this package; it keeps the plain-Node style it ships as.

## Limitations

- **Hooks are the only input.** Pilot sees prompts and end-of-turn messages through hooks, so sessions with hooks disabled are invisible. Prompts typed while the daemon was down for more than 10 minutes are not checked.
- **A nudge needs a moment to arrive.** It reaches the session at its next tool call after the check finishes (10-20 s after the prompt). A Bash call that started before that runs without it.
- **"Session ended" needs the `SessionEnd` hook,** which arrives with this version of the plugin.
- **The context is a digest.** Sessions' full transcripts are not read; quotes come only from what the context holds.
- **One Claude account runs all Claude checks** (`claude_bin`). The daemon doesn't borrow the watched profiles' logins.
