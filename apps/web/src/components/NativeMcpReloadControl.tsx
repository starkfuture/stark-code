import { useRef, useState } from "react";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

/** A native terminal has no control RPC. Never inject Enter into an unknown CLI prompt. */
export function NativeMcpReloadControl({
  driver,
  onShowTerminal,
}: {
  readonly driver: string;
  readonly onShowTerminal: () => void;
}) {
  const codex = driver === "codex";
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const copying = useRef(false);
  const copy = async (command: string) => {
    if (copying.current) return;
    copying.current = true;
    setError(false);
    setCopied(null);
    try {
      await writeTextToClipboard(command, "native MCP command");
      setCopied(command);
    } catch {
      setError(true);
    } finally {
      copying.current = false;
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
        {codex ? "MCPs" : "Reload MCPs"}
      </PopoverTrigger>
      <PopoverPopup align="end" width="lg" aria-label="Native MCP controls" finalFocus={false}>
        <div className="space-y-4 text-sm">
          <h3 className="font-medium">
            {codex ? "Codex MCP connections" : "Claude MCPs and plugins"}
          </h3>
          {codex ? (
            <p className="text-xs text-muted-foreground">
              Codex's terminal has no live MCP reload command. Use /mcp to inspect connections. To
              load changed configuration, restart Codex and resume your session.
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Reload changed plugins and their MCP servers. Claude will ask before a reload that
                  affects the conversation's prompt cache.
                </p>
                <Button size="xs" variant="outline" onClick={() => void copy("/reload-plugins")}>
                  Copy /reload-plugins
                </Button>
              </div>
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Retry failed connections, including servers waiting for sign-in.
                </p>
                <Button size="xs" variant="outline" onClick={() => void copy("/mcp reconnect all")}>
                  Copy /mcp reconnect all
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Use /mcp to inspect servers or reconnect one specific server.
              </p>
            </>
          )}
          <Button size="xs" variant="outline" onClick={() => void copy("/mcp")}>
            Copy /mcp
          </Button>
          <p className="text-xs text-muted-foreground">
            Paste the command at an empty CLI prompt, then press Enter.
          </p>
          {copied ? (
            <p role="status" className="text-xs">
              Copied {copied}. It has not been run.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              Could not copy the command. Select and copy it manually.
            </p>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setOpen(false);
              onShowTerminal();
            }}
          >
            Show terminal
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
