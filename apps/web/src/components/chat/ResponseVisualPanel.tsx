import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@starkfuture/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ResponseVisualsInput,
  ResponseVisualsResult,
  ScopedThreadRef,
} from "@starkfuture/contracts";
import { useRef, useState } from "react";
import { responseVisualsEnvironment } from "../../state/responseVisuals";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export interface ReaderAnswer {
  readonly id: string;
  readonly text: string;
  readonly label: string;
}

/** Source stays verbatim; additions never replace the provider's answer. */
export function ResponseVisualPanel(props: {
  environmentId: EnvironmentId;
  answers: ReadonlyArray<ReaderAnswer>;
  cwd: string;
  threadRef: ScopedThreadRef;
  emptyMessage?: string | undefined;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  if (chosen === null && props.answers.length > 0) setChosen(props.answers.at(-1)!.id);
  const selected = props.answers.find((answer) => answer.id === chosen) ?? props.answers.at(-1);
  const answer = chosen === "paste" ? pasted : (selected?.text ?? "");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Reply reader">
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <label className="block text-xs">
          Reply to read
          <select
            aria-label="Reply to read"
            className="mt-1 block w-full rounded-md border border-input bg-background p-2 text-sm"
            value={chosen === "paste" ? "paste" : (selected?.id ?? "")}
            onChange={(event) => setChosen(event.target.value)}
          >
            {props.answers.length === 0 ? <option value="">No completed replies yet</option> : null}
            {props.answers.toReversed().map((item) => (
              <option value={item.id} key={item.id}>
                {item.label}
              </option>
            ))}
            <option value="paste">Paste a reply…</option>
          </select>
        </label>
        {chosen === "paste" ? (
          <details open>
            <summary className="mb-2 cursor-pointer text-xs text-muted-foreground">
              Pasted source (collapse to read)
            </summary>
            <Textarea
              aria-label="Reply text"
              className="max-h-36"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={4}
            />
          </details>
        ) : null}
      </div>
      {answer ? (
        <VisualReader
          key={`${chosen === "paste" ? "paste" : selected?.id}:${answer}`}
          {...props}
          answer={answer}
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          {props.emptyMessage ?? "Choose a completed reply, or paste text to read."}
        </p>
      )}
    </div>
  );
}

function VisualReader(props: {
  environmentId: EnvironmentId;
  answer: string;
  cwd: string;
  threadRef: ScopedThreadRef;
}) {
  const canGenerate = useAtomValue(
    responseVisualsEnvironment.format.permissionAtom(props.environmentId),
  );
  const generate = useAtomCommand(responseVisualsEnvironment.format, { reportFailure: false });
  const [result, setResult] = useState<ResponseVisualsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visualRequest, setVisualRequest] =
    useState<NonNullable<ResponseVisualsInput["visualRequest"]>>("auto");
  const sending = useRef(false);
  const tooLong =
    props.answer.length > 24_000 || new TextEncoder().encode(props.answer).byteLength > 48 * 1024;
  async function makeVisual() {
    if (sending.current || !canGenerate || tooLong) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await generate({
        environmentId: props.environmentId,
        input: { answer: props.answer, visualRequest },
      });
      if (response._tag === "Failure") {
        const cause = squashAtomCommandFailure(response);
        setError(cause instanceof Error ? cause.message : "Could not make this reply visual.");
      } else setResult(response.value);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto p-4" data-reply-reader>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !canGenerate || tooLong}
          onClick={() => void makeVisual()}
        >
          {busy ? "Making visual…" : "Make visual"}
        </Button>
        <select
          aria-label="Visual format"
          className="max-w-full rounded-md border border-input bg-background p-2 text-xs"
          value={visualRequest}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "auto" || value === "table" || value === "flowchart") {
              setVisualRequest(value);
              setResult(null);
            }
          }}
        >
          <option value="auto">Choose useful additions</option>
          <option value="table">Table</option>
          <option value="flowchart">Flowchart</option>
        </select>
        <p className="w-full text-xs text-muted-foreground">
          Reading uses no tokens. Make visual uses Sonnet for this reply only; repeat requests reuse
          its saved result.
        </p>
        {tooLong ? (
          <p className="text-xs text-muted-foreground">
            This reply exceeds the visual limit. Paste a shorter excerpt to make visual.
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {result ? <ResponseVisualOverview result={result} /> : null}
      <div className="min-w-0" aria-label="Original reply">
        {result ? (
          <h3 className="mb-3 text-xs font-medium text-muted-foreground">Original reply</h3>
        ) : null}
        <ChatMarkdown reader text={props.answer} cwd={props.cwd} threadRef={props.threadRef} />
      </div>
    </div>
  );
}

/* oxlint-disable react/no-array-index-key -- Generated tables are immutable and have no row-local state. */
function ResponseVisualOverview({ result }: { result: ResponseVisualsResult }) {
  const usage = result.generationUsage;
  return (
    <section
      className="mb-6 min-w-0 space-y-4 rounded-xl border border-border bg-muted/30 p-4"
      aria-label="AI overview"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          AI overview
        </h3>
        <span className="text-xs text-muted-foreground">
          {result.cacheHit ? "Saved · no new model call" : "Sonnet"}
        </span>
      </div>
      {result.summary ? <p className="text-base leading-relaxed">{result.summary}</p> : null}
      {result.table ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {result.table.columns.map((column, index) => (
                  <th
                    key={`${index}:${column}`}
                    className="border-b border-border px-2 py-2 font-medium"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.table.rows.map((row, index) => (
                <tr key={`${index}:${row.join("|")}`}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${cellIndex}:${cell}`}
                      className="border-b border-border px-2 py-2 align-top break-words"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {result.mermaid ? (
        <ChatMarkdown
          cwd={undefined}
          text={`\x60\x60\x60mermaid\n${result.mermaid}\n\x60\x60\x60`}
        />
      ) : null}
      {result.reason ? <p className="text-sm text-muted-foreground">{result.reason}</p> : null}
      {usage ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Generation usage</summary>
          <p className="mt-2">
            Original call: {usage.freshInputTokens ?? "unreported"} fresh input,{" "}
            {usage.cacheReadInputTokens ?? "unreported"} cache-read,{" "}
            {usage.cacheWriteInputTokens ?? "unreported"} cache-write,{" "}
            {usage.outputTokens ?? "unreported"} output tokens.
            {usage.costUsd === null ? "" : ` CLI-reported cost: $${usage.costUsd.toFixed(4)}.`}
          </p>
        </details>
      ) : null}
    </section>
  );
}

/* oxlint-enable react/no-array-index-key */
