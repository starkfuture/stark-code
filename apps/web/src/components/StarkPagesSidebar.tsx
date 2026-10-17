/* oxlint-disable react/iframe-missing-sandbox -- This fixed loopback frame is cross-origin from the app and must run the mirror scripts. */
import { useEffect, useRef, useState } from "react";
import {
  isMirrorFollowUrl,
  isOpenableStarkPageLink,
  parseStarkPagesMessage,
  type StarkPagesMirror,
} from "@starkfuture/shared/starkPages";
import { Button } from "./ui/button";
import type { StarkPageTarget } from "../starkPageTabs";

const EMPTY = "No pages yet. Ask Claude for a decision or a report, or run /stark-workbench:page.";

export function StarkPagesSidebar(props: {
  readonly projectRoot: string;
  readonly agent: "claude" | "codex";
  readonly canPublish: boolean;
  readonly onPublishRequest: (slug: string, title: string) => void;
  readonly onClose: () => void;
  readonly showHeader?: boolean;
  readonly initialSlug?: string;
  readonly active?: boolean;
  readonly onOpenPage?: ((page: StarkPageTarget) => void) | undefined;
}) {
  const {
    projectRoot,
    agent,
    canPublish,
    onPublishRequest,
    onClose,
    initialSlug,
    active = true,
    onOpenPage,
  } = props;
  const publishingEnabled = canPublish && agent === "claude";
  const frame = useRef<HTMLIFrameElement>(null);
  const trusted = useRef<{ key: string; ready: boolean } | null>(null);
  const connectionTimer = useRef<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [discovery, setDiscovery] = useState<{
    projectRoot: string;
    retry: number;
    mirror: StarkPagesMirror | null;
    startFailed: boolean;
  } | null>(null);
  const [notice, setNotice] = useState<{ key: string; message: string } | null>(null);
  const [selectedPage, setSelectedPage] = useState<{
    key: string;
    page: Extract<StarkPageTarget, { kind: "local" }>;
  } | null>(null);
  const mirror =
    discovery?.projectRoot === projectRoot && discovery.retry === retry ? discovery.mirror : null;
  const origin = mirror ? `http://127.0.0.1:${mirror.port}` : null;

  const panelKey = `${projectRoot}:${origin ?? ""}:${initialSlug ?? ""}:${retry}`;
  const shownSlug = useRef<string | null>(null);
  const mirrorRoot = mirror?.root;
  const mirrorPort = mirror?.port;
  const activeNotice =
    notice?.key === panelKey
      ? notice.message
      : discovery?.projectRoot === projectRoot && discovery.retry === retry && discovery.startFailed
        ? "Pages could not start. Retry, or reopen Stark Code if the problem continues."
        : null;

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const check = async (start = false) => {
      if (pending) return;
      pending = true;
      try {
        const ensure = window.desktopBridge?.ensureStarkPagesMirror;
        const result =
          (await (start && ensure
            ? ensure(projectRoot)
            : window.desktopBridge?.getStarkPagesMirror?.(projectRoot))) ?? null;
        if (!cancelled)
          setDiscovery((previous) => ({
            projectRoot,
            retry,
            mirror: result,
            startFailed:
              result !== null
                ? false
                : start && ensure !== undefined
                  ? true
                  : (previous?.startFailed ?? false),
          }));
      } catch {
        if (!cancelled) setDiscovery({ projectRoot, retry, mirror: null, startFailed: true });
      } finally {
        pending = false;
      }
    };
    void check(true);
    const timer = window.setInterval(() => {
      void check();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectRoot, retry]);

  useEffect(() => {
    trusted.current = { key: panelKey, ready: false };
    shownSlug.current = null;
  }, [panelKey]);
  useEffect(() => {
    if (!origin) return;
    connectionTimer.current = window.setTimeout(() => {
      if (trusted.current?.key === panelKey && trusted.current.ready) return;
      setNotice({
        key: panelKey,
        message: "The Pages panel did not connect. Retry Pages to reconnect.",
      });
    }, 8000);
    return () => {
      if (connectionTimer.current !== null) window.clearTimeout(connectionTimer.current);
      connectionTimer.current = null;
    };
  }, [origin, panelKey]);
  useEffect(() => {
    if (!origin || mirrorRoot === undefined || mirrorPort === undefined) return;
    const sendHost = () => {
      if (trusted.current?.key === panelKey && trusted.current.ready)
        frame.current?.contentWindow?.postMessage(
          {
            v: 1,
            source: "stark-host",
            type: "host",
            canPublish: publishingEnabled,
            agent: agent,
          },
          origin,
        );
    };
    const sendShow = () => {
      if (initialSlug && trusted.current?.key === panelKey && trusted.current.ready)
        frame.current?.contentWindow?.postMessage(
          { v: 1, source: "stark-host", type: "show", slug: initialSlug },
          origin,
        );
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      const message = parseStarkPagesMessage(event.data);
      if (!message) return;
      if (message.type === "ready") {
        if (message.root !== mirrorRoot || message.port !== mirrorPort) {
          trusted.current = { key: panelKey, ready: false };
          setNotice({
            key: panelKey,
            message: "The pages panel belongs to a different project. Reopen Pages to try again.",
          });
          return;
        }
        trusted.current = { key: panelKey, ready: true };
        if (connectionTimer.current !== null) window.clearTimeout(connectionTimer.current);
        connectionTimer.current = null;
        setNotice(null);
        sendHost();
        // A named tab belongs to one page. Do not let mirror events replace it
        // with a newly generated page while the user reads another tab.
        if (initialSlug)
          frame.current?.contentWindow?.postMessage(
            { v: 1, source: "stark-host", type: "pause" },
            origin,
          );
        return;
      }
      if (trusted.current?.key !== panelKey || !trusted.current.ready) return;
      if (message.type === "show") {
        shownSlug.current = message.page.slug;
        const page = { kind: "local" as const, ...message.page };
        if (initialSlug) {
          if (active) onOpenPage?.(page);
        } else {
          // The mirror follows new pages automatically. Opening a tab is an
          // explicit user action, never a side effect of that background feed.
          setSelectedPage({ key: panelKey, page });
        }
      } else if (message.type === "publish-request") {
        if (!active) return;
        if (!publishingEnabled) {
          setNotice({
            key: panelKey,
            message: "Publishing works in native Claude shell mode with the Stark plugin loaded.",
          });
          return;
        }
        // This stages text only. The user sends it, and the plugin's publish guard still asks.
        onPublishRequest(message.page.slug, message.page.title);
      } else if (message.type === "open-external" && isMirrorFollowUrl(message.url, mirrorPort)) {
        void window.desktopBridge
          ?.openStarkPagesExternal?.({ projectRoot, url: message.url })
          .then((opened) => {
            if (!opened)
              setNotice({
                key: panelKey,
                message:
                  "Could not open this page in your browser. Retry after the mirror reconnects.",
              });
          })
          .catch(() => {
            setNotice({ key: panelKey, message: "Could not open this page in your browser." });
          });
      } else if (message.type === "open-link" && isOpenableStarkPageLink(message.url)) {
        void window.desktopBridge
          ?.openStarkPagesLink?.(message.url)
          .then((opened) => {
            if (!opened)
              setNotice({ key: panelKey, message: "Could not open this link in your browser." });
          })
          .catch(() => {
            setNotice({ key: panelKey, message: "Could not open this link in your browser." });
          });
      }
    };
    window.addEventListener("message", onMessage);
    sendHost();
    if (active && initialSlug && shownSlug.current !== initialSlug) sendShow();
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [
    origin,
    mirrorRoot,
    mirrorPort,
    panelKey,
    projectRoot,
    agent,
    publishingEnabled,
    onPublishRequest,
    initialSlug,
    active,
    onOpenPage,
  ]);

  return (
    <aside
      aria-label="Stark Pages"
      className="flex h-full min-h-0 w-full flex-col border-l border-border bg-background"
    >
      {props.showHeader !== false ? (
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-medium">Pages</span>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : null}
      {activeNotice ? (
        <div className="space-y-2 border-b border-border px-3 py-2 text-sm text-muted-foreground">
          <p role="status">{activeNotice}</p>
          <Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>
            Retry Pages
          </Button>
        </div>
      ) : null}
      {onOpenPage && !initialSlug && selectedPage?.key === panelKey && origin ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm">{selectedPage.page.title}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={!active}
            onClick={() => onOpenPage(selectedPage.page)}
          >
            Open page in tab
          </Button>
        </div>
      ) : null}
      {origin && mirror ? (
        <iframe
          key={panelKey}
          ref={frame}
          src={`${origin}/panel${initialSlug ? `?slug=${encodeURIComponent(initialSlug)}` : ""}`}
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerPolicy="no-referrer"
          title="Stark pages"
          className="h-full min-h-0 w-full flex-1 border-0"
        />
      ) : (
        <div className="space-y-3 p-4 text-sm text-muted-foreground">
          <p>
            {window.desktopBridge?.ensureStarkPagesMirror &&
            (discovery?.projectRoot !== projectRoot || discovery.retry !== retry)
              ? "Starting Pages…"
              : EMPTY}
          </p>
          {!window.desktopBridge?.getStarkPagesMirror ? (
            <p>Open this project in the Stark Code desktop app to view its pages.</p>
          ) : null}
        </div>
      )}
    </aside>
  );
}
