# Stark Code

Stark Future’s Mac coding workspace, built on the open-source T3 Code foundation. Run Codex and Claude with graphical conversations, native agent shells, terminals, diff review, and Git worktrees for parallel tasks.

## Start the Mac app

Use Node 24. Dependencies are installed in this checkout. Double-click **Start Stark Code.command**, or run:

```sh
nvm use 24
npm run dev:desktop -- --home-dir "$PWD/.stark-code"
```

The launcher keeps development data and the Electron profile inside the checkout. Telemetry and upstream hosted sign-in/relay services are disabled. New agents require approvals by default. Automatic upstream updates are disabled for this fork.

For a fresh checkout, install the pinned dependencies before starting:

```sh
npx --yes --package=pnpm@11.10.0 pnpm install --frozen-lockfile
```

## Native shell mode

Open or create a thread, choose Claude or Codex, then select **Shell mode** in the header. The same action is available in the command palette and with **⌘⌥J** on Mac (**Ctrl+Alt+J** elsewhere).

On a new thread, Stark prepares the selected workspace or Git worktree without sending a model prompt. The native mode starts the selected provider’s installed interactive CLI in that thread’s workspace or Git worktree, using its configured executable, launch arguments, and account environment. Slash commands, plugins, skills, MCP configuration, and permission prompts are handled by the CLI itself.

Shell and graphical chat share project files, but have separate conversation histories. Changing views or threads leaves the shell process running; use the CLI’s exit command to end it. Returning to shell mode reattaches to that process. Graphical sending waits while the thread’s native agent is running. Use separate threads and worktrees for parallel edits.

Native shell mode is advertised by the Stark server. Older remote servers need an update before their clients can use it.

## Project layout

- `apps/desktop`: Electron Mac app and platform integration.
- `apps/web`: workspace interface and native terminal renderer.
- `apps/server`: provider processes, durable sessions, Git, and PTY management.
- `packages/contracts`: shared API and event schemas.
- `packages/client-runtime`: shared client state and commands.

Upstream package names, protocols, and source filenames are preserved. `stark.brand.json` holds the Stark identity. The application identifier is `com.starkfuture.starkcode`.

## Upstream and license

Based on [T3 Code](https://github.com/pingdotgg/t3code), retained as the `upstream` Git remote. The original MIT license and third-party attribution are preserved. This checkout has not been published to GitHub or npm.
