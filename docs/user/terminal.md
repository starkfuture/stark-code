# Terminals and native agent shells

## Native shell mode

On web and desktop, choose native shell mode in a Codex or Claude thread to use
the installed command-line program inside Stark Code. Its commands, plugins, and
terminal interaction come from that program. The terminal session keeps its
working directory and shell state until it exits.

Codex native shells start read-only and ask for approval. An explicit
`--sandbox workspace-write` provider launch argument permits workspace writes;
full-access bypass flags and unknown launch arguments are refused. Configure
launch arguments in **Settings → Providers**.

On macOS, **Settings → General → Native shell** controls extra non-secret login
shell variables imported when the app starts. `AGENT_WORKSPACE` is included by
default. Restart Stark Code after changing this list.

## Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. Stark Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when Stark Code restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.
