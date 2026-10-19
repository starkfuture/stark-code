import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";

type ConnectionState =
  | "checking"
  | "signed-out"
  | "connecting"
  | "connected"
  | "error"
  | "unavailable";

/** Pages owns its browser sign-in; leaving setup never cancels that connection. */
export function PagesStep({ onContinue }: { readonly onContinue: () => void }) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.publishedPages;
  const [connectionState, setState] = useState<ConnectionState>("checking");
  const state = bridge ? connectionState : "unavailable";
  const [error, setError] = useState("");
  const connect = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!bridge) return;

    let disposed = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = async (startSignIn: boolean) => {
      if (disposed || busy) return;
      busy = true;
      clearTimeout(timer);
      setError("");
      if (startSignIn) setState("connecting");
      let verifying = false;
      try {
        const status = await (startSignIn ? bridge.connect() : bridge.status());
        if (disposed) return;
        if (status.state === "connecting") {
          setState("connecting");
          timer = setTimeout(() => void check(false), 1_000);
          return;
        }
        if (status.state === "connected") {
          verifying = true;
          setState("checking");
          const tools = await bridge.listTools();
          if (disposed) return;
          if (!tools.some((tool) => tool.name === "pages_list_projects")) {
            throw new Error("Pages read access is unavailable");
          }
          // An empty project list is valid. Never retain or render account content here.
          const result = await bridge.read({ tool: "pages_list_projects", arguments: {} });
          if (disposed) return;
          if (result.isError) throw new Error("Pages read check failed");
          setState("connected");
          return;
        }
        if (status.state === "error") throw new Error("Pages sign-in failed");
        setState("signed-out");
      } catch {
        if (disposed) return;
        setError(
          verifying
            ? "Signed in, but Stark Pages could not verify read access. Try again."
            : "Could not connect to Stark Pages. Check your connection and try again.",
        );
        setState("error");
      } finally {
        busy = false;
      }
    };

    connect.current = () => void check(true);
    void check(false);
    return () => {
      disposed = true;
      clearTimeout(timer);
      connect.current = () => undefined;
    };
  }, [bridge]);

  const busy = state === "checking" || state === "connecting";
  const ready = state === "connected";
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Connect Stark Pages</h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Read your team's published pages inside Stark Code. Sign in through your usual browser;
        Stark Code keeps its own connection.
      </p>
      <div className="mt-5 rounded-xl border border-border p-4">
        <p className="text-sm font-medium">Stark Pages</p>
        <p role="status" aria-live="polite" className="mt-1 text-sm text-muted-foreground">
          {state === "unavailable"
            ? "Stark Pages sign-in is available in the desktop app. You can continue setup here."
            : state === "checking"
              ? "Checking Pages access…"
              : state === "connecting"
                ? "Finish signing in through your browser. You can continue setup while it finishes."
                : ready
                  ? "Connected. Your published pages are ready to open."
                  : state === "error"
                    ? "Connection needs attention."
                    : "Connect your account to open published pages."}
        </p>
        {error ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {!ready && state !== "unavailable" ? (
          <div className="mt-4">
            <Button disabled={busy} onClick={() => connect.current()}>
              {state === "error"
                ? "Try again"
                : state === "connecting"
                  ? "Signing in…"
                  : state === "checking"
                    ? "Checking…"
                    : "Connect Stark Pages"}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="mt-6 flex justify-end">
        <Button
          variant={ready || state === "unavailable" ? "default" : "ghost-muted"}
          onClick={onContinue}
        >
          {ready || state === "unavailable" ? "Continue" : "Skip for now"}
        </Button>
      </div>
    </>
  );
}
