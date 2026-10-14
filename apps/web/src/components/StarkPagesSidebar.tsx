/* oxlint-disable react/iframe-missing-sandbox -- This fixed loopback frame is cross-origin from the app and must run the mirror scripts. */
import { useEffect, useRef, useState } from "react";
import {
  isMirrorFollowUrl,
  isOpenableStarkPageLink,
  parseStarkPagesMessage,
  type StarkPagesMirror,
} from "@starkfuture/shared/starkPages";
import { Button } from "./ui/button";

const EMPTY = "No pages yet. Ask Claude for a decision or a report, or run /stark-workbench:page.";

export function StarkPagesSidebar(props: {
  readonly projectRoot: string;
  readonly agent: "claude" | "codex";
  readonly canPublish: boolean;
  readonly onPublishRequest: (slug: string, title: string) => void;
  readonly onClose: () => void;
}) {
  const { projectRoot, agent, canPublish, onPublishRequest, onClose } = props;
  const frame = useRef<HTMLIFrameElement>(null);
  const trusted = useRef<{ key: string; ready: boolean } | null>(null);
  const [discovery, setDiscovery] = useState<{
    projectRoot: string;
    mirror: StarkPagesMirror | null;
  } | null>(null);
  const [notice, setNotice] = useState<{ key: string; message: string } | null>(null);
  const mirror = discovery?.projectRoot === projectRoot ? discovery.mirror : null;
  const origin = mirror ? `http://127.0.0.1:${mirror.port}` : null;

  const panelKey = `${projectRoot}:${origin ?? ""}`;
  const mirrorRoot = mirror?.root;
  const mirrorPort = mirror?.port;
  const activeNotice = notice?.key === panelKey ? notice.message : null;

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const check = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = (await window.desktopBridge?.getStarkPagesMirror?.(projectRoot)) ?? null;
        if (!cancelled) setDiscovery({ projectRoot: projectRoot, mirror: result });
      } catch {
        if (!cancelled) setDiscovery({ projectRoot: projectRoot, mirror: null });
      } finally {
        pending = false;
      }
    };
    void check();
    const timer = window.setInterval(() => {
      void check();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectRoot]);

  useEffect(() => {
    trusted.current = { key: panelKey, ready: false };
  }, [panelKey]);
  useEffect(() => {
    if (!origin || mirrorRoot === undefined || mirrorPort === undefined) return;
    const sendHost = () => {
      if (trusted.current?.key === panelKey && trusted.current.ready)
        frame.current?.contentWindow?.postMessage(
          {
            v: 1,
            source: "stark-host",
            type: "host",
            canPublish: canPublish,
            agent: agent,
          },
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
        setNotice(null);
        sendHost();
        return;
      }
      if (trusted.current?.key !== panelKey || !trusted.current.ready) return;
      if (message.type === "publish-request") {
        if (!canPublish) {
          setNotice({
            key: panelKey,
            message: "Publishing works in a Claude thread with the Stark plugin loaded.",
          });
          return;
        }
        // This stages text only. The user sends it, and the plugin's publish guard still asks.
        onPublishRequest(message.page.slug, message.page.title);
      } else if (message.type === "open-external" && isMirrorFollowUrl(message.url, mirrorPort)) {
        void window.desktopBridge?.openStarkPagesExternal?.({
          projectRoot: projectRoot,
          url: message.url,
        });
      } else if (message.type === "open-link" && isOpenableStarkPageLink(message.url)) {
        void window.desktopBridge?.openStarkPagesLink?.(message.url);
      }
    };
    window.addEventListener("message", onMessage);
    sendHost();
    return () => window.removeEventListener("message", onMessage);
  }, [origin, mirrorRoot, mirrorPort, panelKey, projectRoot, agent, canPublish, onPublishRequest]);

  return (
    <aside
      aria-label="Stark Pages"
      className="flex h-full min-h-0 w-full flex-col border-l border-border bg-background"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-medium">Pages</span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {activeNotice ? (
        <p role="status" className="border-b border-border px-3 py-2 text-sm text-muted-foreground">
          {activeNotice}
        </p>
      ) : null}
      {origin && mirror ? (
        <iframe
          key={`${mirror.root}:${mirror.port}`}
          ref={frame}
          src={`${origin}/panel`}
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerPolicy="no-referrer"
          title="Stark pages"
          className="h-full min-h-0 w-full flex-1 border-0"
        />
      ) : (
        <div className="space-y-3 p-4 text-sm text-muted-foreground">
          <p>{EMPTY}</p>
          {agent === "codex" ? (
            <p>
              Pages from Codex appear once the mirror runs. Run spage serve in the project folder.
            </p>
          ) : null}
          {!window.desktopBridge?.getStarkPagesMirror ? (
            <p>Open this project in the Stark Code desktop app to view its pages.</p>
          ) : null}
        </div>
      )}
    </aside>
  );
}
