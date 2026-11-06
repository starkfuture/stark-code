import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeSessionServer, type FakeScript } from "../src/investigator/fakeSession.ts";
import { driveSession, type DriveOptions } from "../src/investigator/sessionDriver.ts";
import { validateSubmission } from "../src/investigator/types.ts";

const submission = (phase: string, extra: Record<string, unknown> = {}) => ({
  phase,
  summary: `${phase} done`,
  findings: [],
  ...extra,
});

const opts = (over: Partial<DriveOptions> = {}): DriveOptions => ({
  jobId: 7,
  phases: ["phase zero"],
  deadlineMs: Date.now() + 30_000,
  shouldStop: () => false,
  validate: validateSubmission,
  ...over,
});

const count = (server: FakeSessionServer, type: string) =>
  server
    .api()
    .listEvents("x")
    .then((evs) => evs.filter((e) => e.type === type).length);

test("two phases in one session: phase 2 is sent only after phase 1 is submitted and the turn ends", async () => {
  const script: FakeScript = { label: "t", turns: [{ submission: submission("baseline"), costCents: 3 }, { submission: submission("comparison"), costCents: 3 }] };
  const server = new FakeSessionServer({ id: "sesn_a", script, stepMs: 1 });
  const r = await driveSession(server.api(), "sesn_a", opts({ phases: ["one", "two"] }));
  assert.equal(r.status, "completed");
  assert.deepEqual(r.submissions.map((s) => s.phase), ["baseline", "comparison"]);
  const evs = await server.api().listEvents("sesn_a");
  const msgs = evs.filter((e) => e.type === "user.message").map((e) => e.content[0].text as string);
  assert.match(msgs[0], /phase=0\]\none$/);
  assert.match(msgs[1], /phase=1\]\ntwo$/);
  const firstSubmitIdx = evs.findIndex((e) => e.type === "agent.custom_tool_use");
  const secondMsgIdx = evs.findIndex((e) => e.type === "user.message" && /phase=1/.test(e.content[0].text));
  assert.ok(firstSubmitIdx < secondMsgIdx, "proposal is not visible before the baseline is submitted");
});

test("invalid submissions get an error result, one reminder, then the run fails instead of revealing the next phase", async () => {
  const script: FakeScript = { label: "t", turns: [{ submission: { phase: "baseline", findings: "nope" } }, { submission: submission("comparison") }] };
  const server = new FakeSessionServer({ id: "sesn_b", script, stepMs: 1 });
  const r = await driveSession(server.api(), "sesn_b", opts({ phases: ["baseline task", "THE PROPOSAL"] }));
  assert.equal(r.status, "failed");
  assert.match(r.reason ?? "", /no valid assessment for phase 0/);
  assert.equal(r.invalidSubmissions, 1);
  assert.equal(r.submissions.length, 0);
  const msgs = (await server.api().listEvents("x")).filter((e) => e.type === "user.message").map((e) => e.content[0].text as string);
  assert.equal(msgs.length, 2, "phase message + one reminder");
  assert.ok(!msgs.some((m) => m.includes("THE PROPOSAL")), "the proposal is never shown without a baseline");
});

test("a send that fails is retried after reconnect, based on server history (no loss, no duplicate)", async () => {
  const script: FakeScript = { label: "t", turns: [{ submission: submission("checkpoint") }] };
  const server = new FakeSessionServer({ id: "sesn_h", script, stepMs: 1 });
  const api = server.api();
  let failed = false;
  const flaky = {
    ...api,
    send: async (id: string, events: Array<Record<string, unknown>>) => {
      if (!failed && events[0]?.type === "user.custom_tool_result") {
        failed = true;
        throw new Error("simulated 502 on send");
      }
      return api.send(id, events);
    },
  };
  const r = await driveSession(flaky, "sesn_h", opts());
  assert.equal(r.status, "completed");
  assert.ok(failed);
  assert.equal(r.submissions.length, 1);
  assert.equal(await count(server, "user.custom_tool_result"), 1, "re-sent exactly once");
});

test("budget_reached: the request that crosses the cap completes, the session pauses, partial results kept", async () => {
  // 30c over 3 requests vs 15c cap: request 1 (10c) ok, request 2 (10c) admitted at 10<15 -> submission, gate trips before request 3.
  const script: FakeScript = { label: "t", turns: [{ submission: submission("checkpoint"), costCents: 30 }], budgetCents: 15 };
  const server = new FakeSessionServer({ id: "sesn_c", script, stepMs: 1 });
  const r = await driveSession(server.api(), "sesn_c", opts());
  assert.equal(r.status, "budget_reached");
  assert.equal(r.submissions.length, 1);
  const info = await server.api().retrieve("sesn_c");
  assert.equal(info.listCostCents, 20, "overshoot: 20c consumed against a 15c cap");
  await assert.rejects(server.api().send("sesn_c", [{ type: "user.message", content: [{ type: "text", text: "more" }] }]), /budget/);
});

test("dropped SSE stream: reconnect consolidates history; nothing is re-sent", async () => {
  const script: FakeScript = { label: "t", turns: [{ submission: submission("checkpoint"), dropStreamAfter: 2, toolLog: [{ command: "npm test", output: "ok" }] }] };
  const server = new FakeSessionServer({ id: "sesn_d", script, stepMs: 1 });
  const r = await driveSession(server.api(), "sesn_d", opts());
  assert.equal(r.status, "completed");
  assert.ok(r.errors.some((e) => /simulated SSE drop/.test(e)));
  assert.equal(r.submissions.length, 1);
  assert.equal(r.toolLog.length, 1);
  assert.equal(await count(server, "user.message"), 1);
  assert.equal(await count(server, "user.custom_tool_result"), 1);
});

test("client crash mid-session: re-driving from server history resumes without duplicate side effects", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lookout-fake-")), "s.json");
  const script: FakeScript = { label: "t", turns: [{ submission: submission("baseline") }, { submission: submission("comparison") }] };
  const server = new FakeSessionServer({ id: "sesn_e", script, file, stepMs: 2 });
  let n = 0;
  await assert.rejects(
    driveSession(server.api(), "sesn_e", opts({
      phases: ["one", "two"],
      onEvent: (ev) => {
        if (ev.type === "user.custom_tool_result" && ++n === 1) throw Object.assign(new Error("crash"), { simulatedCrash: true });
      },
    })),
    /crash/,
  );
  // New process: the fake reloads its persisted state, the driver rebuilds its state from history.
  const reloaded = new FakeSessionServer({ id: "sesn_e", file, stepMs: 2 });
  const r = await driveSession(reloaded.api(), "sesn_e", opts({ phases: ["one", "two"] }));
  assert.equal(r.status, "completed");
  assert.deepEqual(r.submissions.map((s) => s.phase), ["baseline", "comparison"], "the pre-crash submission is recovered from history");
  assert.equal(await count(reloaded, "user.message"), 2, "phase 1 not re-sent");
  assert.equal(await count(reloaded, "user.custom_tool_result"), 2);
});

test("deadline: the driver interrupts the session and reports timed_out; approval asks are denied when unattended", async () => {
  const script: FakeScript = { label: "t", turns: [{ askTool: true, submission: submission("checkpoint") }] };
  const server = new FakeSessionServer({ id: "sesn_f", script, stepMs: 400 });
  const r = await driveSession(server.api(), "sesn_f", opts({ deadlineMs: Date.now() + 300 }));
  assert.equal(r.status, "timed_out");
  assert.equal(await count(server, "user.interrupt"), 1);

  const s2 = new FakeSessionServer({ id: "sesn_g", script, stepMs: 1 });
  const r2 = await driveSession(s2.api(), "sesn_g", opts());
  assert.equal(r2.status, "completed");
  assert.equal(r2.deniedAsks, 1);
  const conf = (await s2.api().listEvents("x")).find((e) => e.type === "user.tool_confirmation");
  assert.equal(conf?.result, "deny");
});
