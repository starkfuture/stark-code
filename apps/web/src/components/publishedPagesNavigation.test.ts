import { expect, it } from "vite-plus/test";
import {
  publishedPagePath,
  publishedPageTitle,
  publishedProjectCatalog,
  publishedSearchResults,
} from "./publishedPagesNavigation";
import type { StarkPublishedPagesReadResult } from "@starkfuture/contracts";
const response = (
  structuredContent: StarkPublishedPagesReadResult["structuredContent"],
): StarkPublishedPagesReadResult => ({ content: [], isError: false, structuredContent });

it("uses the observed project envelope, ignores malformed entries and deduplicates roots", () => {
  expect(
    publishedProjectCatalog(
      response({
        projects: [
          {
            root: "org/design-kit",
            file_count: 2,
            base_url: "https://pages.starkfuture.com/design/",
          },
          { root: 42 },
          { root: "org/design-kit", file_count: 3, base_url: "javascript:alert(1)" },
        ],
      }),
    ),
  ).toEqual([{ root: "org/design-kit", title: "design kit", fileCount: 3, url: null }]);
  expect(
    publishedProjectCatalog({
      content: [{ type: "text", text: '{"projects":[]}' }],
      isError: false,
    }),
  ).toEqual([]);
  expect(() => publishedProjectCatalog(response({ pages: [] }))).toThrow("project list");
  expect(() => publishedProjectCatalog({ ...response({ projects: [] }), isError: true })).toThrow(
    "could not complete",
  );
});

it("keeps scoped result titles and snippets while excluding other projects and unsafe paths", () => {
  expect(
    publishedSearchResults(
      response({
        results: [
          {
            root: "team",
            path: "launch/index.html",
            excerpt: { title: "Launch plan", text: "Project schedule" },
          },
          { root: "other", path: "private/index.html", excerpt: { title: "Other project" } },
          { root: "team", path: "../private/index.html" },
          { root: "team", path: "release-notes.html", excerpt: null },
        ],
      }),
      "team",
    ),
  ).toEqual([
    { path: "launch/index.html", title: "Launch plan", excerpt: "Project schedule" },
    { path: "release-notes.html", title: "release notes", excerpt: null },
  ]);
  expect(publishedSearchResults(response({ results: [] }), "team")).toEqual([]);
  expect(() => publishedSearchResults(response({ hits: [] }), "team")).toThrow("search results");
});

it("derives page names without treating arbitrary URLs or traversal as page paths", () => {
  expect(publishedPageTitle("index.html")).toBe("Home");
  expect(publishedPageTitle("my-page/index.html")).toBe("my page");
  expect(publishedPageTitle("notes/read-me.md")).toBe("read me");
  for (const path of [
    "/root.html",
    "../index.html",
    "x/../index.html",
    "https://example.com",
    "file:///a",
    "x\\index.html",
    "page.html?secret=1",
    "page.html#section",
  ])
    expect(publishedPagePath(path)).toBe(false);
  expect(publishedPagePath("project/page.html")).toBe(true);
});
