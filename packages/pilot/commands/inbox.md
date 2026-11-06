---
description: Show Pilot's open findings across your repositories, and whether it told the session or kept quiet (and why)
argument-hint: "[--all] [--repo <name>]"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/src/boot.mjs" inbox $ARGUMENTS 2>&1`

Show the Pilot inbox above to the developer as is. Do not act on any finding unless the developer asks; to record a decision they can run `pilot accept|dismiss|defer <ref> -m "<reason>"` (or ask you to run it with `node "${CLAUDE_PLUGIN_ROOT}/src/boot.mjs"`).
