---
description: Ask Pilot about your own sessions ("what's waiting on me?", "what did I ask in the keycloak session?")
argument-hint: "<question>"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/src/boot.mjs" ask "$ARGUMENTS" 2>&1`

Show Pilot's answer above to the developer as is.
