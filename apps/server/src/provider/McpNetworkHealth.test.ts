import { assert, it } from "@effect/vitest";
import type { McpServerStatusEntry } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeNetworkInspector } from "./McpNetworkHealth.ts";

const server = (fields: Partial<McpServerStatusEntry> = {}): McpServerStatusEntry => ({
  name: "docs",
  status: "failed",
  authKind: "unknown",
  locked: false,
  tools: [],
  ...fields,
});

it.effect("checks only a known tailnet destination with bounded shell-free argv", () =>
  Effect.gen(function* () {
    const commands: unknown[] = [];
    const inspect = makeNetworkInspector(
      (command) =>
        Effect.sync(() => {
          commands.push(command);
          return '{"BackendState":"Stopped"}';
        }),
      "win32",
    );
    for (const endpointHost of [
      "public.example",
      "10.0.0.1",
      "100.64.1.2",
      "localhost",
      "internal.starkfuture.com",
      "https://docs.ts.net/path",
      "alice@docs.ts.net",
      "docs.ts.net/secret",
      "docs.ts.net?token=secret",
    ])
      assert.equal(yield* inspect(server({ endpointHost })), "unknown");
    assert.deepEqual(commands, []);
    assert.equal(yield* inspect(server({ endpointHost: "docs.tail.ts.net" })), "vpn-off");
    assert.deepEqual(commands, [
      {
        executable: "tailscale.exe",
        args: ["status", "--json"],
        timeout: 1500,
        maxBuffer: 65_536,
        killSignal: "SIGKILL",
        shell: false,
        windowsHide: true,
      },
    ]);
  }),
);

it.effect("claims VPN off only for explicit disconnected daemon states", () =>
  Effect.gen(function* () {
    for (const BackendState of ["Stopped", "NeedsLogin"]) {
      const inspect = makeNetworkInspector(
        () => Effect.succeed(JSON.stringify({ BackendState })),
        "linux",
      );
      assert.equal(yield* inspect(server({ endpointHost: "[fd7a:115c:a1e0::1]" })), "vpn-off");
      assert.equal(yield* inspect(server({ endpointHost: "fd7a:115c:a1e0::1" })), "vpn-off");
    }
    for (const output of [
      '{"BackendState":"Running"}',
      '{"BackendState":"Starting"}',
      '{"BackendState":"NeedsMachineAuth"}',
      '{"Self":{"DNSName":"desktop.tail.ts.net"}}',
      "not JSON",
      "x".repeat(65_537),
      "null",
      null,
    ]) {
      const inspect = makeNetworkInspector(() => Effect.succeed(output), "linux");
      assert.equal(yield* inspect(server({ endpointHost: "docs.tail.ts.net" })), "unknown");
    }
  }),
);

it.effect(
  "classifies strong network errors without treating authentication or TLS rejection as VPN failure",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const inspect = makeNetworkInspector(
        () =>
          Effect.sync(() => {
            calls++;
            return null;
          }),
        "linux",
      );
      for (const error of [
        "getaddrinfo ENOTFOUND",
        "EAI_AGAIN",
        "connect ECONNREFUSED",
        "ETIMEDOUT",
        "connection timed out",
      ])
        assert.equal(
          yield* inspect(server({ endpointHost: "public.example", error })),
          "network-unavailable",
        );
      for (const error of [
        "HTTP 401",
        "invalid_grant",
        "certificate expired",
        "tool timed out",
        "server failed",
        "fetch failed",
      ])
        assert.equal(yield* inspect(server({ endpointHost: "public.example", error })), "unknown");
      for (const status of ["connected", "needs-auth", "disabled", "connecting"] as const)
        assert.equal(
          yield* inspect(server({ endpointHost: "docs.tail.ts.net", status, error: "ENOTFOUND" })),
          "unknown",
        );
      assert.equal(calls, 0);
    }),
);

it.effect(
  "shares one short daemon observation across failed connectors and refreshes after recovery",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const inspect = makeNetworkInspector(
        () =>
          Effect.sync(() => {
            calls++;
            return JSON.stringify({ BackendState: calls === 1 ? "Stopped" : "Running" });
          }),
        "linux",
      );
      assert.deepEqual(
        yield* Effect.all(
          [
            inspect(server({ endpointHost: "one.ts.net" })),
            inspect(server({ endpointHost: "two.ts.net" })),
          ],
          { concurrency: "unbounded" },
        ),
        ["vpn-off", "vpn-off"],
      );
      assert.equal(calls, 1);
      yield* TestClock.adjust("15 seconds");
      assert.equal(
        yield* inspect(server({ endpointHost: "one.ts.net", error: "ENETUNREACH" })),
        "unknown",
      );
      assert.equal(calls, 2);
    }),
);

it.effect("degrades missing, failing and stalled host diagnostics without blocking recovery", () =>
  Effect.gen(function* () {
    const endpoint = server({ endpointHost: "docs.ts.net", error: "ENETUNREACH" });
    for (const run of [Effect.succeed(null), Effect.die("bad executable")]) {
      const inspect = makeNetworkInspector(() => run, "linux");
      assert.equal(yield* inspect(endpoint), "network-unavailable");
    }
    const inspect = makeNetworkInspector(() => Effect.never, "linux");
    const fiber = yield* inspect(endpoint).pipe(Effect.forkScoped);
    yield* TestClock.adjust("2 seconds");
    assert.equal(yield* Fiber.join(fiber), "network-unavailable");
  }).pipe(Effect.scoped),
);

const fortiService = (state: string, enabled = true) =>
  `${enabled ? "*" : " "} (${state})   057334A4-B134-4AB8-A6DF-080B36241AE7 VPN (com.fortinet.forticlient.macos.vpn) "VPN" [VPN:com.fortinet.forticlient.macos.vpn]`;

it.effect(
  "identifies enabled disconnected FortiClient on the provider host after a network failure",
  () =>
    Effect.gen(function* () {
      const commands: unknown[] = [];
      const inspect = makeNetworkInspector(
        (command) =>
          Effect.sync(() => {
            commands.push(command);
            return fortiService("Disconnected");
          }),
        "darwin",
      );
      assert.equal(
        yield* inspect(
          server({ endpointHost: "internal.starkfuture.com", error: "getaddrinfo ENOTFOUND" }),
        ),
        "vpn-off",
      );
      assert.deepEqual(commands, [
        {
          executable: "/usr/sbin/scutil",
          args: ["--nc", "list"],
          timeout: 1500,
          maxBuffer: 65_536,
          killSignal: "SIGKILL",
          shell: false,
          windowsHide: true,
        },
      ]);
      for (const error of ["invalid_grant", "HTTP 401", "certificate expired", "unknown failure"])
        assert.equal(yield* inspect(server({ error })), "unknown");
      assert.equal(commands.length, 1);
    }),
);

it.effect(
  "does not infer FortiClient disconnected from other, disabled or transitional VPN services",
  () =>
    Effect.gen(function* () {
      for (const output of [
        fortiService("Disconnected", false),
        fortiService("Disconnected").replaceAll(
          "com.fortinet.forticlient.macos.vpn",
          "com.other.vpn",
        ),
        fortiService("Connecting"),
        `${fortiService("Disconnected")}\n${fortiService("Connecting")}`,
        fortiService("Reasserting"),
        "No configured VPN services",
        null,
      ]) {
        const inspect = makeNetworkInspector(() => Effect.succeed(output), "darwin");
        assert.equal(yield* inspect(server({ error: "ETIMEDOUT" })), "network-unavailable");
      }
      const inspect = makeNetworkInspector(
        () => Effect.succeed(`${fortiService("Disconnected")}\n${fortiService("Connected")}`),
        "darwin",
      );
      assert.equal(yield* inspect(server({ error: "ETIMEDOUT" })), "unknown");
    }),
);

it.effect("refreshes FortiClient state so reconnect can proceed after the VPN returns", () =>
  Effect.gen(function* () {
    let calls = 0;
    const inspect = makeNetworkInspector(
      () =>
        Effect.sync(() => {
          calls++;
          return fortiService(calls === 1 ? "Disconnected" : "Connected");
        }),
      "darwin",
    );
    const failed = server({ error: "ECONNRESET" });
    assert.equal(yield* inspect(failed), "vpn-off");
    assert.equal(yield* inspect(failed), "vpn-off");
    assert.equal(calls, 1);
    yield* TestClock.adjust("15 seconds");
    assert.equal(yield* inspect(failed), "unknown");
    assert.equal(calls, 2);
  }),
);
