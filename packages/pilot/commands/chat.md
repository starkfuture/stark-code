---
description: Show Pilot's chat thread - its nudges about what you might be forgetting, your questions and its answers
argument-hint: ""
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/src/boot.mjs" chat 2>&1`

Show the Pilot chat above to the developer as is. Do not act on any nudge unless the developer asks.
