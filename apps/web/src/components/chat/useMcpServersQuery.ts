import type { EnvironmentId, McpServersListInput } from "@starkfuture/contracts";
import { useEffect, useEffectEvent } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

type Subscriber = { refresh: () => void; interval: number };
type Poller = { subscribers: Set<Subscriber>; timer: ReturnType<typeof setInterval> };
const pollers = new Map<string, Poller>();

/** The chip, warning and open panel share one poller and one query for their target. */
export function useMcpServersQuery(
  environmentId: EnvironmentId,
  target: McpServersListInput,
  interval = 10_000,
) {
  const query = useEnvironmentQuery(serverEnvironment.mcpServers({ environmentId, input: target }));
  const refresh = useEffectEvent(() => query.refresh());
  const key = JSON.stringify([
    environmentId,
    target.threadId,
    target.providerInstanceId,
    target.projectId,
  ]);
  useEffect(() => {
    const subscriber = { refresh: () => refresh(), interval };
    const existing = pollers.get(key);
    const subscribers = existing?.subscribers ?? new Set<Subscriber>();
    subscribers.add(subscriber);
    const schedule = () => {
      const old = pollers.get(key);
      if (old) clearInterval(old.timer);
      if (!subscribers.size) {
        pollers.delete(key);
        return;
      }
      const timer = setInterval(
        () => subscribers.values().next().value?.refresh(),
        Math.min(...Array.from(subscribers, (entry) => entry.interval)),
      );
      pollers.set(key, { subscribers, timer });
    };
    schedule();
    if (!existing) subscriber.refresh();
    return () => {
      subscribers.delete(subscriber);
      schedule();
    };
  }, [key, interval]);
  return query;
}
