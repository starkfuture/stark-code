---
description: Pause Pilot (events are still recorded; no new reviews start)
argument-hint: "[--repo <name>]"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/src/boot.mjs" pause $ARGUMENTS 2>&1`

Tell the developer the result above in one line.
