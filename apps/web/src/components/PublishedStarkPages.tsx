/* oxlint-disable react/no-array-index-key -- MCP content blocks have no item ID; the whole read result is replaced together. */
import { useEffect, useRef, useState } from "react";
import type {
  StarkPublishedPagesReadResult,
  StarkPublishedPagesStatus,
  StarkPublishedPagesTool,
} from "@starkfuture/contracts";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { PublishedPageContent } from "./PublishedPageContent";
import { publishedPageArguments, publishedPageFields } from "./publishedPagesFields";

const labels: Record<StarkPublishedPagesTool["name"], string> = {
  pages_list_projects: "Projects",
  pages_search: "Search pages",
  pages_read_content: "Read page",
  pages_read_file: "Read file",
  pages_get_public_url: "Page link",
};

export function PublishedStarkPages() {
  const bridge = window.desktopBridge?.publishedPages;
  const [status, setStatus] = useState<StarkPublishedPagesStatus | null>(null);
  const [tools, setTools] = useState<readonly StarkPublishedPagesTool[]>([]);
  const [selected, setSelected] = useState<StarkPublishedPagesTool["name"]>("pages_list_projects");
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<StarkPublishedPagesReadResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const tool = tools.find((item) => item.name === selected);
  const fields = tool ? publishedPageFields(tool.inputSchema) : null;

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    let pending = false;
    const check = async () => {
      if (pending) return;
      pending = true;
      const current = generation.current;
      try {
        const next = await bridge.status();
        if (!cancelled && current === generation.current) {
          setStatus(next);
          if (next.state !== "connected") {
            setTools([]);
            setResult(null);
          }
        }
      } catch {
        if (!cancelled)
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
      generation.current += 1;
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge || status?.state !== "connected") return;
    let cancelled = false;
    const current = generation.current;
    const load = async () => {
      try {
        const catalog = await bridge.listTools();
        if (cancelled || current !== generation.current) return;
        setTools(catalog);
        const first = catalog.find((item) => item.name === "pages_list_projects") ?? catalog[0];
        if (first) setSelected(first.name);
        // This observed read needs no project or path. Other tool arguments come from live schemas.
        if (
          first?.name === "pages_list_projects" &&
          publishedPageFields(first.inputSchema)?.every((field) => !field.required)
        ) {
          const projects = await bridge.read({ tool: first.name, arguments: {} });
          if (!cancelled && current === generation.current) setResult(projects);
        }
      } catch {
        if (!cancelled && current === generation.current)
          setError("Could not load your Pages projects. Retry the connection.");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [bridge, status?.state]);

  const connect = async () => {
    if (!bridge) return;
    setError(null);
    setBusy(true);
    try {
      setStatus(await bridge.connect());
    } catch {
      setError("Pages sign-in could not start. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!bridge) return;
    generation.current += 1;
    setBusy(true);
    setResult(null);
    setTools([]);
    setValues({});
    setError(null);
    try {
      setStatus(await bridge.disconnect());
    } catch {
      setError("Could not disconnect Pages. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const read = async () => {
    if (!bridge || !tool || !fields) return;
    const request = ++generation.current;
    setError(null);
    setBusy(true);
    setResult(null);
    try {
      const answer = await bridge.read({
        tool: tool.name,
        arguments: publishedPageArguments(fields, values),
      });
      if (generation.current === request) setResult(answer);
    } catch (failure) {
      if (generation.current === request)
        setError(
          failure instanceof Error && !failure.message.includes("IPC")
            ? failure.message.slice(0, 500)
            : "Pages could not read this page. Check the fields and try again.",
        );
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };

  return (
    <section aria-label="Published Pages" className="min-h-0 flex-1 overflow-auto p-3 text-sm">
      {!bridge ? (
        <p>Open Stark Code on your Mac to connect to published Pages.</p>
      ) : status?.state !== "connected" ? (
        <div className="space-y-3">
          <h3 className="font-medium">Your published Pages</h3>
          <p className="text-muted-foreground">
            Sign in through your browser to read your company’s pages here.
          </p>
          {status?.message ? <p role="status">{status.message}</p> : null}
          {status?.state === "connecting" ? (
            <Button size="sm" variant="outline" onClick={() => void disconnect()} disabled={busy}>
              Cancel sign-in
            </Button>
          ) : (
            <Button size="sm" onClick={() => void connect()} disabled={busy || status === null}>
              Connect Pages
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Pages connected</span>
            <Button size="sm" variant="ghost" onClick={() => void disconnect()} disabled={busy}>
              Disconnect
            </Button>
          </div>
          {tools.length ? (
            <>
              <Select
                value={selected}
                onValueChange={(value) => {
                  if (!value) return;
                  generation.current += 1;
                  setSelected(value);
                  setValues({});
                  setResult(null);
                  setError(null);
                  setBusy(false);
                }}
              >
                <SelectTrigger aria-label="Published Pages action">
                  <SelectValue>{tool ? labels[tool.name] : "Choose an action"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {tools.map((item) => (
                    <SelectItem key={item.name} value={item.name}>
                      {labels[item.name]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {fields ? (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void read();
                  }}
                >
                  {fields.map((field) => (
                    <label key={`${selected}:${field.name}`} className="block space-y-1">
                      <span>
                        {field.label}
                        {field.required ? "" : " (optional)"}
                      </span>
                      {field.type === "boolean" || field.choices ? (
                        <Select
                          value={values[field.name] ?? ""}
                          onValueChange={(value) =>
                            setValues((current) => ({ ...current, [field.name]: value ?? "" }))
                          }
                        >
                          <SelectTrigger aria-label={field.label}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopup>
                            {!field.required ? <SelectItem value="">Default</SelectItem> : null}
                            {(field.choices ?? ["true", "false"]).map((value) => (
                              <SelectItem key={value} value={value}>
                                {value === "true" ? "Yes" : value === "false" ? "No" : value}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      ) : (
                        <Input
                          value={values[field.name] ?? ""}
                          onChange={(event) =>
                            setValues((current) => ({
                              ...current,
                              [field.name]: event.target.value,
                            }))
                          }
                          required={field.required}
                          type={field.type === "string" ? "text" : "number"}
                          step={field.type === "integer" ? "1" : "any"}
                          maxLength={8192}
                        />
                      )}
                      {field.description ? (
                        <span className="block text-xs text-muted-foreground">
                          {field.description}
                        </span>
                      ) : null}
                    </label>
                  ))}
                  <Button size="sm" type="submit" disabled={busy}>
                    {busy
                      ? "Loading…"
                      : selected === "pages_list_projects"
                        ? "Refresh projects"
                        : labels[selected]}
                  </Button>
                </form>
              ) : (
                <p>
                  This page needs fields that this version cannot display. Open it in Pages through
                  your browser.
                </p>
              )}
            </>
          ) : (
            <p>No supported page-reading tools are available on this connection.</p>
          )}
          {result ? (
            <div
              aria-label="Published page result"
              className="space-y-3 border-t border-border pt-3"
            >
              {result.isError ? <p role="alert">Pages could not complete this read.</p> : null}
              {result.structuredContent !== undefined ? (
                <PublishedPageContent value={result.structuredContent} />
              ) : (
                result.content.map((item, index) => (
                  <PublishedPageContent key={index} value={item.text} />
                ))
              )}
            </div>
          ) : null}
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
