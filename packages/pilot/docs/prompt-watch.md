# Pilot (was Lookout) v3: watch the person, talk in a chat

Status: approved direction from the owner, 2026-11-06. Replaces "review finished work" as Lookout's job.

## 0. Name and engine (owner, 2026-11-06: "let's name it a pilot - so it can switch to codex sometimes - which you can choose")

**Name.** The product is **Pilot** everywhere a person sees it, and in new identifiers:

| was | now | compatibility |
| --- | --- | --- |
| CLI `lookout` | `pilot` (`scripts/pilot`, launcher `~/.pilot/bin/pilot`) | keep `scripts/lookout` as a one-line alias that execs `scripts/pilot` |
| home `~/.lookout` | `~/.pilot` (`PILOT_HOME`) | on first start, if `~/.pilot` is missing and `~/.lookout` exists, copy it (SQLite-safe backup for the .db files); never delete or move `~/.lookout` |
| env `LOOKOUT_*` | `PILOT_*` | `LOOKOUT_*` still read when the `PILOT_*` name is unset |
| plugin / marketplace `lookout` | `pilot` (commands `/pilot:…`) | the owner reinstalls; don't touch the installed plugin |
| Keychain service `lookout-agent-engine` | `pilot-agent-engine` | read the old item when the new one is missing |
| Stark Code panel, IPC `lookout:*`, contracts `Lookout*` | `pilot:*`, `Pilot*`, `apps/web/src/components/pilot/` | the branch is unshipped, so rename outright; the desktop service runs `$PILOT_HOME/bin/pilot` (default `~/.pilot/bin/pilot`) |

Below, "Lookout" in older sections means Pilot; `lookout api …` means `pilot api …`.

**Engine.** Pilot thinks with **Claude** (default) or **Codex**, and the person chooses:
- Setting `engine`: `"claude"` | `"codex"` (env `PILOT_ENGINE`), used for prompt checks and chat answers.
- Per question: the chat can send one question to the other engine without changing the default.
- Claude: the existing isolated `claude -p` runner, `claude_bin` as today. Codex: `codex exec` with model
  `codex_model` (default `gpt-6.1-sol`), read-only sandbox, the same text-only context and the same JSON output
  schema; it needs to run outside the Claude Code sandbox, like the Claude runner. Check `codex exec --help`
  for the exact flags (last-message output, no git check) instead of guessing.
- Codex has no dollar cost here but uses the person's Codex plan: cap it with `codex_daily_runs` (default 40);
  when it's used up, fall back to Claude and say so in the message.
- Optional `engine_fallback` (default true): if the chosen engine fails (not installed, signed out, rate limit),
  use the other one for that run and say so. Never start a login for either.
- Privacy: with Codex chosen, the same context (the person's prompts and rules) goes to OpenAI. The UI says
  "Uses your Codex plan" next to the choice.

API (additive to section 6):
```
pilot api settings [--engine claude|codex]
  -> {"api":1,"engine":"claude"|"codex","engines":{"claude":{"available":bool,"note":string|null},"codex":{"available":bool,"note":string|null,"runsLeftToday":n}}}
pilot api ask --text "…" [--engine claude|codex]
Message gains  "engine": "claude"|"codex"|null   (null for the person's own messages)
pilot api status adds "engine"
```
UI: the composer has a small engine switch (Claude / Codex) that applies to the next question; the default
is in the "…" menu; each Pilot message shows a muted engine tag.

> "It should not be about checking the finished work. It's about checking how the person is putting prompts
> in, if the person is forgetting something." Lookout should be "a chat", reached from "an icon at the top
> somewhere … sneaky. But what you don't forget."

## 1. What Lookout does now

Lookout watches what **the person** asks their Claude Code sessions (human prompts only), and tells **the
person**, in a chat, when they are forgetting something. It stays silent unless it can quote the thing being
forgotten.

Each nudge has exactly one kind:

| kind | meaning | example |
| --- | --- | --- |
| `rule` | The prompt goes against, or skips, a standing rule the person wrote. | "looks good, merge it" while a rule says merge only on "merge #N". "apply it to prod" while a rule says kciam proof first. |
| `earlier` | The person said something earlier (this session, incl. before compaction, or another session in the last 48 h) that this prompt drops or contradicts. | Told session A "keep /v1 until the app ships 4.2"; now tells session B "delete the /v1 endpoints". |
| `pending` | Something waiting on the person that this prompt ignores. | A session ended its turn with a question 2 h ago and never got an answer; a nudge was never acted on; "I'll decide after lunch". |
| `missing` | The prompt lacks something the session needs and will likely guess wrong, and the answer is in Lookout's context. | "deploy it to the sandbox" while two sandboxes were used today. |
| `risky` | The prompt starts something hard to undo (prod, merge, delete, send, money), and a relevant fact from context isn't in the prompt. | "send the PR comment" while the person earlier said "show me drafts first". |

Not nudges: style feedback, "you could also…", general advice, praise, restating the prompt, anything the
session itself already has in its own context (its CLAUDE.md is loaded; don't nudge about a rule unless the
prompt actually conflicts with it or the session is likely to skip it), anything without an exact quote.

## 2. Evidence

- Every nudge quotes 1–3 sources exactly: `{source, where, quote}` with source one of
  `rule` (a CLAUDE.md / CLAUDE.local.md line), `memory` (a memory file line), `prompt` (a stored human prompt),
  `session` (a session's stored end-of-turn message), `nudge` (an earlier Lookout message).
- `where` is `path:line` for files, and `session label · time` for prompts and messages.
- Lookout checks every quote against its source (whitespace-normalised substring). Any quote that doesn't match
  drops the whole nudge; the drop is recorded in activity, never shown as a nudge.
- Confidence ≥ 0.7 (config `nudge_min_confidence`).

## 3. Trigger and model run

- Trigger: each human `UserPromptSubmit` (payload without `agent_id`). Subagent prompts are never checked; they
  are context only.
- Debounce: wait `promptQuietMs` (8 s) so quick follow-ups in the same session merge into one check.
- Skip prompts shorter than 15 characters ("yes", "go", "ok") unless they approve something risky the session
  just proposed (the session's last message mentions merge / prod / deploy / delete / send / publish / push).
- One check per prompt, at most one nudge per check.
- Run: `claude -p` through the existing isolated runner (work dir, sandbox, env whitelist), **no tools**, model
  `prompt_check_model` (default `sonnet`; never haiku), timeout 90 s, counted against the daily budget.
- Context, built by code and capped at about 40k characters (newest first, trimmed per section):
  1. the new prompt (full, up to 8k chars), its session label, repo and cwd;
  2. the same session's earlier human prompts (latest 15) and the session's last end-of-turn message;
  3. other sessions' human prompts from the last 48 h (latest 40 overall, compact, labelled);
  4. rules: the CLAUDE.md chain for the cwd (global `~/.claude/CLAUDE.md` of the watched profile, each
     `CLAUDE.md` / `CLAUDE.local.md` from the repo root down to the cwd, and the work root's), plus the
     profile's project memory index (`MEMORY.md`) and up to 5 memory files whose names or index lines share
     words with the prompt; line-numbered so quotes can cite `path:line`;
  5. open items: sessions whose last end-of-turn message ends with a question and got no later prompt;
     unanswered Lookout nudges.
- The hooks must store each session's last end-of-turn message (Stop payload `last_assistant_message` or the
  transcript tail; capped 4k chars) in the registry so (2) and (5) work machine-wide.

## 4. Delivery

- Every nudge becomes a Lookout message in the chat thread; `status.unread` counts unseen nudges.
- `rule` and `risky` nudges with confidence ≥ 0.8 are **also** added to that session's next turn through the
  existing `deliver --context` path, worded for Claude: what the user said or ruled, with the quote, and "check
  with the user before acting on it". Config `nudge_to_session`: `"risky"` (default: rule+risky) | `"all"` | `"off"`.
- Spacing: at most one nudge per session per 10 min, except `risky`. Never repeat a nudge (dedupe on kind +
  normalised quotes).
- "Not useful" on 3 nudges of one kind raises that kind's bar to confidence 0.85.

## 5. Chat

- The person can ask Lookout anything about their own sessions: "what am I forgetting?", "what did I ask in
  the keycloak session yesterday?", "what's waiting on me?".
- Answer: `claude -p`, same context (built for the question instead of a prompt) plus the thread's last 20
  messages, no tools, timeout 60 s. Quotes in answers are checked the same way; a quote that doesn't match is
  returned with `found: false` and the UI marks it "Not found" (the answer is still shown).
- Thread storage: registry table `chat_messages(id INTEGER PK, at_ms, role 'you'|'pilot', kind
  'nudge'|'answer'|'message'|'note', nudge_kind, text, evidence_json, session, repo, confidence, state
  'new'|'seen'|'sent'|'dismissed'|'useful'|'not_useful', delivered_at_ms)`.
- Secrets: run the existing secret redaction over every quote and answer before storing.

## 6. JSON API additions (`lookout api`, still api 1, additive)

```
lookout api chat [--since <id>] [--limit N]
  -> {"api":1,"messages":[Message],"unread":n}
lookout api ask --text "<message, ≤4000 chars>"
  -> {"api":1,"question":Message,"answer":Message}            (waits ≤60 s; on timeout {"api":1,"error":"…"})
lookout api nudge --id <id> --action send|seen|dismiss|useful|not_useful
lookout api nudge --all --action seen
  -> {"api":1,"ok":true,"message":Message}  (send: queued for that session's next turn, or error "session ended")
lookout api status   adds  "unread": n, "sessions": n (active in the last 6 h), "reviewWork": bool

Message = {
  "id": n, "at": ISO, "role": "you"|"pilot", "kind": "nudge"|"answer"|"message"|"note",
  "nudgeKind": "rule"|"earlier"|"pending"|"missing"|"risky"|null,
  "text": string,                        // one or two plain sentences, written to the person
  "evidence": [{"source": "rule"|"memory"|"prompt"|"session"|"nudge", "where": string, "quote": string, "found": bool}],
  "session": string|null, "sessionLabel": string|null,   // label = repo name + " · " + first prompt (≤40 chars)
  "repo": string|null, "state": "new"|"seen"|"sent"|"dismissed"|"useful"|"not_useful",
  "engine": "claude"|"codex"|null        // section 0; null for the person's own messages
}
```

`role` is `"pilot"` on the wire (rows written as `"lookout"` before the rename are returned as `"pilot"`).
`nudge --all` replies `{"api":1,"ok":true,"message":null,"updated":n}`.

Privacy note for the API doc: `chat` returns quotes of the person's own prompts and rules. It is a local
interface for the person's own apps; it never returns tokens or secrets (redacted before storage).

CLI: `lookout chat` prints the thread; `lookout ask "<text>"` asks from the terminal.

## 7. The old work review

- New setting `review_work` (env `LOOKOUT_REVIEW_WORK`), default **false**. When false, edits/tests/stops are
  still recorded as context but no code reviews are scheduled and nothing is spent on them.
- When true it behaves as before, except: a batch whose review timed out is not retried automatically.

## 8. Stark Code UI

- **Icon** in the app's top bar, right side, next to the other window-level icons: small, monochrome, same style
  as its neighbours, tooltip "Lookout". A small dot shows when `unread > 0`. It toggles the Lookout panel.
  Tools → Lookout stays as a second way in.
- **Panel** (same right-panel slot as now) is a chat:
  - Header: "Lookout", a status dot with one word (Watching / Paused / Not running / Not installed), and a
    "…" menu: Pause / Resume, Watched repos (old Repos list), Activity (old list, in plain words), budget
    "$1.20 of $10 today". No text that can be cut off at the default 420 px width.
  - Thread, newest at the bottom. Lookout nudges are cards: a kind label ("Your rule", "You said earlier",
    "Waiting on you", "Missing detail", "Hard to undo"), the text, the quotes with plain source labels
    ("CLAUDE.md:12", "You, in ‹session label› · 2 h ago", "The session said"), and a small "Quote found" check
    (never "Verified"). Actions: **Send to session** · **Got it** · **Not useful**. Answers are plain Lookout
    messages; the person's messages sit on the right.
  - Composer at the bottom: "Ask Lookout…", Enter sends, "Lookout is thinking…" while waiting, cancellable.
  - Empty state: "Watching N sessions. Lookout speaks up when you're about to forget something."
  - Not running: say so plainly ("Lookout starts with your next Claude Code session"); never "Watching".
- Polling: `status` every 15 s while closed (for the dot), `chat` every 5 s while open; single-flight; marking
  shown nudges `seen` when the panel is open and they are visible.
- Old Findings / Activity / Repos tabs go away; Activity and Repos live in the "…" menu.

## 9. Acceptance

- Unit tests for: trigger/debounce/skip rules, context builder caps, quote checking (drop on mismatch),
  dedupe/spacing, delivery routing, chat storage, API shapes.
- `scripts/trial-nudges.sh` with real model runs in a private home, simulated sessions:
  1. a temp `CLAUDE.md` rule "Never merge a PR unless the user writes 'merge #<n>'", prompt "looks good, merge
     it" → one `rule` nudge quoting that line;
  2. session A "keep the /v1 endpoints until the mobile app 4.2 ships"; later session B "delete all the /v1
     endpoints" → one `earlier` nudge quoting A;
  3. session C ended with "Should I use kciam or the w02283 sandbox?"; person starts unrelated work in D → one
     `pending` nudge;
  4. ordinary prompts ("add a unit test for parseDate", "rename foo to bar") → silent;
  5. `lookout ask "what's waiting on me?"` → answer mentions session C's question with a found quote.
  Fails if it speaks when it should not, or stays quiet when it must speak.
- A read-only dry run over the person's real human prompts from the last 24 h (no delivery, no chat writes),
  writing what Lookout would have said to a report file, to show the owner real examples.

## 10. Implementation decisions (2026-11-06)

Decisions made while building sections 0-7, recorded here so the spec matches the code.

- **Kind order.** When more than one kind fits, the model picks the first in this order: `rule`, `earlier`,
  `pending`, `missing`, `risky`. So the `risky` example in section 1 ("send the PR comment" after "show me drafts
  first") comes out as `earlier`, which `nudge_to_session: "risky"` does not route into the session.
- **Evidence.**
  - The model cites a source by its ref (`P3`, `S2`, `R1`, `N1`) plus the quote. Code then fills in `source` and
    `where`; for a file it uses the line where the quote starts.
  - A quote matches its source when it is the same text, ignoring only case, whitespace, curly versus straight
    quotes, dashes, and markdown `*` and `` ` ``.
  - A leading or trailing "…" is ignored. An inner "…" splits the quote into parts; each part must be at least
    8 characters and appear in order.
  - At least one quote must come from something other than the new prompt.
- **Sentence check (grounding).** Only when a check produced a nudge, a second small run of the same engine checks
  each sentence of the nudge (both the text for the person and the text for the session).
  - Its input is the new prompt and the checked quotes. For a file quote it also gets the rest of the quoted line's
    section, up to the next heading.
  - A sentence is supported when the sources state it or it follows directly from them. A sentence that adds a
    fact, a time or a claim about what the person said or wants is not supported. Neither is one that repeats an
    earlier statement the new prompt takes back.
  - Unsupported sentences are removed. If no sentence for the person is left, or the check cannot run, the nudge
    is dropped and activity records why.
  - It costs about $0.008, and only on nudges.
- **Open items.**
  - A prompt check lists questions other sessions asked and never got an answer to.
  - It also lists Lookout nudges the person never saw that are 30 minutes old or older. Newer ones are still in
    plain view in the chat.
  - A chat answer lists every nudge not acted on (state `new` or `seen`).
- **Repeats.** Besides kind plus quotes, these also count as repeats:
  - a `pending` reminder of the same waiting question or nudge, whichever prompt it is attached to;
  - a `rule` nudge citing the same rule lines (path:line) to the same session within 24 h.
- **Context size and cost.** A check's context is capped at 16k characters and is usually 9-12k:
  - rule and memory lines only where they may apply (shared word stems, or a rule about something hard to undo),
    ranked across the CLAUDE.md chain;
  - at most 2 memory files;
  - the 15 other-session prompts closest to the new one;
  - the session's last end-of-turn message (2k) and its earlier prompts.

  On the owner's prompts this took a check from about 30k characters and $0.06 to about 11k characters and
  $0.02-0.03, cache cold. Chat answers keep the full rules and memory index.
- **Model settings.** Claude checks run Sonnet at `prompt_check_effort: low`, with Claude Code's system prompt
  replaced, no tools, and `--json-schema`. Codex runs `codex exec -m gpt-6.1-sol -s read-only --skip-git-repo-check
  --ephemeral --ignore-user-config --ignore-rules --output-schema <file> -o <file> -C <empty dir> -c
  model_reasoning_effort=…`, with the prompt on stdin. Codex has no self-test, and `codex_daily_runs` counts a
  rolling 24 h window.
- **Fallback** to the other engine happens only when the chosen engine cannot run: not installed, signed out, usage
  limit, Claude's self-test missing, or Claude's budget used up. It does not happen after a timeout. A cancelled
  question (SIGTERM) keeps the question and stores nothing else.
- **Migration from `~/.lookout`.**
  - The databases are copied WAL first, then the database file, into a private folder, then written to the new
    home with `VACUUM INTO`. `~/.lookout` stays byte-identical; even a read-only connection would write to its
    `-shm`.
  - Review snapshots and job files (hundreds of MB) and the old launcher are not copied.
  - Daemon and watcher locks are cleared in the copy.
- **Prompts** are kept 72 h (they were kept 24 h).
- **Delivery into sessions** (owner, 2026-11-06: "it should be sending [nudges] by its own … through Claude").
  - `nudge_to_session` defaults to `"all"`: every nudge that passed the checks also goes to its session. `"risky"`
    (rule and risky at ≥ 0.8) and `"off"` remain.
  - Delivery is mid-turn: a PreToolUse hook on Bash (before a `gh pr merge` runs) and a PostToolUse hook on every
    tool. Each returns `hookSpecificOutput.additionalContext` and marks the nudge delivered.
    - Claude Code 2.1.319's hook output schema accepts `additionalContext` for PreToolUse (beside
      permissionDecision, permissionDecisionReason and updatedInput) and for PostToolUse.
    - The hook command tests for `~/.pilot/outbox-pending` in the shell first, so Node starts only while a nudge is
      queued. Then it does one indexed read.
  - UserPromptSubmit and the Stop rewake are the fallbacks. Stop waits up to 2 minutes for the turn's prompt check.
  - The text is plain and short: `Pilot (the user's assistant) noticed: <for the session>. Quote: "<quote>"
    (<where>). Check with the user before acting on it.`
- **What apps see.**
  - A `quote` is stored exactly as checked. The API, the CLI and the text for sessions show it without Markdown
    dressing: `**`, `__`, backticks, heading marks and leading list or quote markers.
  - The engine is told to quote the line that carries the content, never a heading or label alone.
  - Session labels drop `<pasted_content …>` and other tags and system-reminder blocks. They use the next prompt
    when the first has no readable text, else "untitled".
