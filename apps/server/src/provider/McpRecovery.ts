import type { McpServerStatusEntry, ProviderDriverKind } from "@starkfuture/contracts";
import * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

type Recovery = NonNullable<McpServerStatusEntry["recovery"]>;
type Episode = {
  attempts: number;
  nextAt: number;
  healthySince?: number;
  state: Recovery["state"];
};
export type NetworkState = "vpn-off" | "network-unavailable" | "unknown";

/** Session-owned maintenance. The same permit reserves turn starts and direct MCP calls.
 * Status reads never invoke a tool. Only an explicitly targeted reconnect may run here. */
export const make = Effect.fn("McpRecovery.make")(function* (input: {
  readonly api: ProviderAdapter.ProviderAdapterV2McpServers;
  readonly driver: ProviderDriverKind;
  readonly isBusy: Effect.Effect<boolean>;
  readonly inspectNetwork: (server: McpServerStatusEntry) => Effect.Effect<NetworkState>;
}) {
  const gate = yield* Semaphore.make(1);
  const scope = yield* Scope.Scope;
  const episodes = new Map<string, Episode>();
  let snapshot: readonly McpServerStatusEntry[] = [];
  let checking = false;
  let closed = false;
  let maintenancePending = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }),
  );
  const busyError = () =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: input.driver,
      detail:
        "Wait for the agent and its background tools to finish before changing MCP connections.",
    });
  const decorate = () =>
    snapshot.map((server) => {
      const episode = episodes.get(server.name);
      return server.status !== "failed" || !episode
        ? server
        : {
            ...server,
            recovery: { state: episode.state, attempts: episode.attempts },
          };
    });
  const read = Effect.gen(function* () {
    const rows = yield* input.api.list().pipe(Effect.timeout("3 seconds"));
    const now = yield* Clock.currentTimeMillis;
    snapshot = rows;
    const names = new Set(rows.map((row) => row.name));
    for (const name of episodes.keys()) if (!names.has(name)) episodes.delete(name);
    for (const row of rows) {
      const episode = episodes.get(row.name);
      if (row.status === "connected" && episode) {
        episode.healthySince ??= now;
        // A briefly successful reconnect must not grant an infinite retry budget.
        if (now - episode.healthySince >= 60_000) episodes.delete(row.name);
      } else if (row.status === "failed") {
        if (episode) delete episode.healthySince;
        else episodes.set(row.name, { attempts: 0, nextAt: 0, state: "waiting" });
      }
    }
    return rows;
  });
  const refresh = read.pipe(Effect.ignore);
  const checkLocked = Effect.gen(function* () {
    if (closed) return decorate();
    // A status failure is not evidence that every server failed. Leave the last
    // observation intact and never reconnect from a stale snapshot.
    const fresh = yield* read.pipe(Effect.result);
    if (fresh._tag === "Failure")
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver: input.driver,
        detail: "MCP health could not be refreshed. No connections were changed.",
      });
    const busy = yield* input.isBusy;
    if (maintenancePending) return decorate();
    const now = yield* Clock.currentTimeMillis;
    for (const server of fresh.success) {
      if (server.status !== "failed" || server.locked) continue;
      const episode = episodes.get(server.name);
      if (!episode) continue;
      if (input.api.reconnectScope !== "server") {
        episode.state = "manual";
        continue;
      }
      if (episode.attempts >= 3) {
        episode.state = "exhausted";
        continue;
      }
      if (busy || episode.nextAt > now) {
        episode.state = "waiting";
        continue;
      }
      const network = yield* input.inspectNetwork(server);
      if (network !== "unknown") {
        episode.state = network;
        continue;
      }
      // Recheck immediately before mutating; another provider action may have
      // restored a connection or requested login since the first observation.
      const confirmed = yield* read.pipe(Effect.result);
      if (confirmed._tag === "Failure") break;
      const current = confirmed.success.find((row) => row.name === server.name);
      if (!current || current.status !== "failed" || current.locked || (yield* input.isBusy))
        continue;
      episode.attempts += 1;
      episode.state = "reconnecting";
      episode.nextAt = now + (episode.attempts === 1 ? 8_000 : 30_000);
      const settled = yield* Deferred.make<void>();
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          maintenancePending = true;
          yield* restore(input.api.reconnect(server.name)).pipe(
            Effect.ignore,
            Effect.ensuring(
              Effect.sync(() => {
                maintenancePending = false;
              }).pipe(Effect.andThen(Deferred.succeed(settled, undefined))),
            ),
            Effect.forkIn(scope),
          );
        }),
      );
      const outcome = yield* Deferred.await(settled).pipe(Effect.timeoutOption("8 seconds"));
      if (Option.isNone(outcome)) {
        // Stopping an SDK Promise wait does not cancel its provider RPC. Keep
        // starts/tools blocked until the real request settles or this session
        // closes, while letting the UI display the pending reconnect.
        episode.attempts = 3;
      }
      episode.state = maintenancePending
        ? "reconnecting"
        : episode.attempts >= 3
          ? "exhausted"
          : "waiting";
      yield* refresh;
      // Bound the pause before a pending turn; additional failed servers are
      // checked on the next observation, never in a long all-server reload.
      break;
    }
    return decorate();
  });
  const check = checkLocked.pipe(gate.withPermits(1));
  const trigger = Effect.suspend(() => {
    if (closed || checking) return Effect.void;
    checking = true;
    return check.pipe(
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          checking = false;
        }),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  });
  // Retry failures only. Healthy sessions incur no periodic status RPCs here.
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("15 seconds");
      if (closed) return;
      if (snapshot.some((row) => row.status === "failed" && !row.locked)) yield* trigger;
    }
  }).pipe(Effect.forkScoped);
  const idle = <A, E>(operation: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      if (closed || maintenancePending || (yield* input.isBusy)) return yield* busyError();
      return yield* ownedRequest(operation);
    }).pipe(gate.withPermits(1));
  // A disconnected UI stops waiting, not the provider's underlying request.
  // Keep that work owned by the session so recovery cannot overlap it.
  const ownedRequest = <A, E>(operation: Effect.Effect<A, E>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const settled = yield* Deferred.make<A, E>();
        maintenancePending = true;
        yield* restore(operation).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(settled, exit)),
          Effect.ensuring(
            Effect.sync(() => {
              maintenancePending = false;
            }),
          ),
          Effect.forkIn(scope),
        );
        return yield* restore(Deferred.await(settled));
      }),
    );
  const api: ProviderAdapter.ProviderAdapterV2McpServers = {
    ...input.api,
    list: () => check,
    reconnect: (name) =>
      idle(
        Effect.gen(function* () {
          if (input.api.reconnectScope !== "server")
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: input.driver,
              detail: "This provider cannot reconnect one MCP without reloading healthy servers.",
            });
          const rows = yield* input.api.list();
          if (!rows.some((row) => row.name === name && row.status === "failed" && !row.locked))
            return;
          episodes.delete(name);
          yield* input.api.reconnect(name);
          yield* refresh;
        }),
      ),
    ...(input.api.reload ? { reload: (options) => idle(input.api.reload!(options)) } : {}),
    setEnabled: (name, enabled) => idle(input.api.setEnabled(name, enabled)),
    startSignIn: (name) => idle(input.api.startSignIn(name)),
    submitCallback: (name, url) => idle(input.api.submitCallback(name, url)),
    signOut: (name) => idle(input.api.signOut(name)),
  };
  const withActivity = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if (maintenancePending || closed)
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: input.driver,
          detail:
            "An MCP operation is still finishing. Wait before starting more work, or close this session.",
        });
      return yield* operation;
    }).pipe(gate.withPermits(1));
  const withToolActivity = <A, E>(operation: Effect.Effect<A, E>) =>
    withActivity(ownedRequest(operation));
  return {
    api,
    trigger,
    check,
    withActivity,
    withToolActivity,
    hasPendingWork: Effect.sync(() => maintenancePending),
    // Used only inside the manager's atomic idle-entry removal guard.
    hasPendingWorkNow: () => maintenancePending,
  };
});
export type McpRecovery = Effect.Success<ReturnType<typeof make>>;
