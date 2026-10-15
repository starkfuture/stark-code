import { useState, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { RuntimeMode, ProviderInteractionMode } from "@starkfuture/contracts";

vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuTrigger: () => null,
  MenuSeparator: () => null,
  MenuRadioGroup: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  MenuRadioItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));
vi.mock("./composerEventScope", () => ({ useComposerMenuProps: () => ({}) }));
vi.mock("./useComposerMenuState", () => ({ useComposerMenuState: () => [false, () => {}] }));
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { runtimeModeOptionsForProvider } from "./runtimeModeConfig";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("selects native Claude modes and leaves Plan when Manual or Auto is selected", async () => {
  function Composer() {
    const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("approval-required");
    const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>("default");
    return (
      <>
        <output>
          {runtimeMode}:{interactionMode}
        </output>
        <CompactComposerControlsMenu
          combinePlanMode
          showInteractionModeToggle
          runtimeMode={runtimeMode}
          interactionMode={interactionMode}
          runtimeModeOptions={runtimeModeOptionsForProvider("claudeAgent")}
          onRuntimeModeChange={setRuntimeMode}
          onToggleInteractionMode={() =>
            setInteractionMode((mode) => (mode === "plan" ? "default" : "plan"))
          }
        />
      </>
    );
  }
  await act(async () => {
    renderer = create(<Composer />);
  });
  expect(renderer!.root.findAllByType("select")).toHaveLength(1);
  expect(renderer!.root.findAllByType("option").map((option) => option.children.join(""))).toEqual([
    "Manual",
    "Accept edits",
    "Auto",
    "Plan",
    "Bypass permissions",
  ]);
  for (const [mode, expected] of [
    ["auto", "auto:default"],
    ["plan", "auto:plan"],
    ["approval-required", "approval-required:default"],
    ["plan", "approval-required:plan"],
    ["auto", "auto:default"],
    ["auto-accept-edits", "auto-accept-edits:default"],
    ["full-access", "full-access:default"],
  ]) {
    await act(async () =>
      renderer!.root.findByType("select").props.onChange({ target: { value: mode } }),
    );
    expect(renderer!.root.findByType("output").children.join("")).toBe(expected);
    expect(renderer!.root.findByType("select").props.value).toBe(mode);
  }
});
