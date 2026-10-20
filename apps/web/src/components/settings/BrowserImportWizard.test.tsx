// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { IMPORTED_BROWSER_PROFILE_ID, type BrowserImportSource } from "@starkfuture/contracts";
import { BrowserImportWizard } from "./BrowserImportWizard";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const source: BrowserImportSource = {
  id: "chrome",
  name: "Chrome",
  profiles: [{ directory: "Original", name: "Original account", domains: ["example.com"] }],
};
function button(label: string) {
  const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(value).toBeDefined();
  return value!;
}

it("requires fresh site selection and consent when refresh replaces the chosen source account", async () => {
  const importCookies = vi.fn(async () => ({
    kind: "blocked" as const,
    reason: "browserRunning" as const,
  }));
  const refreshed: BrowserImportSource = {
    ...source,
    profiles: [{ directory: "Replacement", name: "Replacement account", domains: ["example.com"] }],
  };
  await act(() =>
    root.render(
      <BrowserImportWizard
        source={source}
        destinationEnvironmentName="This Mac"
        targetProfiles={[{ id: IMPORTED_BROWSER_PROFILE_ID, name: "Personal imported sessions" }]}
        canCreateProfile={false}
        onImport={importCookies}
        onRefreshSource={async () => refreshed}
        onOpenFullDiskAccessSettings={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  const originalBoxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(originalBoxes.every((box) => !box.checked)).toBe(true);
  await act(() => {
    originalBoxes.forEach((box) => box.click());
  });
  expect(button("Import").disabled).toBe(false);
  await act(() => button("Import").click());
  expect(importCookies).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      sourceProfileDirectory: "Original",
      selectedDomains: ["example.com"],
      consent: true,
    }),
  );
  await act(() => button("I’ve quit it").click());
  expect(document.body.textContent).toContain("Replacement account");
  expect(
    [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(
      (box) => !box.checked,
    ),
  ).toBe(true);
  expect(button("Import").disabled).toBe(true);
  expect(importCookies).toHaveBeenCalledTimes(1);
});
