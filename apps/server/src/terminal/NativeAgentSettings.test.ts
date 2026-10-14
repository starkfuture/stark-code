import { describe, expect, it } from "@effect/vitest";
import { mergeNativeSettings } from "./NativeAgentSettings.ts";

describe("native Claude settings", () => {
  it("keeps configured hooks and permission rules while locking bypass mode", () => {
    const hooks = {
      PreToolUse: [
        { matcher: "pages_upload", hooks: [{ type: "command", command: "publish-guard" }] },
      ],
    };
    const merged = mergeNativeSettings(
      { hooks, permissions: { allow: ["Read"] }, language: "english" },
      { disableAutoMode: "disable", permissions: { disableBypassPermissionsMode: "disable" } },
    );
    expect(merged.hooks).toEqual(hooks);
    expect(merged.permissions).toEqual({
      allow: ["Read"],
      disableBypassPermissionsMode: "disable",
    });
    expect(merged.disableAutoMode).toBe("disable");
    expect(merged.language).toBe("english");
  });
  it("does not change an object's prototype when settings contain an own __proto__ key", () => {
    const merged = mergeNativeSettings({}, JSON.parse('{"__proto__":{"unsafe":true}}'));
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(({} as { unsafe?: boolean }).unsafe).toBeUndefined();
  });
});
