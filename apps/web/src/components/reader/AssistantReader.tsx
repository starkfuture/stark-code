import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { observeResize } from "../../lib/observeResize";
import {
  readerNeedsContents,
  readerSections,
  readerViewport,
  type ReaderSection,
} from "./readerOutline";

/** Reader presentation for assistant Markdown, including captured native-shell replies. */
export function AssistantReader({
  children,
  contentKey,
  isStreaming = false,
}: {
  readonly children: ReactNode;
  readonly contentKey: string;
  readonly isStreaming?: boolean;
}) {
  const content = useRef<HTMLDivElement>(null);
  const prefix = useId();
  const [outline, setOutline] = useState<{ key: string; sections: ReaderSection[] } | null>(null);
  useEffect(() => {
    const container = content.current;
    if (!container || isStreaming) return;
    const markdown = container.querySelector<HTMLElement>(".chat-markdown") ?? container;
    const sections = readerSections(markdown);
    if (sections.length < 3) return;
    const viewport = readerViewport(container);
    const measure = () => {
      const visible = readerNeedsContents({
        sectionCount: sections.length,
        contentHeight: Math.max(container.scrollHeight, container.getBoundingClientRect().height),
        viewportHeight: viewport?.clientHeight ?? window.innerHeight,
        isStreaming: false,
      });
      setOutline((previous) => {
        if (!visible) return previous === null ? previous : null;
        if (
          previous?.key === contentKey &&
          previous.sections.length === sections.length &&
          previous.sections.every(
            (section, index) =>
              section.element === sections[index]?.element &&
              section.label === sections[index]?.label,
          )
        )
          return previous;
        return { key: contentKey, sections };
      });
    };
    const restore = sections.map(({ element }, index) => {
      const id = element.getAttribute("id");
      const tabindex = element.getAttribute("tabindex");
      if (!id) element.id = `${prefix}-section-${index}`;
      if (tabindex === null) element.tabIndex = -1;
      return () => {
        if (id === null) element.removeAttribute("id");
        else element.setAttribute("id", id);
        if (tabindex === null) element.removeAttribute("tabindex");
      };
    });
    const cancelObservation = observeResize(viewport ? [container, viewport] : container, measure);
    const initialMeasure = window.requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelObservation();
      window.cancelAnimationFrame(initialMeasure);
      window.removeEventListener("resize", measure);
      for (const reset of restore) reset();
    };
  }, [contentKey, isStreaming, prefix]);
  const sections = !isStreaming && outline?.key === contentKey ? outline.sections : [];
  return (
    <div className="assistant-reader min-w-0 w-full">
      {sections.length >= 3 ? (
        <nav
          aria-label="Reply contents"
          data-thread-find-ignore
          data-scroll-anchor-ignore
          className="mb-5 max-w-[70ch] border-l-2 border-border pl-3 text-sm"
        >
          <p className="mb-1 font-medium text-muted-foreground">Contents</p>
          <ol className="flex max-h-60 flex-col items-start gap-1 overflow-auto">
            {sections.map((section) => (
              <li key={section.element.id} className="max-w-full">
                <a
                  href={`#${encodeURIComponent(section.element.id)}`}
                  className="block rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={(event) => {
                    event.preventDefault();
                    section.element.scrollIntoView({ block: "start", behavior: "auto" });
                    section.element.focus({ preventScroll: true });
                  }}
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div ref={content} data-assistant-reader-content className="min-w-0">
        {children}
      </div>
    </div>
  );
}
