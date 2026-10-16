// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ copy: vi.fn(), show: vi.fn() }));
vi.mock("../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: state.copy }));
import { NativeMcpReloadControl } from "./NativeMcpReloadControl";
let root: Root;
let container: HTMLDivElement;
const button = (text: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === text,
  );
  if (!found) throw new Error(`Button missing: ${text}`);
  return found;
};
const click = (text: string) => act(async () => button(text).click());
async function render(driver: string) {
  await act(() =>
    root.render(<NativeMcpReloadControl driver={driver} onShowTerminal={state.show} />),
  );
  await click(driver === "codex" ? "MCPs" : "Reload MCPs");
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.copy.mockReset().mockResolvedValue(undefined);
  state.show.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("offers Claude's distinct commands without running or forcing a reload", async () => {
  await render("claudeAgent");
  expect(state.copy).not.toHaveBeenCalled();
  await click("Copy /reload-plugins");
  expect(state.copy).toHaveBeenLastCalledWith("/reload-plugins", "native MCP command");
  expect(document.body.textContent).toContain("It has not been run.");
  expect(state.show).not.toHaveBeenCalled();
  await click("Copy /mcp reconnect all");
  expect(state.copy).toHaveBeenLastCalledWith("/mcp reconnect all", "native MCP command");
  await click("Show terminal");
  expect(state.show).toHaveBeenCalledExactlyOnceWith();
});
it("explains Codex's restart requirement and offers only its supported inspection command", async () => {
  await render("codex");
  expect(document.body.textContent).toContain("no live MCP reload command");
  expect(document.body.textContent).not.toContain("/reload-plugins");
  expect(document.body.textContent).not.toContain("/mcp reconnect");
  await click("Copy /mcp");
  expect(state.copy).toHaveBeenCalledExactlyOnceWith("/mcp", "native MCP command");
  expect(state.show).not.toHaveBeenCalled();
});
it("coalesces repeated copy clicks and reports a clipboard failure honestly", async () => {
  let reject: (reason: Error) => void = () => {};
  state.copy.mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await render("claudeAgent");
  await act(() => {
    button("Copy /reload-plugins").click();
    button("Copy /reload-plugins").click();
  });
  expect(state.copy).toHaveBeenCalledTimes(1);
  await act(() => reject(new Error("Clipboard unavailable")));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not copy");
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(state.show).not.toHaveBeenCalled();
});
