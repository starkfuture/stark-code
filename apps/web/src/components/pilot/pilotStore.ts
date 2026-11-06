import type { PilotBridge, PilotResponse, PilotStatus } from "@starkfuture/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { create } from "zustand";

/** The top bar's status check while the panel is closed; the open panel checks the thread instead. */
export const PILOT_STATUS_POLL_MS = 15_000;

/**
 * What the top bar shows for Pilot: whether it is installed, and how many
 * nudges the person has not seen. The panel and the closed-panel check both
 * write it, so the dot follows whichever spoke to Pilot last.
 */
export const usePilotIndicator = create<{
  readonly installed: boolean | null;
  readonly unread: number;
}>(() => ({ installed: null, unread: 0 }));

export function notePilotStatus(response: PilotResponse<PilotStatus>) {
  if (!response.installed) usePilotIndicator.setState({ installed: false, unread: 0 });
  // A failed check keeps the last known count rather than hiding unread nudges.
  else if (response.ok)
    usePilotIndicator.setState({ installed: true, unread: response.value.unread ?? 0 });
}

export function notePilotUnread(unread: number) {
  usePilotIndicator.setState({ installed: true, unread: Math.max(0, unread) });
}

/** The person just saw `count` nudges; the next check confirms the real count. */
export function notePilotSeen(count: number) {
  usePilotIndicator.setState((state) => ({ unread: Math.max(0, state.unread - count) }));
}

/**
 * Runs `task` when enabled and then every `intervalMs` while the window is
 * visible, never two at once. Disabling abandons a run in flight: `isCurrent`
 * turns false so it applies nothing. The returned function runs the task now,
 * or right after the run in flight.
 */
export function usePoll(
  task: (isCurrent: () => boolean) => Promise<void>,
  intervalMs: number,
  enabled: boolean,
): () => void {
  const taskRef = useRef(task);
  useLayoutEffect(() => {
    taskRef.current = task;
  });
  const control = useRef<{ alive: boolean; running: boolean; again: boolean } | null>(null);

  const runNow = useCallback(() => {
    const run = () => {
      const current = control.current;
      if (!current?.alive) return;
      if (current.running) {
        current.again = true;
        return;
      }
      current.running = true;
      void taskRef
        .current(() => current.alive)
        .then(
          () => finish(current),
          () => finish(current),
        );
    };
    const finish = (current: NonNullable<typeof control.current>) => {
      current.running = false;
      if (current.again && current.alive) {
        current.again = false;
        run();
      }
    };
    run();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const current = { alive: true, running: false, again: false };
    control.current = current;
    runNow();
    const whenVisible = () => {
      if (document.visibilityState === "visible") runNow();
    };
    const timer = window.setInterval(whenVisible, intervalMs);
    document.addEventListener("visibilitychange", whenVisible);
    return () => {
      current.alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", whenVisible);
      if (control.current === current) control.current = null;
    };
  }, [enabled, intervalMs, runNow]);

  return runNow;
}

/** Keeps the top bar's dot current while the Pilot panel is closed. */
export function usePilotStatusWhileClosed(bridge: PilotBridge | undefined, closed: boolean) {
  usePoll(
    async (isCurrent) => {
      if (!bridge) return;
      const response = await bridge.status();
      if (isCurrent()) notePilotStatus(response);
    },
    PILOT_STATUS_POLL_MS,
    bridge !== undefined && closed,
  );
}
