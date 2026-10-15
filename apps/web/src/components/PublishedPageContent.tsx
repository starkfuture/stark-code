/* oxlint-disable react/no-array-index-key -- MCP arrays have no item identity and each read replaces the entire result. */
import { publishedHtmlDocument } from "./publishedPageDocument";
import { useEffect, useMemo, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isOpenableStarkPageLink } from "@starkfuture/shared/starkPages";
import { pageFieldLabel, pageRecord, decodePublishedPageText } from "./publishedPagesFields";

function openLink(url: string) {
  if (isOpenableStarkPageLink(url)) void window.desktopBridge?.openStarkPagesLink?.(url);
}

const markdownComponents: Components = {
  img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
  a: ({ href, children }) => (
    <button type="button" className="text-primary underline" onClick={() => href && openLink(href)}>
      {children}
    </button>
  ),
};

/** Published content gets no app origin, credentials, network access, forms or page scripts. */
function PublishedHtml({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const document = useMemo(() => publishedHtmlDocument(html), [html]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      const data = pageRecord(event.data);
      if (data?.source === "stark-published-page" && typeof data.url === "string")
        openLink(data.url);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      ref={frame}
      title="Published page"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={document}
      className="h-[65vh] min-h-96 w-full rounded-lg border border-border bg-white"
    />
  );
}

/** Keep arbitrary server result shapes readable without treating them as app markup. */
export function PublishedPageContent({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (depth > 10) return <p>More nested content is available in Pages.</p>;
  if (typeof value === "string") {
    const decoded = decodePublishedPageText(value);
    if (decoded !== value) return <PublishedPageContent value={decoded} depth={depth + 1} />;
    if (/<(?:!doctype|html|head|body|article|section|h[1-6]|div|p|table)(?:\s|>)/i.test(value))
      return <PublishedHtml html={value} />;
    return (
      <div className="chat-markdown max-w-none break-words text-sm leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>
          {value}
        </ReactMarkdown>
      </div>
    );
  }
  if (Array.isArray(value))
    return value.length ? (
      <div className="space-y-4">
        {value.slice(0, 200).map((item, index) => (
          <div key={index} className="rounded-lg border border-border p-3">
            <PublishedPageContent value={item} depth={depth + 1} />
          </div>
        ))}
        {value.length > 200 ? (
          <p>Showing the first 200 results. Narrow your search for more.</p>
        ) : null}
      </div>
    ) : (
      <p>No pages found.</p>
    );
  const record = pageRecord(value);
  if (record?.kind === "content" && typeof record.text === "string")
    return (
      <div className="space-y-3">
        {record.text.trim() ? (
          <PublishedPageContent value={record.text} depth={depth + 1} />
        ) : (
          <p>This page has no readable text. Use Page link to open it in your browser.</p>
        )}
        {record.truncated === true ? (
          <p className="text-xs text-muted-foreground">
            This is a shortened preview. Open the page in your browser for the full version.
          </p>
        ) : null}
      </div>
    );
  if (record)
    return (
      <dl className="space-y-3">
        {Object.entries(record)
          .slice(0, 100)
          .map(([key, item]) => (
            <div key={key}>
              <dt className="mb-1 text-xs font-medium text-muted-foreground">
                {pageFieldLabel(key)}
              </dt>
              <dd>
                <PublishedPageContent value={item} depth={depth + 1} />
              </dd>
            </div>
          ))}
      </dl>
    );
  return <span>{value === null || value === undefined ? "—" : String(value)}</span>;
}
