/**
 * Drives one Managed Agents session to completion, independent of transport (real SDK or labelled fake).
 *
 * Key properties:
 *  - Stream-first, then history (events.list): lossless (re)connect.
 *  - All client state is DERIVED FROM SERVER HISTORY and rebuilt on every (re)connect. A send that failed or
 *    whose acknowledgement was lost is therefore re-evaluated against what the server actually recorded:
 *    re-sent if missing, never duplicated if present. Phase messages carry markers; tool results and
 *    confirmations are matched by event id. Re-driving after a crash or laptop sleep is the same code path.
 *  - Correct idle gate: requires_action -> answer and keep going; end_turn -> next phase or done;
 *    budget_reached -> stop (platform cap hit); retries_exhausted/refusal -> failed.
 *  - A phase must produce a valid assessment (one reminder allowed) before the next phase is revealed;
 *    otherwise the run ends as failed instead of showing, e.g., the onboarding proposal early.
 *  - Local wall-clock deadline and stop control send user.interrupt (the platform budget still applies).
 */
import { normalizeWs, sleep } from "../util.ts";
import type { Submission } from "./types.ts";

export interface DriverEvent {
  id: string;
  type: string;
  [k: string]: any;
}

export interface SessionInfo {
  status: string;
  listCostCents: number | null;
  usage: Record<string, unknown> | null;
  budgetCents: number | null;
}

export interface StreamHandle {
  iterator: AsyncIterable<DriverEvent>;
  close(): void;
}

export interface SessionApi {
  stream(sessionId: string): Promise<StreamHandle>;
  listEvents(sessionId: string): Promise<DriverEvent[]>;
  send(sessionId: string, events: Array<Record<string, unknown>>): Promise<void>;
  retrieve(sessionId: string): Promise<SessionInfo>;
}

export type DriveStatus = "completed" | "budget_reached" | "timed_out" | "stopped" | "failed" | "terminated";

export interface ToolLogEntry {
  command: string;
  output: string;
  isError: boolean;
}

export interface DriveResult {
  status: DriveStatus;
  reason?: string;
  submissions: Submission[];
  toolLog: ToolLogEntry[];
  deniedAsks: number;
  invalidSubmissions: number;
  errors: string[];
  lastUsage: Record<string, any> | null;
}

export interface DriveOptions {
  jobId: number;
  phases: string[];
  deadlineMs: number;
  shouldStop: () => boolean;
  validate: (input: unknown) => { ok: true; value: Submission } | { ok: false; errors: string[] };
  log?: (msg: string) => void;
  maxReconnects?: number;
  /** test hook: called after each processed event; throwing simulates a crash */
  onEvent?: (ev: DriverEvent) => void;
}

export const phaseMarker = (jobId: number, phase: number) => `[lookout job=${jobId} phase=${phase}]`;
const reminderMarker = (jobId: number, phase: number) => `[lookout job=${jobId} phase=${phase} reminder]`;

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((b: any) => (b?.type === "text" ? String(b.text ?? "") : ""))
        .filter(Boolean)
        .join("\n")
    : "";

type Verdict = { status: DriveStatus; reason?: string };
type Validation = ReturnType<DriveOptions["validate"]>;

/** Everything the driver knows about the session, derived from its event history. */
class SessionState {
  seen = new Set<string>();
  phaseSent: boolean[];
  reminded: boolean[];
  subsPerPhase: number[];
  currentPhase = -1;
  customInputs = new Map<string, { v: Validation; phase: number; name: string }>();
  pendingCustom = new Map<string, DriverEvent>();
  answeredCustom = new Set<string>();
  pendingAsk = new Map<string, DriverEvent>();
  answeredAsk = new Set<string>();
  submissions = new Map<string, Submission>();
  bashUses = new Map<string, string>();
  unpairedBash: string[] = [];
  toolLog: ToolLogEntry[] = [];
  latestIdle: { type: string } | null = null;
  terminated = false;
  lastUsage: Record<string, any> | null = null;
  invalid = 0;
  deniedAsks = 0;
  sessionErrors: string[] = [];
  private jobId: number;
  private validate: DriveOptions["validate"];

  constructor(phases: number, jobId: number, validate: DriveOptions["validate"]) {
    this.phaseSent = new Array<boolean>(phases).fill(false);
    this.reminded = new Array<boolean>(phases).fill(false);
    this.subsPerPhase = new Array<number>(phases).fill(0);
    this.jobId = jobId;
    this.validate = validate;
  }

  accept(id: string): void {
    const c = this.customInputs.get(id);
    if (!c || !c.v.ok || this.submissions.has(id)) return;
    this.submissions.set(id, c.v.value);
    if (c.phase >= 0) this.subsPerPhase[c.phase]++;
  }

  process(ev: DriverEvent): void {
    switch (ev.type) {
      case "user.message": {
        const text = textOf(ev.content);
        for (let i = 0; i < this.phaseSent.length; i++) {
          if (text.includes(phaseMarker(this.jobId, i))) {
            this.phaseSent[i] = true;
            this.currentPhase = Math.max(this.currentPhase, i);
          }
          if (text.includes(reminderMarker(this.jobId, i))) this.reminded[i] = true;
        }
        this.latestIdle = null;
        break;
      }
      case "session.status_running":
      case "session.status_rescheduled":
        this.latestIdle = null;
        break;
      case "session.status_idle":
        this.latestIdle = ev.stop_reason ?? { type: "end_turn" };
        break;
      case "session.status_terminated":
        this.terminated = true;
        break;
      case "agent.custom_tool_use":
        this.customInputs.set(ev.id, {
          v: ev.name === "submit_assessment" ? this.validate(ev.input) : { ok: false, errors: ["unknown tool"] },
          phase: this.currentPhase,
          name: ev.name,
        });
        if (!this.answeredCustom.has(ev.id)) this.pendingCustom.set(ev.id, ev);
        break;
      case "user.custom_tool_result":
        this.answeredCustom.add(ev.custom_tool_use_id);
        this.pendingCustom.delete(ev.custom_tool_use_id);
        if (ev.is_error) {
          if (this.customInputs.get(ev.custom_tool_use_id)?.name === "submit_assessment") this.invalid++;
        } else this.accept(ev.custom_tool_use_id);
        break;
      case "agent.tool_use":
      case "agent.mcp_tool_use":
        if (ev.evaluated_permission === "ask" && !this.answeredAsk.has(ev.id)) this.pendingAsk.set(ev.id, ev);
        if (ev.type === "agent.tool_use" && ev.name === "bash") {
          this.bashUses.set(ev.id, String(ev.input?.command ?? ""));
          this.unpairedBash.push(ev.id);
        }
        break;
      case "user.tool_confirmation":
        this.answeredAsk.add(ev.tool_use_id);
        this.pendingAsk.delete(ev.tool_use_id);
        if (ev.result === "deny") this.deniedAsks++;
        break;
      case "agent.tool_result": {
        let useId: string | undefined = this.bashUses.has(ev.tool_use_id) ? ev.tool_use_id : undefined;
        // Fallback pairing if the result references a different id space: most recent unpaired bash call.
        if (!useId && this.unpairedBash.length && !String(ev.tool_use_id ?? "").startsWith("sevt_")) useId = this.unpairedBash[this.unpairedBash.length - 1];
        if (useId) {
          const idx = this.unpairedBash.indexOf(useId);
          if (idx >= 0) this.unpairedBash.splice(idx, 1);
          this.toolLog.push({ command: this.bashUses.get(useId) ?? "", output: textOf(ev.content), isError: Boolean(ev.is_error) });
        }
        break;
      }
      case "session.usage":
        this.lastUsage = ev.usage ?? null;
        break;
      case "session.error":
        this.sessionErrors.push(`${ev.error?.type ?? "error"}: ${ev.error?.message ?? JSON.stringify(ev.error ?? {})}`);
        break;
    }
  }
}

export async function driveSession(api: SessionApi, sessionId: string, o: DriveOptions): Promise<DriveResult> {
  const log = o.log ?? (() => {});
  const transportErrors: string[] = [];
  let interruptSent: "deadline" | "stop" | null = null;
  let interruptAt = 0;
  let st = new SessionState(o.phases.length, o.jobId, o.validate);
  const send = async (events: Array<Record<string, unknown>>) => api.send(sessionId, events);

  /** Decide and perform the next client action. Local marks are set only after a send succeeds. */
  async function advance(): Promise<Verdict | null> {
    if (st.terminated) return { status: "terminated", reason: "session terminated" };

    for (const [id, ev] of [...st.pendingCustom]) {
      if (ev.name !== "submit_assessment") {
        await send([{ type: "user.custom_tool_result", custom_tool_use_id: id, is_error: true, content: [{ type: "text", text: `Unknown tool ${ev.name}.` }] }]);
      } else {
        const v = st.customInputs.get(id)?.v ?? o.validate(ev.input);
        const tooMany = !v.ok && st.invalid >= 3;
        const text = v.ok
          ? "Recorded. If this phase is complete, end your turn now."
          : tooMany
            ? "Too many invalid submissions; end your turn."
            : `Invalid submission, fix and call submit_assessment again:\n- ${v.errors.slice(0, 20).join("\n- ")}`;
        await send([{ type: "user.custom_tool_result", custom_tool_use_id: id, ...(v.ok ? {} : { is_error: true }), content: [{ type: "text", text }] }]);
        if (v.ok) st.accept(id); // counts (invalid, denials) are derived from the server's echo, not counted here
      }
      st.pendingCustom.delete(id);
      st.answeredCustom.add(id);
    }

    for (const [id] of [...st.pendingAsk]) {
      await send([
        {
          type: "user.tool_confirmation",
          tool_use_id: id,
          result: "deny",
          deny_message: "Unattended oversight run: actions that need approval are denied. Continue with read-only inspection and sandbox-local experiments.",
        },
      ]);
      st.pendingAsk.delete(id);
      st.answeredAsk.add(id);
    }

    if (!st.phaseSent[0] && !interruptSent) {
      await send([{ type: "user.message", content: [{ type: "text", text: `${phaseMarker(o.jobId, 0)}\n${o.phases[0]}` }] }]);
      st.phaseSent[0] = true;
      st.currentPhase = 0;
      return null;
    }

    if (!st.latestIdle) return null;
    const idle = st.latestIdle as { type: string };
    if (idle.type === "requires_action") return null; // answered above; wait for the agent
    if (idle.type === "budget_reached") return { status: "budget_reached", reason: "session budget cap reached (platform-enforced)" };
    if (idle.type === "retries_exhausted" || idle.type === "refusal") return { status: "failed", reason: idle.type };
    // end_turn
    if (interruptSent) return { status: interruptSent === "stop" ? "stopped" : "timed_out", reason: `interrupted (${interruptSent})` };
    const cur = st.currentPhase;
    if (cur >= 0 && st.subsPerPhase[cur] === 0) {
      if (!st.reminded[cur]) {
        await send([
          {
            type: "user.message",
            content: [{ type: "text", text: `${reminderMarker(o.jobId, cur)}\nYou ended the turn without a valid submit_assessment call. Call it now (an empty findings list is fine), then end your turn.` }],
          },
        ]);
        st.reminded[cur] = true;
        st.latestIdle = null;
        return null;
      }
      // Do not reveal the next phase (e.g. the onboarding proposal) without an assessment for this one.
      return { status: "failed", reason: `no valid assessment for phase ${cur}` };
    }
    const next = st.phaseSent.findIndex((s) => !s);
    if (next >= 0) {
      await send([{ type: "user.message", content: [{ type: "text", text: `${phaseMarker(o.jobId, next)}\n${o.phases[next]}` }] }]);
      st.phaseSent[next] = true;
      st.currentPhase = next;
      st.latestIdle = null;
      return null;
    }
    return { status: "completed" };
  }

  const result = (r: Verdict): DriveResult => ({
    status: r.status,
    reason: r.reason,
    submissions: [...st.submissions.values()],
    toolLog: st.toolLog,
    deniedAsks: st.deniedAsks,
    invalidSubmissions: st.invalid,
    errors: [...st.sessionErrors, ...transportErrors],
    lastUsage: st.lastUsage,
  });

  async function checkControls(): Promise<Verdict | null> {
    if (!interruptSent) {
      const why = o.shouldStop() ? "stop" : Date.now() > o.deadlineMs ? "deadline" : null;
      if (why) {
        interruptSent = why;
        interruptAt = Date.now();
        log(`sending user.interrupt (${why})`);
        try {
          await send([{ type: "user.interrupt" }]);
        } catch (e) {
          transportErrors.push(`interrupt failed: ${(e as Error).message}`);
        }
      }
    } else if (Date.now() - interruptAt > 60_000) {
      return { status: interruptSent === "stop" ? "stopped" : "timed_out", reason: "no idle within 60s after interrupt" };
    }
    return null;
  }

  const maxReconnects = o.maxReconnects ?? 6;
  for (let attempt = 0; attempt <= maxReconnects; attempt++) {
    let handle: StreamHandle | null = null;
    let timer: NodeJS.Timeout | null = null;
    try {
      handle = await api.stream(sessionId); // stream first: it buffers while we read history
      st = new SessionState(o.phases.length, o.jobId, o.validate); // rebuild from what the server recorded
      for (const ev of await api.listEvents(sessionId)) {
        if (st.seen.has(ev.id)) continue;
        st.seen.add(ev.id);
        st.process(ev);
        o.onEvent?.(ev);
      }
      const early = (await checkControls()) ?? (await advance());
      if (early) return result(early);

      // Wake periodically even when the stream is quiet so deadlines/stop requests are honoured.
      let wake: Verdict | null = null;
      const h = handle;
      timer = setInterval(() => {
        void checkControls().then((r) => {
          if (r) {
            wake = r;
            h.close();
          }
        });
      }, 1000);

      for await (const ev of handle.iterator) {
        if (!ev.id) continue; // stream-only preview events
        if (!st.seen.has(ev.id)) {
          st.seen.add(ev.id);
          st.process(ev);
          o.onEvent?.(ev);
        }
        const r = (await checkControls()) ?? (await advance());
        if (r) return result(r);
      }
      if (wake) return result(wake);
      log("stream ended without a terminal event; reconnecting with history consolidation");
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      if ((err as any)?.simulatedCrash) throw err;
      transportErrors.push(`stream/send: ${msg}`);
      log(`stream or send error (${msg}); reconnecting and re-reading server history`);
    } finally {
      if (timer) clearInterval(timer);
      handle?.close();
    }
    await sleep(Math.min(500 * 2 ** attempt, 8000));
  }
  return result({ status: "failed", reason: "stream reconnect limit reached" });
}

/** Commands are compared exactly, after normalising whitespace and dropping leading `cd <dir> &&` hops. */
export const normalizeCommand = (c: string): string =>
  normalizeWs(c)
    .replace(/^(?:cd\s+\S+\s*&&\s*)+/, "")
    .trim();

/** Minimum substance for a quote/excerpt to count as evidence (an empty or "..." excerpt proves nothing). */
export const MIN_EVIDENCE_CHARS = 12;
const substance = (pieces: string[]) => pieces.join("").replace(/\s/g, "").length;

/** Grounding helper: did this session run exactly this command, and does its output contain the excerpt (in order)? */
export function toolLogContains(log: ToolLogEntry[], command: string, excerpt: string): boolean {
  const c = normalizeCommand(command);
  const pieces = normalizeWs(excerpt).split(/\s*(?:\.\.\.|…)\s*/).filter(Boolean);
  if (!c || substance(pieces) < 8) return false;
  return log.some((e) => {
    if (normalizeCommand(e.command) !== c) return false;
    const out = normalizeWs(e.output);
    let from = 0;
    for (const p of pieces) {
      const at = out.indexOf(p, from);
      if (at < 0) return false;
      from = at + p.length;
    }
    return true;
  });
}
