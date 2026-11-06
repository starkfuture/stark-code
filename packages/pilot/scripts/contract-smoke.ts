/**
 * CONTRACT SMOKE TEST - NOT A LIVE INTEGRATION.
 *
 * Runs the real live-mode code path (`lookout setup`, `assess`, `watch` with PILOT_MODE=live and the real
 * @anthropic-ai/sdk) against a local stub of the Managed Agents HTTP API. It checks what tsc cannot: the
 * requests our code actually sends (paths, beta header, bodies with budget/resources/metadata, multipart
 * upload), that the SDK's SSE stream + cursor pagination feed the driver correctly, that a command evidence
 * item is verified against the session's own tool transcript, and that platform list_cost is recorded.
 * The stub's responses are modelled on the documented shapes; the hosted service may differ.
 *
 *   node --disable-warning=ExperimentalWarning scripts/contract-smoke.ts     (needs localhost binding)
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
type Req = { method: string; path: string; beta: string; body: any; contentType: string };
const reqs: Req[] = [];
const events: Array<Record<string, any>> = [];
const streams = new Set<http.ServerResponse>();
let seq = 0;
let sessionBody: any = null;
let pagesServed = 0;

const push = (ev: Record<string, any>) => {
  const full: Record<string, any> = { id: `sevt_stub_${++seq}`, processed_at: new Date().toISOString(), ...ev };
  events.push(full);
  for (const s of streams) s.write(`event: ${full.type}\ndata: ${JSON.stringify(full)}\n\n`);
  return full;
};

const SUBMISSION = {
  phase: "checkpoint",
  summary: "stub agent: createOrder retries without an idempotency key",
  findings: [
    {
      fingerprint: "order-create-retry-without-idempotency-key",
      issue_type: "defect",
      severity: "critical",
      attribution: "introduced",
      proof: "reproduced",
      session_awareness: "unaware",
      risk_areas: ["money"],
      category: "omission",
      failure_case: "stub",
      controls_checked: "stub",
      title: "Retrying order creation without an Idempotency-Key can charge customers twice",
      statement: "stub",
      why_it_matters: "one order per checkout",
      evidence: [
        { type: "file", path: "/workspace/review/repo/docs/orders-api.md", quote: "Not idempotent by default: every accepted request creates a new order and a new charge." },
        { type: "command", command: "node dup-experiment.mjs", output_excerpt: "orders created: 3" },
      ],
      confidence: 0.9,
      uncertainty: "stub",
      suggested_next_action: "add key",
      related_paths: ["src/ordersClient.js"],
    },
  ],
};

function agentTurn(): void {
  push({ type: "session.status_running" });
  const use = push({ type: "agent.tool_use", name: "bash", input: { command: "cd /workspace/review/repo && node dup-experiment.mjs" }, evaluated_permission: "allow" });
  push({ type: "agent.tool_result", tool_use_id: use.id, content: [{ type: "text", text: 'result: "AbortError" | orders created: 3\n' }] });
  push({ type: "agent.custom_tool_use", name: "submit_assessment", input: SUBMISSION });
  push({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [] }, stop_details: null });
  if (!dropped) {
    // Drop the SSE connection once, mid-session: the client must reconnect and re-read (paginated) history.
    dropped = true;
    setTimeout(() => {
      for (const st of streams) st.end();
    }, 5);
  }
}
let dropped = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const ct = String(req.headers["content-type"] ?? "");
  const body = ct.includes("application/json") && raw.length ? JSON.parse(raw.toString()) : raw.length ? `<${raw.length} bytes ${ct.split(";")[0]}>` : null;
  reqs.push({ method: req.method ?? "", path: url.pathname, beta: String(req.headers["anthropic-beta"] ?? ""), body, contentType: ct.split(";")[0] });
  const json = (status: number, obj: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(obj));
  const p = url.pathname;

  if (req.method === "POST" && p === "/v1/environments") return json(200, { id: "env_stub", type: "environment", name: body.name, config: body.config });
  if (req.method === "POST" && p === "/v1/agents") return json(200, { id: "agent_stub", type: "agent", version: 1, ...body });
  if (req.method === "POST" && p === "/v1/files") return json(200, { id: "file_stub_1", type: "file", filename: "bundle.tgz", size_bytes: raw.length, created_at: new Date().toISOString(), mime_type: "application/gzip" });
  if (req.method === "DELETE" && p.startsWith("/v1/files/")) return json(200, { id: p.split("/").pop(), type: "file_deleted" });
  if (req.method === "POST" && p === "/v1/sessions") {
    sessionBody = body;
    return json(200, { id: "sesn_stub_1", type: "session", status: "idle", metadata: body.metadata, budget: body.budget, usage: {}, resources: [] });
  }
  if (req.method === "GET" && p === "/v1/sessions") return json(200, { data: [], next_page: null, prev_page: null });
  if (req.method === "GET" && p === "/v1/sessions/sesn_stub_1/events/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": open\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }
  if (req.method === "GET" && p === "/v1/sessions/sesn_stub_1/events") {
    // Paginate in pages of 3 so the client must follow next_page cursors to see the whole history.
    const from = Number(url.searchParams.get("page") ?? 0);
    pagesServed++;
    const next = from + 3 < events.length ? String(from + 3) : null;
    return json(200, { data: events.slice(from, from + 3), next_page: next });
  }
  if (req.method === "POST" && p === "/v1/sessions/sesn_stub_1/events") {
    json(200, { data: [] });
    for (const ev of body.events) {
      if (ev.type === "user.message") {
        push({ ...ev, processed_at: null });
        setTimeout(agentTurn, 20);
      } else if (ev.type === "user.custom_tool_result") {
        push(ev);
        setTimeout(() => {
          push({ type: "agent.message", content: [{ type: "text", text: "Submitted." }] });
          push({ type: "session.usage", usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 9000, list_cost: { amount: "37", currency: "USD" }, active_seconds: 41 } });
          push({ type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
        }, 20);
      } else push(ev);
    }
    return;
  }
  if (req.method === "GET" && p === "/v1/sessions/sesn_stub_1") {
    return json(200, { id: "sesn_stub_1", type: "session", status: "idle", budget: sessionBody?.budget ?? null, usage: { input_tokens: 1200, output_tokens: 300, list_cost: { amount: "37", currency: "USD" }, active_seconds: 41 } });
  }
  json(404, { type: "error", error: { type: "not_found_error", message: `stub has no ${req.method} ${p}` } });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

// Demo repo at the unsafe step.
const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lookout-contract-"));
const repo = path.join(work, "orders-service");
fs.cpSync(path.join(ROOT, "examples", "orders-service"), repo, { recursive: true });
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
git("init", "-q", "-b", "main");
git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", "-A");
git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "base");
for (const step of ["1-legit-get-retry", "2-unsafe-create-retry"]) fs.cpSync(path.join(ROOT, "examples", "steps", step), repo, { recursive: true });

const env = {
  ...process.env,
  PILOT_MODE: "live",
  PILOT_REPO: repo,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  ANTHROPIC_API_KEY: "stub-key-not-a-real-credential",
  PILOT_POLL_MS: "100",
};
// Async spawn: the stub server lives in this process and must keep serving while the CLI runs.
const cli = (...args: string[]) =>
  new Promise<string>((resolve) => {
    const child = spawn(path.join(ROOT, "bin", "lookout"), args, { env });
    let buf = "";
    child.stdout.on("data", (d) => (buf += d));
    child.stderr.on("data", (d) => (buf += d));
    const t = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", () => {
      clearTimeout(t);
      resolve(buf);
    });
  });

const out: string[] = [];
out.push(await cli("setup"), await cli("assess"), await cli("watch", "--until-idle"));
server.closeAllConnections();
server.close();

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);
const maReqs = reqs.filter((r) => /\/v1\/(agents|environments|sessions)/.test(r.path));
check("every Managed Agents request carries anthropic-beta managed-agents-2026-04-01", maReqs.length > 0 && maReqs.every((r) => r.beta.includes("managed-agents-2026-04-01")));
const agentReq = reqs.find((r) => r.method === "POST" && r.path === "/v1/agents");
check("agent: model object with effort, toolset with web tools disabled, submit_assessment custom tool",
  agentReq?.body?.model?.id === "claude-opus-5-5" && agentReq?.body?.model?.effort === "medium" &&
  agentReq?.body?.tools?.[0]?.configs?.every((c: any) => c.enabled === false) && agentReq?.body?.tools?.[1]?.name === "submit_assessment");
const envReq = reqs.find((r) => r.path === "/v1/environments");
check("environment: cloud, limited networking", envReq?.body?.config?.type === "cloud" && envReq?.body?.config?.networking?.type === "limited");
const fileReq = reqs.find((r) => r.method === "POST" && r.path === "/v1/files");
check("bundle uploaded once via multipart Files API", reqs.filter((r) => r.method === "POST" && r.path === "/v1/files").length === 1 && fileReq?.contentType === "multipart/form-data");
check("session: pinned agent version, budget in cents as string, file mounted, job metadata",
  sessionBody?.agent?.type === "agent" && sessionBody?.agent?.version === 1 &&
  JSON.stringify(sessionBody?.budget) === JSON.stringify({ type: "limit", max_list_cost: { amount: "75", currency: "USD" } }) &&
  sessionBody?.resources?.[0]?.file_id === "file_stub_1" && sessionBody?.resources?.[0]?.mount_path === "/lookout/bundle.tgz" &&
  sessionBody?.metadata?.lookout_job_id === "1");
const streamIdx = reqs.findIndex((r) => r.path.endsWith("/events/stream"));
const firstSend = reqs.findIndex((r) => r.method === "POST" && r.path.endsWith("/events"));
check("stream opened before the first event was sent (stream-first)", streamIdx >= 0 && streamIdx < firstSend);
const sends = reqs.filter((r) => r.method === "POST" && r.path.endsWith("/events")).flatMap((r) => r.body.events.map((e: any) => e.type));
check("client sent exactly: user.message, user.custom_tool_result", JSON.stringify(sends) === JSON.stringify(["user.message", "user.custom_tool_result"]));
check("uploaded bundle deleted after the run", reqs.some((r) => r.method === "DELETE" && r.path === "/v1/files/file_stub_1"));
const db = new DatabaseSync(path.join(repo, ".lookout", "lookout.db"));
const job = db.prepare("SELECT status, list_cost_cents, cost_source, runtime FROM jobs WHERE id = 1").get() as any;
check("job done with platform list cost 37c recorded", job?.status === "done" && job?.list_cost_cents === 37 && job?.cost_source === "platform" && job?.runtime === "live");
const f = db.prepare("SELECT status, grounding FROM findings").get() as any;
const g = f ? JSON.parse(f.grounding) : null;
check("finding grounded: file quote + command verified against the session's own tool transcript", f?.status === "open" && g?.status === "grounded" && g?.verified === 2);
check("after a dropped stream: reconnect re-read history across pages (cursor pagination), nothing re-sent", dropped && pagesServed >= 3);

console.log("CONTRACT SMOKE (local stub of the Managed Agents API - not a live integration)");
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
if (checks.some(([, ok]) => !ok)) {
  console.log("\n--- CLI output ---\n" + out.join("\n"));
  console.log("--- requests ---\n" + reqs.map((r) => `${r.method} ${r.path} beta=${r.beta}`).join("\n"));
  process.exitCode = 1;
}
