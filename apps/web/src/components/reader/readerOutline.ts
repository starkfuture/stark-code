export interface ReaderSection {
  readonly element: HTMLElement;
  readonly label: string;
  readonly level: number;
}

function atLineBoundary(node: Node | null, direction: "before" | "after"): boolean {
  for (
    let current = node;
    current;
    current = direction === "before" ? current.previousSibling : current.nextSibling
  ) {
    if (current.nodeType === Node.ELEMENT_NODE && (current as Element).tagName === "BR")
      return true;
    const text = current.textContent ?? "";
    if (current.nodeType === Node.TEXT_NODE && text.includes("\n")) {
      return (
        (direction === "before"
          ? text.slice(text.lastIndexOf("\n") + 1)
          : text.slice(0, text.indexOf("\n"))
        ).trim() === ""
      );
    }
    if (text.trim() !== "") return false;
  }
  return true;
}

function sectionLabel(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const ignored of copy.querySelectorAll('[data-thread-find-ignore], [aria-hidden="true"]'))
    ignored.remove();
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Read rendered, top-level Markdown blocks. Code, quotes, list labels and card UI are not sections. */
export function readerSections(markdown: HTMLElement): ReaderSection[] {
  const sections: ReaderSection[] = [];
  for (const block of markdown.children) {
    if (!(block instanceof HTMLElement)) continue;
    if (/^H[1-6]$/.test(block.tagName)) {
      const label = sectionLabel(block);
      if (label) sections.push({ element: block, label, level: Number(block.tagName.slice(1)) });
    } else if (block.tagName === "P") {
      for (const child of block.children) {
        if (!(child instanceof HTMLElement) || child.tagName !== "STRONG") continue;
        const label = sectionLabel(child);
        if (
          label.endsWith(":") &&
          label.length > 1 &&
          atLineBoundary(child.previousSibling, "before") &&
          atLineBoundary(child.nextSibling, "after")
        ) {
          sections.push({ element: child, label, level: 2 });
        }
      }
    }
  }
  return sections;
}

/** Use the actual chat/panel scroll viewport, which excludes the composer and application chrome. */
export function readerViewport(content: HTMLElement): HTMLElement | null {
  for (let parent = content.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll" || overflow === "overlay") &&
      parent.clientHeight > 0
    )
      return parent;
  }
  return null;
}

export function readerNeedsContents(input: {
  sectionCount: number;
  contentHeight: number;
  viewportHeight: number;
  isStreaming: boolean;
}): boolean {
  return (
    !input.isStreaming &&
    input.sectionCount >= 3 &&
    input.viewportHeight > 0 &&
    input.contentHeight > input.viewportHeight
  );
}
