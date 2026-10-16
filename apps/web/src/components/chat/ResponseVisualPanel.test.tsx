// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@starkfuture/client-runtime/environment";
import {
  RESPONSE_VISUALS_MODEL,
  RESPONSE_VISUALS_VERSION,
  type ResponseVisualsResult,
} from "@starkfuture/contracts";
import { makeThreadFixture } from "../../test-fixtures";

const state = vi.hoisted(() => ({ allowed: true, generate: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../../state/responseVisuals", () => ({
  responseVisualsEnvironment: { format: { permissionAtom: () => "visual-permission" } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.generate }));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));

import { ResponseVisualPanel } from "./ResponseVisualPanel";

let root: Root;
let container: HTMLDivElement;
const thread = makeThreadFixture();
const threadRef = scopeThreadRef(thread.environmentId, thread.id);
const result: ResponseVisualsResult = {
  summary: "A concise overview.",
  table: null,
  mermaid: null,
  reason: null,
  model: RESPONSE_VISUALS_MODEL,
  formatterVersion: RESPONSE_VISUALS_VERSION,
  cacheHit: false,
  generationUsage: null,
};
const success = { _tag: "Success" as const, value: result };

async function render(text = "The original answer.") {
  await act(() =>
    root.render(
      <ResponseVisualPanel
        environmentId={thread.environmentId}
        threadRef={threadRef}
        cwd="/work"
        answers={[{ id: "answer", text, label: "Answer" }]}
      />,
    ),
  );
}
function generateButton() {
  return container.querySelector<HTMLButtonElement>("[data-reply-reader] button")!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  state.generate.mockReset().mockResolvedValue(success);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps reading available without generation permission and sends only the selected reply when permitted", async () => {
  state.allowed = false;
  await render();
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toBe(
    "The original answer.",
  );
  expect(generateButton().disabled).toBe(true);
  await act(() => generateButton().click());
  expect(state.generate).not.toHaveBeenCalled();

  state.allowed = true;
  await render();
  expect(generateButton().disabled).toBe(false);
  await act(() => generateButton().click());
  expect(state.generate).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: { threadId: thread.id, answer: "The original answer.", visualRequest: "auto" },
  });
  expect(container.querySelector('[aria-label="AI overview"]')?.textContent).toContain(
    "A concise overview.",
  );
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toContain(
    "The original answer.",
  );
});

it.each([
  ["character limit", "x".repeat(24_001)],
  ["UTF-8 byte limit", "界".repeat(18_000)],
])("allows reading but blocks generation above the %s", async (_limit, answer) => {
  await render(answer);
  expect(generateButton().disabled).toBe(true);
  expect(container.textContent).toContain("Paste a shorter excerpt");
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toBe(answer);
  await act(() => generateButton().click());
  expect(state.generate).not.toHaveBeenCalled();
});

it("prevents duplicate requests while busy and keeps a late result out of a newly selected answer", async () => {
  let complete!: (value: typeof success) => void;
  state.generate.mockReturnValueOnce(
    new Promise<typeof success>((resolve) => {
      complete = resolve;
    }),
  );
  await render();
  await act(() => {
    generateButton().click();
    generateButton().click();
  });
  expect(state.generate).toHaveBeenCalledTimes(1);
  expect(generateButton().disabled).toBe(true);
  expect(generateButton().textContent).toBe("Making visual…");
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Visual format"]')?.disabled).toBe(
    true,
  );

  await render("A different answer.");
  await act(() => complete(success));
  expect(container.querySelector('[aria-label="AI overview"]')).toBeNull();
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toBe(
    "A different answer.",
  );
  expect(generateButton().disabled).toBe(false);
  await act(() => generateButton().click());
  expect(state.generate).toHaveBeenCalledTimes(2);
});
