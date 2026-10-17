// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@starkfuture/contracts";
const clock = vi.hoisted(() => ({ minute: "2026-10-17T12:00" }));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => clock.minute }));
import { ComposerUsageRing } from "./ComposerUsageRing";
import { TooltipProvider } from "../ui/tooltip";

let root: Root;
let container: HTMLDivElement;
const request = vi.fn();
const claude: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Stark Future 1",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", email: "hidden@example.com" },
  checkedAt: "2026-10-17T12:00:00Z",
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-10-17T11:55:00Z",
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 12,
        resetsAt: "2026-10-17T15:00:00Z",
      },
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 67,
        resetsAt: "2026-10-19T18:00:00Z",
      },
    ],
  },
};
const trigger = () => {
  const value = container.querySelector<HTMLButtonElement>('[data-composer-usage-ring="true"]');
  if (!value) throw new Error("Usage trigger missing");
  return value;
};
const render = (provider: ServerProvider | null = claude, connected = true) =>
  act(() =>
    root.render(
      <TooltipProvider delay={0}>
        <ComposerUsageRing provider={provider} connected={connected} timestampFormat="24-hour" />
      </TooltipProvider>,
    ),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", request);
  request.mockReset();
  clock.minute = "2026-10-17T12:00";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("shows usage on keyboard focus and click, without making requests or exposing the email", async () => {
  await render();
  expect(trigger().getAttribute("aria-label")).toContain("Session · all models: 12% used");
  expect(trigger().getAttribute("aria-label")).toContain("Weekly · all models: 67% used");
  await act(() => trigger().focus());
  expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
    "Session · all models: 12% used",
  );
  expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
    "Weekly · all models: 67% used",
  );
  await act(() => trigger().click());
  const popup = document.querySelector('[data-slot="popover-popup"]');
  expect(popup?.textContent).toContain("Session · all models: 12% used");
  expect(popup?.textContent).toContain("Weekly · all models: 67% used");
  expect(popup?.textContent).toContain("Resets Sat");
  expect(popup?.textContent).toContain("Resets Mon");
  expect(popup?.textContent?.match(/Resets /g)).toHaveLength(2);
  expect(popup?.textContent).toContain("Selected profile: Stark Future 1");
  expect(document.body.textContent).not.toContain("hidden@example.com");
  expect(request).not.toHaveBeenCalled();
});
it("updates the open details when the selected provider changes", async () => {
  await render();
  await act(() => trigger().click());
  await render({
    ...claude,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex personal",
    usageLimits: {
      checkedAt: "2026-10-17T12:00:00Z",
      windows: [
        { id: "primary", label: "Weekly", kind: "weekly", usedPercent: 23 },
        { id: "secondary", label: "Session", kind: "session", usedPercent: 8 },
      ],
    },
  });
  expect(trigger().getAttribute("aria-label")).toContain("Weekly: 23% used");
  expect(trigger().getAttribute("aria-label")).toContain("Session: 8% used");
  const popup = document.querySelector('[data-slot="popover-popup"]');
  expect(popup?.textContent).toContain("Session: 8% used");
  expect(popup?.textContent).toContain("Weekly: 23% used");
  expect(popup?.textContent).toContain("Codex personal");
  expect(popup?.textContent).not.toContain("67%");
  expect(popup?.textContent).not.toContain("Stark Future 1");
  expect(request).not.toHaveBeenCalled();
});
it("shows the same usage details on hover", async () => {
  await render();
  await act(() => trigger().dispatchEvent(new MouseEvent("mouseenter", { bubbles: true })));
  expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
    "Session · all models: 12% used",
  );
  expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
    "Weekly · all models: 67% used",
  );
  expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
  expect(request).not.toHaveBeenCalled();
});
it("draws the ring from the more consumed session while keeping both windows in its details", async () => {
  await render({
    ...claude,
    usageLimits: {
      ...claude.usageLimits!,
      windows: claude.usageLimits!.windows.map((window) =>
        window.kind === "session" ? { ...window, usedPercent: 92 } : window,
      ),
    },
  });
  const progress = trigger().querySelector("circle[stroke-dashoffset]");
  const circumference = Number(progress?.getAttribute("stroke-dasharray"));
  const remaining = Number(progress?.getAttribute("stroke-dashoffset"));
  expect(circumference).toBeGreaterThan(0);
  expect(1 - remaining / circumference).toBeCloseTo(0.92);
  await act(() => trigger().click());
  const popup = document.querySelector('[data-slot="popover-popup"]');
  expect(popup?.textContent).toContain("Session · all models: 92% used");
  expect(popup?.textContent).toContain("Weekly · all models: 67% used");
  expect(popup?.textContent).toContain("Selected profile: Stark Future 1");
  expect(request).not.toHaveBeenCalled();
});
it("keeps weekly usage readable when the session has reset", async () => {
  await render({
    ...claude,
    usageLimits: {
      ...claude.usageLimits!,
      windows: claude.usageLimits!.windows.map((window) =>
        window.kind === "session"
          ? { ...window, usedPercent: 100, resetsAt: "2026-10-17T12:00:00Z" }
          : window,
      ),
    },
  });
  expect(trigger().getAttribute("aria-label")).toContain("Weekly · all models: 67% used");
  expect(trigger().getAttribute("aria-label")).not.toContain("100%");
  await act(() => trigger().click());
  const popup = document.querySelector('[data-slot="popover-popup"]');
  expect(popup?.textContent).toContain("Session · all models");
  expect(popup?.textContent).toContain("has reset");
  expect(popup?.textContent).toContain("Weekly · all models: 67% used");
  expect(popup?.textContent).toContain("Resets Mon");
  expect(popup?.textContent).not.toContain("100%");
});
it("shows a missing Codex session beside reported zero weekly usage", async () => {
  await render({
    ...claude,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex personal",
    usageLimits: {
      checkedAt: "2026-10-17T12:00:00Z",
      windows: [{ id: "secondary", label: "Weekly", kind: "weekly", usedPercent: 0 }],
    },
  });
  await act(() => trigger().click());
  const popup = document.querySelector('[data-slot="popover-popup"]');
  expect(popup?.textContent).toContain("Session");
  expect(popup?.textContent).toContain("Session: Not reported");
  expect(popup?.textContent).toContain("Weekly: 0% used");
  expect(popup?.textContent).toContain("Reset time not reported.");
  expect(popup?.textContent).not.toContain("Session: 0%");
  expect(popup?.textContent).not.toContain("all models");
});
it("includes Codex monthly allowance without inventing session or weekly percentages", async () => {
  await render({
    ...claude,
    driver: ProviderDriverKind.make("codex"),
    usageLimits: {
      checkedAt: "2026-10-17T12:00:00Z",
      windows: [{ id: "primary", label: "Monthly", kind: "monthly", usedPercent: 38 }],
    },
  });
  await act(() => trigger().click());
  const popup = document.querySelector('[data-slot="popover-popup"]');
  expect(popup?.textContent).toContain("Session");
  expect(popup?.textContent).toContain("Weekly");
  expect(popup?.textContent?.match(/Not reported/g)).toHaveLength(2);
  expect(popup?.textContent).toContain("Monthly: 38% used");
  expect(trigger().getAttribute("aria-label")).toContain("Monthly: 38% used");
});
it("keeps unknown usage distinct from reported zero and full allowance use", async () => {
  await render({ ...claude, usageLimits: undefined });
  expect(trigger().getAttribute("aria-label")).toContain("unavailable");
  await act(() => trigger().click());
  expect(document.body.textContent).toContain("Usage has not been reported yet.");
  for (const usedPercent of [0, 100]) {
    await render({
      ...claude,
      usageLimits: {
        ...claude.usageLimits!,
        windows: [{ ...claude.usageLimits!.windows[0]!, usedPercent }],
      },
    });
    expect(trigger().getAttribute("aria-label")).toContain(`${usedPercent}% used`);
    expect(document.body.textContent).not.toContain("unavailable");
  }
});
it("turns a stale or disconnected ring neutral and hides it for unsupported providers", async () => {
  await render();
  clock.minute = "2026-10-17T12:10";
  await render();
  expect(trigger().getAttribute("aria-label")).toContain("unavailable");
  await act(() => trigger().click());
  expect(document.body.textContent).toContain("out of date");
  await render(claude, false);
  expect(document.body.textContent).toContain("Reconnect");
  await render({ ...claude, driver: ProviderDriverKind.make("cursor") });
  expect(container.querySelector("button")).toBeNull();
  expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
});
