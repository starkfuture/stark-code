import { expect, it } from "vite-plus/test";
import {
  PROVIDER_PERMISSION_WARNING,
  activeComposerPermissionWarnings,
  permissionWarningForCatalogEntry,
} from "./composerPermissionWarnings";
it("warns for skills even on older payloads and for plugin commands, while app commands are unaffected", () => {
  expect(
    permissionWarningForCatalogEntry({
      type: "skill",
      skill: { name: "deploy", path: "/skills/deploy/SKILL.md", enabled: true },
    }),
  ).toBe(PROVIDER_PERMISSION_WARNING);
  expect(
    permissionWarningForCatalogEntry({
      type: "provider-slash-command",
      command: { name: "plugin:deploy", source: "plugin" },
    }),
  ).toBe(PROVIDER_PERMISSION_WARNING);
  expect(
    permissionWarningForCatalogEntry({
      type: "provider-slash-command",
      command: { name: "debug", source: "builtin", permissionWarning: PROVIDER_PERMISSION_WARNING },
    }),
  ).toBe(PROVIDER_PERMISSION_WARNING);
  expect(permissionWarningForCatalogEntry({ type: "slash-command" })).toBeNull();
});
it("keeps a warning while a selected reference is present, including arguments, without matching a different skill", () => {
  const entry = { reference: "$plugin:skill", warning: PROVIDER_PERMISSION_WARNING };
  expect(activeComposerPermissionWarnings("Use $plugin:skill for this", [entry])).toEqual([entry]);
  expect(activeComposerPermissionWarnings("$plugin:skill-other", [entry])).toEqual([]);
  expect(activeComposerPermissionWarnings("plain text", [entry])).toEqual([]);
});
