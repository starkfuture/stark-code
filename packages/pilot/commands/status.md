---
description: Pilot daemon, watched profiles and repositories, queue and budget
argument-hint: "[--repo <name>]"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/src/boot.mjs" status $ARGUMENTS 2>&1; node "${CLAUDE_PLUGIN_ROOT}/src/boot.mjs" doctor 2>&1`

Summarise the Pilot status above for the developer in a few lines.
