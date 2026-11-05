// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type {
  LookoutBridge,
  LookoutFinding,
  LookoutResponse,
  LookoutStatus,
} from "@starkfuture/contracts";
import { LOOKOUT_POLL_INTERVAL_MS, LookoutContent } from "./LookoutPanel";

const repo = (key: string, root: string, openFindings: number) => ({
  key,
  name: key,
  root,
  lastEventAt: "2026-11-05T16:00:00.000Z",
  paused: false,
  excluded: false,
  pendingEvents: 0,
  openFindings,
  toldSession: 0,
  activeJob: null,
  lastRun: null,
});

const STATUS: LookoutStatus = {
  generatedAt: "2026-11-05T16:00:00.000Z",
  daemon: { running: true, pid: 4, heartbeatAt: "2026-11-05T16:00:00.000Z" },
  paused: false,
  profiles: ["/Users/me/.claude"],
  home: "/Users/me/.lookout",
  mode: "local",
  claudeBin: "claude",
  delivery: "session",
  selftest: { ok: true, reason: "passed" },
  budget: { windowHours: 24, capCents: 1000, spentCents: 37, availableCents: 963 },
  repos: [repo("billing", "/work/billing", 1), repo("orders", "/work/orders", 1)],
};

const finding = (overrides: Partial<LookoutFinding>): LookoutFinding => ({
  ref: "billing#1",
  repo: "billing",
  repoKey: "billing",
  id: 1,
  title: "Invoice totals round per line",
  severity: "high",
  issueType: "defect",
  attribution: "introduced",
  proof: "traced",
  awareness: "unaware",
  riskAreas: ["money"],
  status: "open",
  statement: "Each line is rounded before summing.",
  failureCase: "100 lines of 0.005 drift by 50 cents.",
  whyItMatters: "Customers are overcharged.",
  nextAction: "Round once after summing.",
  handoffPrompt: null,
  evidence: [
    {
      type: "file",
      path: "src/invoice.ts",
      lineStart: 12,
      quote: "round(line)",
      check: "verified",
    },
  ],
  speech: { action: "inbox", why: "low confidence", toldSession: false },
  deliveredAt: null,
  revision: 1,
  createdAt: "2026-11-05T15:00:00.000Z",
  updatedAt: "2026-11-05T15:00:00.000Z",
  decisionNote: null,
  ...overrides,
});

const ok = <T,>(value: T): LookoutResponse<T> => ({ installed: true, ok: true, value });

let root: Root;
let container: HTMLDivElement;
let bridge: { [K in keyof LookoutBridge]: ReturnType<typeof vi.fn> };

const render = (active = true) =>
  act(async () =>
    root.render(
      <LookoutContent
        bridge={bridge as unknown as LookoutBridge}
        active={active}
        projectRoot="/work/orders/src"
        timestampFormat="24-hour"
      />,
    ),
  );
const button = (label: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const click = (label: string) => act(async () => button(label).click());
const tick = () => act(async () => vi.advanceTimersByTime(LOOKOUT_POLL_INTERVAL_MS));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  bridge = {
    status: vi.fn(async () => ok(STATUS)),
    findings: vi.fn(async () =>
      ok({
        findings: [
          finding({}),
          finding({
            ref: "orders#2",
            repo: "orders",
            repoKey: "orders",
            id: 2,
            title: "Retry charges twice",
            severity: "medium",
            deliveredAt: "2026-11-05T14:32:00.000Z",
            speech: { action: "speak", why: "risky", toldSession: true },
          }),
        ],
      }),
    ),
    activity: vi.fn(async () => ok({ events: [], runs: [] })),
    decide: vi.fn(async () => ok({ ok: true, finding: finding({ status: "dismissed" }) })),
    pause: vi.fn(async () => ok({ ok: true, paused: true, scope: "all" })),
    resume: vi.fn(async () => ok({ ok: true, paused: false, scope: "all" })),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows the install command and checks only on open when Lookout is missing", async () => {
  bridge.status.mockResolvedValue({ installed: false, launcher: "/Users/me/.lookout/bin/lookout" });
  await render();
  expect(container.textContent).toContain("Lookout isn't installed");
  expect(container.textContent).toContain("<path-to-lookout-checkout>/scripts/lookout install");
  await tick();
  await tick();
  expect(bridge.status).toHaveBeenCalledTimes(1);
  expect(bridge.findings).not.toHaveBeenCalled();
  await click("Check again");
  expect(bridge.status).toHaveBeenCalledTimes(2);
});

it("lists this folder's findings first and polls only while open", async () => {
  await render();
  const rows = [
    ...container.querySelectorAll('[aria-label="Findings"] [data-slot="collapsible-trigger"]'),
  ];
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "Medium: Retry charges twice",
    "High: Invoice totals round per line",
  ]);
  expect(container.textContent).toContain("Told the session at");
  expect(container.textContent).toContain("Kept quiet: low confidence");
  expect(container.textContent).toContain("Watching");
  expect(container.textContent).toContain("$0.37 of $10.00 used in 24 h");

  await tick();
  expect(bridge.status).toHaveBeenCalledTimes(2);
  await render(false);
  await tick();
  await tick();
  expect(bridge.status).toHaveBeenCalledTimes(2);
});

it("asks for a reason before dismissing, then sends it and refreshes", async () => {
  await render();
  await click("High: Invoice totals round per line");
  await click("Dismiss");
  const submit = [...container.querySelectorAll<HTMLButtonElement>('button[type="submit"]')][0]!;
  expect(submit.disabled).toBe(true);
  const reason = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Reason to dismiss"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      reason,
      "  we round server-side ",
    );
    reason.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(submit.disabled).toBe(false);
  const before = bridge.status.mock.calls.length;
  await act(async () => submit.click());
  expect(bridge.decide).toHaveBeenCalledWith({
    ref: "billing#1",
    action: "dismiss",
    note: "we round server-side",
  });
  expect(bridge.status.mock.calls.length).toBe(before + 1);
});

it("shows Lookout's refusal instead of hiding it", async () => {
  bridge.pause.mockResolvedValue({
    installed: true,
    ok: false,
    reason: "failed",
    error: "registry is locked",
  });
  await render();
  await click("Pause Lookout");
  expect(container.textContent).toContain("registry is locked");
});
