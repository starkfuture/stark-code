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
      <PopoverTrigger render={<Button variant="ghost" size="sm" />}>Connection help</PopoverTrigger>
      <PopoverPopup align="end" width="lg" aria-label="Native MCP controls" finalFocus={false}>
        <div className="space-y-4 text-sm">
          <h3 className="font-medium">{codex ? "Codex connections" : "Claude connections"}</h3>
          <p className="text-xs text-muted-foreground">
            The terminal manages its own connections. Open /mcp there to inspect the affected server
            and its sign-in or recovery options. Healthy connections do not need reloading.
          </p>
          {codex ? (
            <p className="text-xs text-muted-foreground">
              Codex has no live command to reconnect an individual MCP server.
            </p>
          ) : null}
          <Button size="xs" variant="outline" onClick={() => void copy("/mcp")}>
            Copy /mcp
          </Button>
          <p className="text-xs text-muted-foreground">
            When the agent is idle, paste at an empty CLI prompt and press Enter. Stark Code does
            not type commands or restart the session for you.
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
