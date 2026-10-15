// @vitest-environment jsdom
import { act, createRef, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorProps,
} from "./ComposerPromptEditorTiptap";

let root: Root;
let container: HTMLDivElement;
const contextRecords: ComposerPromptEditorProps["contextRecords"] = new Map();
const base = {
  contextRecords,
  skills: [],
  disabled: false,
  placeholder: "Message",
  ariaLabel: "Message",
  onPaste: () => {},
  onChange: () => {},
};
const editorElement = () =>
  container.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
const rangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const rangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
beforeEach(() => {
  // jsdom has no layout; ProseMirror still measures the selection after a real focus event.
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (rangeRects) Object.defineProperty(Range.prototype, "getClientRects", rangeRects);
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
  if (rangeBounds) Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeBounds);
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  vi.unstubAllGlobals();
});

it("keeps keyboard focus entering ! mode and leaving it with empty Backspace", async () => {
  function ShellComposer() {
    const [shell, setShell] = useState(false);
    const editorRef = useRef<ComposerPromptEditorHandle>(null);
    return (
      <ComposerPromptEditorTiptap
        {...base}
        value=""
        cursor={0}
        editorRef={editorRef}
        richTextEnabled={!shell}
        literalText={shell}
        onCommandKeyDown={(key) => {
          if (!shell && key === "!") {
            setShell(true);
            return true;
          }
          if (shell && key === "Backspace") {
            setShell(false);
            return true;
          }
          return false;
        }}
      />
    );
  }
  await act(() => root.render(<ShellComposer />));
  const rich = editorElement();
  await act(() => rich.focus());
  expect(document.activeElement).toBe(rich);
  await act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "!", bubbles: true, cancelable: true }),
    ),
  );
  const shell = editorElement();
  expect(shell).not.toBe(rich);
  expect(shell.dataset.composerRichText).toBe("false");
  expect(document.activeElement).toBe(shell);
  await act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
    ),
  );
  expect(editorElement()).not.toBe(shell);
  expect(editorElement().dataset.composerRichText).toBe("true");
  expect(document.activeElement).toBe(editorElement());
});

it("preserves the controlled command and caret across focused text-mode changes", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const render = (literalText: boolean) =>
    root.render(
      <ComposerPromptEditorTiptap
        {...base}
        value="echo hello"
        cursor={4}
        editorRef={editorRef}
        richTextEnabled={!literalText}
        literalText={literalText}
      />,
    );
  await act(() => render(false));
  await act(() => editorElement().focus());
  await act(() => render(true));
  expect(document.activeElement).toBe(editorElement());
  expect(editorRef.current!.readSnapshot()).toMatchObject({ value: "echo hello", cursor: 4 });
  await act(() => render(false));
  expect(document.activeElement).toBe(editorElement());
  expect(editorRef.current!.readSnapshot()).toMatchObject({ value: "echo hello", cursor: 4 });
});

it("does not steal focus from another control when text mode changes", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const button = document.createElement("button");
  document.body.append(button);
  try {
    const render = (literalText: boolean) =>
      root.render(
        <ComposerPromptEditorTiptap
          {...base}
          value=""
          cursor={0}
          editorRef={editorRef}
          richTextEnabled={!literalText}
          literalText={literalText}
        />,
      );
    await act(() => render(false));
    await act(() => button.focus());
    await act(() => render(true));
    expect(document.activeElement).toBe(button);
  } finally {
    button.remove();
  }
});
