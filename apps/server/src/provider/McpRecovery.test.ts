import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, type McpServerStatusEntry } from "@starkfuture/contracts";
import * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as McpRecovery from "./McpRecovery.ts";

const row = (
  name: string,
  status: McpServerStatusEntry["status"],
  locked = false,
): McpServerStatusEntry => ({
  name,
  status,
  locked,
  tools: [],
  authKind: "unknown",
});
const setup = Effect.fn(function* (
  initial: readonly McpServerStatusEntry[],
  options: {
    scope?: "server" | "all";
    reconnect?: (name: string) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>;
    network?: McpRecovery.NetworkState;
  } = {},
) {
  const rows = yield* Ref.make(initial);
  const busy = yield* Ref.make(false);
  const calls: string[] = [];
  const api: ProviderAdapter.ProviderAdapterV2McpServers = {
    reconnectScope: options.scope ?? "server",
    list: () => Ref.get(rows),
    reconnect: (name) =>
      Effect.sync(() => {
        calls.push(name);
      }).pipe(Effect.andThen(options.reconnect?.(name) ?? Effect.void)),
    setEnabled: () => Effect.void,
    startSignIn: () => Effect.succeed({ callbackExpected: false, completed: true }),
    submitCallback: () => Effect.void,
    signOut: () => Effect.void,
  };
  const recovery = yield* McpRecovery.make({
    api,
    driver: ProviderDriverKind.make("claudeAgent"),
    isBusy: Ref.get(busy),
    inspectNetwork: () => Effect.succeed(options.network ?? "unknown"),
  });
  return { recovery, rows, busy, calls };
});

it.effect("checks all statuses but only reconnects failed, enabled, unlocked servers", () =>
  Effect.gen(function* () {
    const s = yield* setup([
      row("good", "connected"),
      row("login", "needs-auth"),
      row("off", "disabled"),
      row("pending", "connecting"),
      row("stark-code", "failed", true),
      row("broken", "failed"),
    ]);
    const result = yield* s.recovery.check;
    assert.deepEqual(s.calls, ["broken"]);
    assert.equal(result.at(-1)?.recovery?.attempts, 1);
  }).pipe(Effect.scoped),
);

it.effect("never calls a global reconnect, including manual per-server actions", () =>
  Effect.gen(function* () {
    const s = yield* setup([row("good", "connected"), row("broken", "failed")], { scope: "all" });
    const result = yield* s.recovery.check;
    assert.equal(result[1]?.recovery?.state, "manual");
    assert.equal((yield* s.recovery.api.reconnect("broken").pipe(Effect.result))._tag, "Failure");
    assert.deepEqual(s.calls, []);
  }).pipe(Effect.scoped),
);

it.effect("observes failures during a turn and repairs only after all work is idle", () =>
  Effect.gen(function* () {
    const s = yield* setup([row("broken", "failed")]);
    yield* Ref.set(s.busy, true);
    assert.equal((yield* s.recovery.check)[0]?.recovery?.state, "waiting");
    assert.deepEqual(s.calls, []);
    assert.equal((yield* s.recovery.api.startSignIn("broken").pipe(Effect.result))._tag, "Failure");
    yield* Ref.set(s.busy, false);
    yield* s.recovery.check;
    assert.deepEqual(s.calls, ["broken"]);
  }).pipe(Effect.scoped),
);

it.effect("turn reservation and direct tool calls wait for an in-flight reconnect", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const s = yield* setup([row("broken", "failed")], {
      reconnect: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    });
    const repair = yield* s.recovery.check.pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const reserved = yield* s.recovery.withActivity(Ref.set(s.busy, true)).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(yield* Ref.get(s.busy), false);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(repair);
    yield* Fiber.join(reserved);
    yield* s.recovery.check;
    assert.deepEqual(s.calls, ["broken"]);
  }).pipe(Effect.scoped),
);

it.effect.each(["vpn-off", "network-unavailable"] as const)("suspends reconnects for %s", (state) =>
  Effect.gen(function* () {
    const s = yield* setup([row("broken", "failed")], { network: state });
    const result = yield* s.recovery.check;
    assert.equal(result[0]?.recovery?.state, state);
    assert.deepEqual(s.calls, []);
  }).pipe(Effect.scoped),
);

it.effect("rechecks immediately before reconnect and preserves an already recovered server", () =>
  Effect.gen(function* () {
    let reads = 0;
    let reconnects = 0;
    const recovery = yield* McpRecovery.make({
      driver: ProviderDriverKind.make("claudeAgent"),
      isBusy: Effect.succeed(false),
      inspectNetwork: () => Effect.succeed("unknown"),
      api: {
        reconnectScope: "server",
        list: () => Effect.sync(() => [row("service", ++reads === 1 ? "failed" : "connected")]),
        reconnect: () =>
          Effect.sync(() => {
            reconnects += 1;
          }),
        setEnabled: () => Effect.void,
        startSignIn: () => Effect.succeed({ callbackExpected: false }),
        submitCallback: () => Effect.void,
        signOut: () => Effect.void,
      },
    });
    yield* recovery.check;
    assert.equal(reconnects, 0);
  }).pipe(Effect.scoped),
);

it.effect("bounds retries across repeated observations and stops on authentication failure", () =>
  Effect.gen(function* () {
    const s = yield* setup([row("broken", "failed")]);
    yield* s.recovery.check;
    yield* s.recovery.check;
    assert.equal(s.calls.length, 1);
    yield* TestClock.adjust("8 seconds");
    yield* s.recovery.check;
    assert.equal(s.calls.length, 2);
    yield* Ref.set(s.rows, [row("broken", "needs-auth")]);
    yield* TestClock.adjust("31 seconds");
    yield* s.recovery.check;
    assert.equal(s.calls.length, 2);
    yield* Ref.set(s.rows, [row("broken", "failed")]);
    yield* s.recovery.check;
    yield* TestClock.adjust("60 seconds");
    const result = yield* s.recovery.check;
    assert.equal(s.calls.length, 3);
    assert.equal(result[0]?.recovery?.state, "exhausted");
  }).pipe(Effect.scoped),
);

it.effect("failed status reads never turn a cached failure into a reconnect", () =>
  Effect.gen(function* () {
    let fail = false;
    let reconnects = 0;
    const recovery = yield* McpRecovery.make({
      driver: ProviderDriverKind.make("claudeAgent"),
      isBusy: Effect.succeed(false),
      inspectNetwork: () => Effect.succeed("unknown"),
      api: {
        reconnectScope: "server",
        list: () =>
          fail
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: ProviderDriverKind.make("claudeAgent"),
                  detail: "Unavailable",
                }),
              )
            : Effect.succeed([row("broken", "failed")]),
        reconnect: () =>
          Effect.sync(() => {
            reconnects += 1;
          }),
        setEnabled: () => Effect.void,
        startSignIn: () => Effect.succeed({ callbackExpected: false }),
        submitCallback: () => Effect.void,
        signOut: () => Effect.void,
      },
    });
    yield* recovery.check;
    fail = true;
    yield* TestClock.adjust("40 seconds");
    assert.equal((yield* recovery.check.pipe(Effect.result))._tag, "Failure");
    assert.equal(reconnects, 1);
  }).pipe(Effect.scoped),
);

it.effect("an RPC timeout never releases new work while the provider is still reconnecting", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const s = yield* setup([row("broken", "failed")], {
      reconnect: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    });
    const check = yield* s.recovery.check.pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("8 seconds");
    assert.equal((yield* Fiber.join(check))[0]?.recovery?.state, "reconnecting");
    let ran = false;
    const start = s.recovery.withActivity(
      Effect.sync(() => {
        ran = true;
      }),
    );
    assert.equal((yield* start.pipe(Effect.result))._tag, "Failure");
    assert.equal(ran, false);
    yield* s.recovery.check;
    assert.equal(s.calls.length, 1);
    yield* Deferred.succeed(finish, undefined);
    yield* Effect.yieldNow;
    yield* start;
    assert.equal(ran, true);
  }).pipe(Effect.scoped),
);

it.effect("a cancelled caller cannot release maintenance during a native tool request", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const s = yield* setup([row("broken", "failed")]);
    const caller = yield* s.recovery
      .withToolActivity(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(caller);
    yield* s.recovery.check;
    assert.equal(s.calls.length, 0);
    assert.equal((yield* s.recovery.withActivity(Effect.void).pipe(Effect.result))._tag, "Failure");
    yield* Deferred.succeed(finish, undefined);
    yield* Effect.yieldNow;
    yield* s.recovery.check;
    assert.equal(s.calls.length, 1);
  }).pipe(Effect.scoped),
);
