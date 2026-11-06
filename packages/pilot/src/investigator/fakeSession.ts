/**
 * OFFLINE FAKE of the Managed Agents session event protocol. NOT a hosted integration.
 *
 * It replays a scripted "remote" side (hand-written fixture turns) using the documented event shapes
 * (agent.custom_tool_use, session.status_idle with stop_reason, session.usage, budget pre-request gate,
 * SSE without replay) so the real client code - sessionDriver.ts - can be exercised without API access.
 * State is persisted to a JSON file to emulate server-side persistence across watcher restarts.
 */
import fs from "node:fs";
import path from "node:path";
import { sleep } from "../util.ts";
import type { DriverEvent, SessionApi, SessionInfo, StreamHandle } from "./sessionDriver.ts";

export interface FakeTurn {
  costCents?: number;
  toolLog?: Array<{ command: string; output: string; isError?: boolean }>;
  submission?: unknown;
  message?: string;
  askTool?: boolean;
  dropStreamAfter?: number;
}

export interface FakeScript {
  label: string;
  turns: FakeTurn[];
  budgetCents?: number | null;
}

interface Persisted {
  id: string;
  label: string;
  events: DriverEvent[];
  seq: number;
  spentCents: number;
  budgetCents: number | null;
  turnsStarted: number;
  active: null | { turn: number; step: number; waiting: null | "custom" | "ask"; reminder: boolean; aborted: boolean };
  status: "idle" | "running" | "terminated";
  paused: boolean;
  dropped?: number[];
  script: FakeScript;
}

type Sub = { push: (ev: DriverEvent) => void; fail: (err: Error) => void; delivered: number };

export class FakeSessionServer {
  private s: Persisted;
  private subs = new Set<Sub>();
  private file: string | null;
  private stepMs: number;
  private running = false;

  constructor(opts: { id: string; script?: FakeScript; file?: string | null; stepMs?: number }) {
    this.file = opts.file ?? null;
    this.stepMs = opts.stepMs ?? 5;
    if (this.file && fs.existsSync(this.file)) {
      this.s = JSON.parse(fs.readFileSync(this.file, "utf8")) as Persisted;
    } else {
      if (!opts.script) throw new Error("FakeSessionServer: script required for a new session");
      this.s = {
        id: opts.id,
        label: opts.script.label,
        events: [],
        seq: 0,
        spentCents: 0,
        budgetCents: opts.script.budgetCents ?? null,
        turnsStarted: 0,
        active: null,
        status: "idle",
        paused: false,
        script: opts.script,
      };
      this.persist();
    }
    // Resume a turn that was mid-flight when the process died (the "server" kept its state on disk).
    if (this.s.active && !this.s.active.waiting && !this.s.paused) void this.runTurn();
  }

  get id(): string {
    return this.s.id;
  }

  private persist(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.s));
    fs.renameSync(tmp, this.file);
  }

  private emit(partial: { type: string; id?: string; [k: string]: any }): DriverEvent {
    const ev: DriverEvent = { ...partial, id: partial.id ?? `sevt_fake_${this.s.id.slice(-6)}_${++this.s.seq}`, processed_at: new Date().toISOString() };
    this.s.events.push(ev);
    this.persist();
    for (const sub of [...this.subs]) sub.push(ev);
    return ev;
  }

  private usageSnapshot() {
    return {
      input_tokens: 0,
      output_tokens: 0,
      list_cost: { amount: String(Math.round(this.s.spentCents)), currency: "USD" },
      active_seconds: 0,
      simulated: true,
    };
  }

  /** Pre-request budget gate, like the platform: the request that crosses the cap still completes. */
  private gate(costCents: number): boolean {
    if (this.s.budgetCents !== null && this.s.spentCents >= this.s.budgetCents) {
      this.emit({ type: "session.thread_status_idle", stop_reason: { type: "budget_reached" } });
      this.emit({ type: "session.usage", usage: this.usageSnapshot(), budget: this.budgetObj() });
      this.emit({ type: "session.status_idle", stop_reason: { type: "budget_reached" }, stop_details: null });
      this.s.status = "idle";
      this.s.paused = true;
      this.s.active = null;
      this.persist();
      return false;
    }
    this.s.spentCents += costCents;
    return true;
  }

  private budgetObj() {
    return this.s.budgetCents === null ? null : { type: "limit", max_list_cost: { amount: String(this.s.budgetCents), currency: "USD" } };
  }

  private currentTurn(): FakeTurn {
    const a = this.s.active!;
    if (a.reminder) return { message: "Acknowledged.", costCents: 1 };
    return this.s.script.turns[a.turn] ?? { message: "Nothing further to report.", costCents: 1 };
  }

  /** Steps: 0 running+tools, 1 ask (optional), 2 submit, 3 final message. */
  private async runTurn(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.s.active && !this.s.active.waiting && !this.s.paused) {
        const a = this.s.active;
        const t = this.currentTurn();
        const per = (t.costCents ?? 3) / 3;
        await sleep(this.stepMs);
        if (a.aborted) {
          this.emit({ type: "session.usage", usage: this.usageSnapshot() });
          this.emit({ type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
          this.s.active = null;
          this.s.status = "idle";
          this.persist();
          break;
        }
        if (a.step === 0) {
          this.s.status = "running";
          this.emit({ type: "session.status_running" });
          if (!this.gate(per)) break;
          for (const tl of t.toolLog ?? []) {
            const use = this.emit({ type: "agent.tool_use", name: "bash", input: { command: tl.command }, evaluated_permission: "allow" });
            await sleep(this.stepMs);
            this.emit({ type: "agent.tool_result", tool_use_id: use.id, content: [{ type: "text", text: tl.output }], is_error: Boolean(tl.isError) });
          }
          a.step = t.askTool ? 1 : 2;
        } else if (a.step === 1) {
          this.emit({ type: "agent.tool_use", name: "bash", input: { command: "curl -s https://example.invalid/upload" }, evaluated_permission: "ask" });
          this.emit({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [] }, stop_details: null });
          a.waiting = "ask";
          a.step = 2;
        } else if (a.step === 2) {
          if (t.submission !== undefined) {
            if (!this.gate(per)) break;
            this.emit({ type: "agent.custom_tool_use", name: "submit_assessment", input: t.submission });
            this.emit({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [] }, stop_details: null });
            a.waiting = "custom";
          }
          a.step = 3;
        } else {
          if (!this.gate(per)) break;
          this.emit({ type: "agent.message", content: [{ type: "text", text: t.message ?? "Assessment submitted." }] });
          this.emit({ type: "session.usage", usage: this.usageSnapshot(), budget: this.budgetObj() });
          this.emit({ type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
          this.s.active = null;
          this.s.status = "idle";
        }
        this.persist();
      }
    } finally {
      this.running = false;
    }
  }

  // ---- SessionApi surface ----
  async receive(events: Array<Record<string, any>>): Promise<void> {
    for (const e of events) {
      if (e.type === "user.message") {
        if (this.s.paused) throw Object.assign(new Error("400: session is paused at its budget; only settle events are accepted (user.tool_confirmation, user.tool_result, user.custom_tool_result, user.interrupt)"), { status: 400 });
        this.emit({ type: "user.message", content: e.content });
        const text = (e.content ?? []).map((b: any) => b.text ?? "").join("\n");
        const reminder = /\breminder\]/.test(text);
        this.s.active = { turn: reminder ? -1 : this.s.turnsStarted++, step: 0, waiting: null, reminder, aborted: false };
        this.persist();
        void this.runTurn();
      } else if (e.type === "user.custom_tool_result") {
        this.emit({ ...e, type: "user.custom_tool_result" } as DriverEvent);
        if (this.s.active?.waiting === "custom") {
          this.s.active.waiting = null;
          this.persist();
          if (!e.is_error) void this.runTurn();
          else {
            // fixture cannot "fix" an invalid submission; end the turn
            this.s.active.step = 3;
            void this.runTurn();
          }
        }
      } else if (e.type === "user.tool_confirmation") {
        this.emit({ ...e, type: "user.tool_confirmation" } as DriverEvent);
        if (this.s.active?.waiting === "ask") {
          this.s.active.waiting = null;
          this.persist();
          void this.runTurn();
        }
      } else if (e.type === "user.interrupt") {
        if (this.s.paused) continue; // accepted and ignored at the cap, like the platform
        this.emit({ type: "user.interrupt" });
        if (this.s.active) {
          this.s.active.aborted = true;
          this.s.active.waiting = null;
          this.persist();
          void this.runTurn();
        }
      }
    }
  }

  setBudget(cents: number | null): void {
    this.s.budgetCents = cents;
    this.s.paused = false;
    this.persist();
  }

  api(): SessionApi {
    return {
      stream: async (): Promise<StreamHandle> => this.openStream(),
      listEvents: async () => this.s.events.map((e) => ({ ...e })),
      send: async (_id, events) => this.receive(events),
      retrieve: async (): Promise<SessionInfo> => ({
        status: this.s.status === "running" || this.s.active ? "running" : this.s.status,
        listCostCents: Math.round(this.s.spentCents),
        usage: this.usageSnapshot(),
        budgetCents: this.s.budgetCents,
      }),
    };
  }

  private openStream(): StreamHandle {
    const queue: DriverEvent[] = [];
    let wakeup: (() => void) | null = null;
    let closed = false;
    let failure: Error | null = null;
    // Simulated SSE drop: evaluated per delivered event against the turn that is active at that moment.
    const dropLimit = (): number | undefined => {
      const a = this.s.active;
      if (!a || a.reminder || this.s.dropped?.includes(a.turn)) return undefined;
      return this.s.script.turns[a.turn]?.dropStreamAfter;
    };
    const markDropped = () => {
      const a = this.s.active;
      if (a) this.s.dropped = [...(this.s.dropped ?? []), a.turn];
      this.persist();
    };
    const sub: Sub = {
      delivered: 0,
      push: (ev) => {
        queue.push(ev);
        wakeup?.();
      },
      fail: (err) => {
        failure = err;
        wakeup?.();
      },
    };
    this.subs.add(sub);
    const subs = this.subs;
    const iterator = {
      async *[Symbol.asyncIterator]() {
        try {
          while (!closed) {
            if (failure) throw failure;
            const ev = queue.shift();
            if (ev) {
              sub.delivered++;
              const limit = dropLimit();
              if (limit !== undefined && sub.delivered > limit) {
                queue.unshift(ev); // the event stays in server history; the stream just loses it
                markDropped();
                throw new Error("simulated SSE drop (fake)");
              }
              yield ev;
              continue;
            }
            await new Promise<void>((r) => (wakeup = r));
            wakeup = null;
          }
        } finally {
          subs.delete(sub);
        }
      },
    };
    return {
      iterator,
      close: () => {
        closed = true;
        subs.delete(sub);
        wakeup?.();
      },
    };
  }
}
