import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  StarkPublishedPageDocument,
  StarkPublishedPagesStatus,
  StarkPublishedPagesTool,
} from "@starkfuture/contracts";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { PublishedPageContent } from "./PublishedPageContent";
import { cn } from "~/lib/utils";
import type { StarkPageTarget } from "../starkPageTabs";
import {
  publishedPageTitle,
  publishedProjectCatalog,
  publishedSearchResults,
  type PublishedPageEntry,
  type PublishedProject,
} from "./publishedPagesNavigation";

type ReaderState = {
  page: PublishedPageEntry;
  document: StarkPublishedPageDocument | null;
  loading: boolean;
  error: string | null;
};

function readError(failure: unknown, fallback: string): string {
  return failure instanceof Error && !failure.message.includes("IPC")
    ? failure.message.slice(0, 500)
    : fallback;
}

export function PublishedStarkPages({
  expanded = false,
  onExitExpanded,
  onOpenPage,
}: {
  expanded?: boolean;
  onExitExpanded?: (() => void) | undefined;
  onOpenPage?: ((page: StarkPageTarget) => void) | undefined;
} = {}) {
  const bridge = window.desktopBridge?.publishedPages;
  const [status, setStatus] = useState<StarkPublishedPagesStatus | null>(null);
  const [tools, setTools] = useState<readonly StarkPublishedPagesTool[]>([]);
  const [projects, setProjects] = useState<readonly PublishedProject[]>([]);
  const [projectFilter, setProjectFilter] = useState("");
  const [project, setProject] = useState<PublishedProject | null>(null);
  const [query, setQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null);
  const [pages, setPages] = useState<readonly PublishedPageEntry[]>([]);
  const [reader, setReader] = useState<ReaderState | null>(null);
  const [busy, setBusy] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionGeneration = useRef(0);
  const requestGeneration = useRef(0);
  const changingConnection = useRef(false);
  const wasConnected = useRef(false);
  const section = useRef<HTMLElement>(null);
  const pendingScroll = useRef<number | null>(null);
  const projectScroll = useRef(0);
  const pageListScroll = useRef(0);
  const canSearch = tools.some((item) => item.name === "pages_search");

  useLayoutEffect(() => {
    if (pendingScroll.current !== null && section.current) {
      section.current.scrollTop = pendingScroll.current;
      pendingScroll.current = null;
    }
  });

  const clearNavigation = useCallback(() => {
    requestGeneration.current += 1;
    pendingScroll.current = 0;
    setTools([]);
    setProjects([]);
    setProject(null);
    setProjectFilter("");
    setReader(null);
    setPages([]);
    setQuery("");
    setSearchedQuery(null);
    setBusy(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    let pending = false;
    const check = async () => {
      if (pending || changingConnection.current) return;
      pending = true;
      const current = connectionGeneration.current;
      try {
        const next = await bridge.status();
        if (!cancelled && current === connectionGeneration.current) {
          setStatus(next);
          if (next.state !== "connected" && wasConnected.current) clearNavigation();
          wasConnected.current = next.state === "connected";
        }
      } catch {
        if (!cancelled && current === connectionGeneration.current)
          setError("Could not check the Pages connection. Reopen Pages to try again.");
      } finally {
        pending = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      connectionGeneration.current += 1;
      requestGeneration.current += 1;
    };
  }, [bridge, clearNavigation]);

  const loadProjects = useCallback(async () => {
    if (!bridge) return;
    const request = ++requestGeneration.current;
    setBusy(true);
    setError(null);
    try {
      const catalog = await bridge.listTools();
      if (request !== requestGeneration.current) return;
      setTools(catalog);
      if (!catalog.some((item) => item.name === "pages_list_projects"))
        throw new Error("This Pages connection does not offer a project list.");
      const result = await bridge.read({ tool: "pages_list_projects", arguments: {} });
      if (request === requestGeneration.current) setProjects(publishedProjectCatalog(result));
    } catch (failure) {
      if (request === requestGeneration.current)
        setError(readError(failure, "Could not load your Pages projects. Try again."));
    } finally {
      if (request === requestGeneration.current) setBusy(false);
    }
  }, [bridge]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- An authenticated connection starts an external project catalog read.
    if (status?.state === "connected") void loadProjects();
  }, [status?.state, loadProjects]);

  const connect = async () => {
    if (!bridge || changingConnection.current) return;
    const current = ++connectionGeneration.current;
    changingConnection.current = true;
    setError(null);
    setConnectionBusy(true);
    try {
      const next = await bridge.connect();
      if (current === connectionGeneration.current) {
        wasConnected.current = next.state === "connected";
        setStatus(next);
      }
    } catch {
      if (current === connectionGeneration.current)
        setError("Pages sign-in could not start. Try again.");
    } finally {
      changingConnection.current = false;
      if (current === connectionGeneration.current) setConnectionBusy(false);
    }
  };
  const disconnect = async () => {
    if (!bridge || changingConnection.current) return;
    const current = ++connectionGeneration.current;
    changingConnection.current = true;
    wasConnected.current = false;
    clearNavigation();
    setStatus({ state: "signed-out", message: null });
    setConnectionBusy(true);
    try {
      const next = await bridge.disconnect();
      if (current === connectionGeneration.current) setStatus(next);
    } catch {
      if (current === connectionGeneration.current)
        setError("Could not disconnect Pages. Try again.");
    } finally {
      changingConnection.current = false;
      if (current === connectionGeneration.current) setConnectionBusy(false);
    }
  };

  const selectProject = (next: PublishedProject) => {
    requestGeneration.current += 1;
    projectScroll.current = section.current?.scrollTop ?? 0;
    pendingScroll.current = 0;
    setProject(next);
    setPages([]);
    setReader(null);
    setQuery("");
    setSearchedQuery(null);
    setError(null);
    setBusy(false);
  };
  const backToProjects = () => {
    requestGeneration.current += 1;
    pendingScroll.current = projectScroll.current;
    setProject(null);
    setReader(null);
    setError(null);
    setBusy(false);
  };
  const backToPages = () => {
    requestGeneration.current += 1;
    pendingScroll.current = pageListScroll.current;
    setReader(null);
    setError(null);
    setBusy(false);
  };
  const search = async () => {
    if (
      !bridge ||
      !project ||
      !canSearch ||
      busy ||
      query.trim().length < 2 ||
      query.trim().length > 200
    )
      return;
    const request = ++requestGeneration.current;
    const term = query.trim();
    setBusy(true);
    setError(null);
    setPages([]);
    setSearchedQuery(term);
    try {
      const answer = await bridge.read({
        tool: "pages_search",
        arguments: { root: project.root, query: term, limit: 20 },
      });
      if (request === requestGeneration.current)
        setPages(publishedSearchResults(answer, project.root));
    } catch (failure) {
      if (request === requestGeneration.current)
        setError(readError(failure, "Pages could not finish this search. Try again."));
    } finally {
      if (request === requestGeneration.current) setBusy(false);
    }
  };
  const openPage = async (page: PublishedPageEntry, refresh = false) => {
    if (!bridge || !project) return;
    if (onOpenPage && !refresh) {
      onOpenPage({ kind: "published", root: project.root, path: page.path, title: page.title });
      return;
    }
    const request = ++requestGeneration.current;
    const previousDocument = refresh && reader?.page.path === page.path ? reader.document : null;
    if (!reader) pageListScroll.current = section.current?.scrollTop ?? 0;
    if (!previousDocument) pendingScroll.current = 0;
    setBusy(false);
    setError(null);
    setReader({ page, document: previousDocument, loading: true, error: null });
    try {
      const document = await bridge.openPage({ root: project.root, path: page.path, refresh });
      if (request === requestGeneration.current)
        setReader({ page, document, loading: false, error: null });
    } catch (failure) {
      if (request === requestGeneration.current)
        setReader({
          page,
          document: previousDocument,
          loading: false,
          error: readError(failure, "This page could not be opened. Try again."),
        });
    }
  };
  const visibleProjects = projects.filter((item) =>
    `${item.title} ${item.root}`.toLocaleLowerCase().includes(projectFilter.toLocaleLowerCase()),
  );

  return (
    <section
      ref={section}
      aria-label="Published Pages"
      className={cn(
        "min-h-0 min-w-0 flex-1 text-sm",
        reader ? "flex flex-col overflow-hidden p-2" : "overflow-auto p-3",
      )}
    >
      {!bridge ? (
        <p>Open Stark Code on your Mac to connect to published Pages.</p>
      ) : status?.state !== "connected" ? (
        <div className="space-y-3">
          <h3 className="font-medium">Company pages</h3>
          <p className="text-muted-foreground">
            Sign in through your browser to read your company’s pages here.
          </p>
          {status?.message ? <p role="status">{status.message}</p> : null}
          {status?.state === "connecting" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void disconnect()}
              disabled={connectionBusy}
            >
              Cancel sign-in
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void connect()}
              disabled={connectionBusy || status === null}
            >
              Connect Pages
            </Button>
          )}
        </div>
      ) : (
        <div className={cn("min-w-0", reader ? "flex min-h-0 flex-1 flex-col gap-2" : "space-y-4")}>
          <nav aria-label="Pages navigation" className="flex min-w-0 shrink-0 items-center gap-2">
            {project ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={reader ? "Back to pages" : "Back to library"}
                      onClick={reader ? backToPages : backToProjects}
                    >
                      <ArrowLeftIcon aria-hidden />
                    </Button>
                  }
                />
                <TooltipPopup positionMethod="fixed">
                  {reader ? "Back to pages" : "Back to library"}
                </TooltipPopup>
              </Tooltip>
            ) : null}
            <div className="min-w-0 flex-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <div>
                      {project && reader ? (
                        <p className="truncate text-xs text-muted-foreground">{project.title}</p>
                      ) : null}
                      <h3 className="truncate font-medium">
                        {reader?.page.title ?? project?.title ?? "Company pages"}
                      </h3>
                    </div>
                  }
                />
                <TooltipPopup positionMethod="fixed">
                  {project && reader
                    ? `${project.title} / ${reader.page.title}`
                    : (project?.title ?? "Company pages")}
                </TooltipPopup>
              </Tooltip>
            </div>
            <Menu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      render={
                        <Button size="icon-sm" variant="ghost" aria-label="Page actions">
                          <MoreHorizontalIcon aria-hidden />
                        </Button>
                      }
                    />
                  }
                />
                <TooltipPopup positionMethod="fixed">Page actions</TooltipPopup>
              </Tooltip>
              <MenuPopup align="end" positionMethod="fixed">
                {reader?.document ? (
                  <MenuItem
                    disabled={reader.loading}
                    onClick={() => void openPage(reader.page, true)}
                  >
                    Refresh page
                  </MenuItem>
                ) : null}
                {reader?.document?.publicUrl ? (
                  <MenuItem
                    onClick={() =>
                      void window.desktopBridge?.openStarkPagesLink?.(reader.document!.publicUrl!)
                    }
                  >
                    Open in browser
                  </MenuItem>
                ) : !reader && project?.url ? (
                  <MenuItem
                    onClick={() => void window.desktopBridge?.openStarkPagesLink?.(project.url!)}
                  >
                    Open project in browser
                  </MenuItem>
                ) : null}
                {reader ? <MenuItem onClick={backToProjects}>All projects</MenuItem> : null}
                {!project ? (
                  <MenuItem disabled={busy} onClick={() => void loadProjects()}>
                    Refresh projects
                  </MenuItem>
                ) : null}
                <MenuSeparator />
                <MenuItem disabled={connectionBusy} onClick={() => void disconnect()}>
                  Disconnect Pages
                </MenuItem>
              </MenuPopup>
            </Menu>
          </nav>
          {project ? (
            <>
              {reader ? (
                <div
                  aria-label="Published page reader"
                  className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
                >
                  {reader.loading ? (
                    <p role="status">{reader.document ? "Refreshing page…" : "Opening page…"}</p>
                  ) : null}
                  {reader.error ? (
                    <div className="space-y-2">
                      <p role="alert" className="break-words">
                        {reader.error}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void openPage(reader.page, true)}
                      >
                        Retry page
                      </Button>
                    </div>
                  ) : null}
                  {reader.document ? (
                    <PublishedPageContent
                      document={reader.document}
                      expanded
                      onExitExpanded={expanded ? onExitExpanded : undefined}
                      onNavigate={(path) =>
                        void openPage({ path, title: publishedPageTitle(path), excerpt: null })
                      }
                    />
                  ) : null}
                </div>
              ) : (
                <div className="space-y-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void openPage({ path: "index.html", title: "Project home", excerpt: null })
                    }
                  >
                    <FileTextIcon aria-hidden />
                    Open project home
                  </Button>
                  {canSearch ? (
                    <form
                      className="flex gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void search();
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <Input
                          aria-label="Search pages"
                          placeholder="Search this project"
                          value={query}
                          minLength={2}
                          maxLength={200}
                          onChange={(event) => setQuery(event.target.value)}
                        />
                      </div>
                      <Button size="sm" type="submit" disabled={busy || query.trim().length < 2}>
                        Search
                      </Button>
                    </form>
                  ) : null}
                  {busy ? (
                    <p role="status">Searching pages…</p>
                  ) : error ? null : searchedQuery !== null ? (
                    pages.length ? (
                      <>
                        <p className="break-words text-xs text-muted-foreground">
                          {pages.length} results for “{searchedQuery}”
                          {pages.length === 20 ? ". Refine your search to find more." : ""}
                        </p>
                        <ul className="space-y-2" aria-label="Pages in project">
                          {pages.map((page) => (
                            <li key={page.path}>
                              <button
                                type="button"
                                onClick={() => void openPage(page)}
                                className="flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                              >
                                <FileTextIcon
                                  aria-hidden
                                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                                />
                                <span className="min-w-0 space-y-1">
                                  <span className="block break-words font-medium">
                                    {page.title}
                                  </span>
                                  {page.excerpt ? (
                                    <span className="line-clamp-3 block break-words text-xs text-muted-foreground">
                                      {page.excerpt}
                                    </span>
                                  ) : null}
                                  <span className="block break-words text-xs text-muted-foreground">
                                    {page.path}
                                  </span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p className="break-words">
                        No pages match “{searchedQuery}”. Try a different search.
                      </p>
                    )
                  ) : (
                    <p className="text-muted-foreground">
                      {canSearch
                        ? "Search by title or topic to find a page in this project."
                        : "Page search is not available on this connection. Open the project in your browser."}
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="space-y-3">
              {projects.length ? (
                <Input
                  aria-label="Find a project"
                  placeholder="Find a project"
                  value={projectFilter}
                  onChange={(event) => setProjectFilter(event.target.value)}
                />
              ) : null}
              {busy ? (
                <p role="status">Loading projects…</p>
              ) : error ? null : visibleProjects.length ? (
                <ul className="space-y-2" aria-label="Published projects">
                  {visibleProjects.map((item) => (
                    <li key={item.root}>
                      <button
                        type="button"
                        onClick={() => selectProject(item)}
                        className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <FolderIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block break-words font-medium">{item.title}</span>
                          {item.fileCount !== null ? (
                            <span className="text-xs text-muted-foreground">
                              {item.fileCount} published files
                            </span>
                          ) : null}
                        </span>
                        <ChevronRightIcon
                          aria-hidden
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">
                  {projectFilter
                    ? "No projects match your search."
                    : "No published projects are available for this account yet."}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {error ? (
        <div className="mt-3 space-y-2">
          <p role="alert" className="break-words text-destructive">
            {error}
          </p>
          {status?.state === "connected" && !reader ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void (project ? search() : loadProjects())}
              disabled={busy}
            >
              {project ? "Retry search" : "Retry projects"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
