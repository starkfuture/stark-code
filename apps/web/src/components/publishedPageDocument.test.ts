// @vitest-environment jsdom
import { expect, it } from "vite-plus/test";
import { publishedHtmlDocument } from "./publishedPageDocument";

it("removes scripts, navigation, forms and active embeds while retaining readable HTML and styles", () => {
  const source = `<html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="stylesheet" href="https://evil.example/style"><style>h1 { color: red }</style></head><body><h1>Report</h1><p onclick="fetch('https://evil.example')">Body</p><script>parent.stolen=true</script><form action="https://evil.example"><input></form><iframe src="https://evil.example"></iframe><a href="https://pages.starkfuture.com/report">Read</a><img src="https://evil.example/image" onerror="parent.stolen=true"></body></html>`;
  const doc = new DOMParser().parseFromString(publishedHtmlDocument(source), "text/html");
  expect(doc.querySelector("h1")?.textContent).toBe("Report");
  expect(
    doc.querySelectorAll("form,iframe,object,embed,link,[onclick],[onerror],[href]"),
  ).toHaveLength(0);
  expect(doc.querySelectorAll("script")).toHaveLength(1);
  expect(doc.querySelector("script")?.textContent).not.toContain("stolen");
  const csp = doc
    .querySelector('meta[http-equiv="Content-Security-Policy"]')
    ?.getAttribute("content");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("img-src data:");
  expect(csp).toContain(`script-src 'nonce-${doc.querySelector("script")?.getAttribute("nonce")}'`);
  expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
  expect(doc.querySelector("a")?.getAttribute("data-stark-link")).toBe(
    "https://pages.starkfuture.com/report",
  );
  expect(doc.querySelector("a")?.getAttribute("tabindex")).toBe("0");
  expect(doc.querySelector("a")?.getAttribute("role")).toBe("link");
});

it("escapes document-breaking payloads and gives every read a fresh CSP nonce", () => {
  const source =
    '<style></style><script nonce="known">fetch("https://evil.example")</script><div id="report">Safe</div>';
  const first = new DOMParser().parseFromString(publishedHtmlDocument(source), "text/html");
  const second = new DOMParser().parseFromString(publishedHtmlDocument(source), "text/html");
  expect(first.querySelector("#report")?.textContent).toBe("Safe");
  expect(first.querySelectorAll("script")).toHaveLength(1);
  expect(first.querySelector("script")?.getAttribute("nonce")).not.toBe("known");
  expect(first.querySelector("script")?.getAttribute("nonce")).not.toBe(
    second.querySelector("script")?.getAttribute("nonce"),
  );
});
