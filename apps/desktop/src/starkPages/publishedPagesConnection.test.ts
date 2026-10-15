// Real SDK OAuth/PKCE and MCP requests, with an in-memory remote server and a real loopback callback.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off -- exercise the SDK browser callback against a real loopback listener
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { createPublishedPagesConnection } from "./publishedPagesConnection.ts";
import { PAGES_ORIGIN, PublishedPagesFailure } from "./publishedPagesPolicy.ts";
import type { PublishedPagesCredentials, PublishedPagesStore } from "./publishedPagesStore.ts";

function fixture(
  options: {
    storageFails?: boolean;
    saveTokensFails?: boolean;
    refreshFails?: boolean;
    registrationStatus?: number;
    autoCallback?: boolean;
    tokenEndpoint?: string;
  } = {},
) {
  let stored: PublishedPagesCredentials | undefined;
  let authorization: URL | undefined;
  let refreshCount = 0;
  let rejectAccessToken = false;
  let terminated = 0;
  let failedRequest: { method: string; unavailable: boolean } | undefined;
  let toolGate: { started(): void; wait: Promise<void> } | undefined;
  const calls: string[] = [];
  const invoked: string[] = [];
  let notifyBrowser: () => void = () => undefined;
  const browserOpened = new Promise<void>((resolve) => {
    notifyBrowser = resolve;
  });
  const store: PublishedPagesStore = {
    ready: async () => {
      if (options.storageFails) throw new PublishedPagesFailure("storage");
    },
    load: async () => stored,
    save: async (value) => {
      if (value.tokens && options.saveTokensFails) throw new PublishedPagesFailure("storage");
      stored = structuredClone(value);
    },
    clear: async () => {
      stored = undefined;
    },
  };
  const connection = createPublishedPagesConnection({
    store,
    openExternal: async (raw) => {
      authorization = new URL(raw);
      notifyBrowser();
      if (options.autoCallback !== false) {
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        callback.searchParams.set("code", "test-code");
        const response = await fetch(callback);
        expect(response.status).toBe(200);
      }
      return true;
    },
    fetch: async (raw, init) => {
      const url = new URL(raw);
      calls.push(url.pathname);
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.pathname.includes("oauth-protected-resource"))
        return json({
          resource: `${PAGES_ORIGIN}/mcp`,
          authorization_servers: [`${PAGES_ORIGIN}/`],
          scopes_supported: ["google_identity.oauth_login"],
        });
      if (url.pathname.includes("oauth-authorization-server"))
        return json({
          issuer: `${PAGES_ORIGIN}/`,
          authorization_endpoint: `${PAGES_ORIGIN}/authorize`,
          token_endpoint: options.tokenEndpoint ?? `${PAGES_ORIGIN}/token`,
          registration_endpoint: `${PAGES_ORIGIN}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
        });
      if (url.pathname === "/register" && options.registrationStatus)
        return json({ error: "secret must not leak" }, options.registrationStatus);
      if (url.pathname === "/register")
        return json(
          {
            ...JSON.parse(String(init?.body)),
            client_id: "test-client",
            client_secret: "test-client-secret",
          },
          201,
        );
      if (url.pathname === "/token") {
        const params = new URLSearchParams(String(init?.body));
        if (params.get("grant_type") === "refresh_token") {
          refreshCount++;
          if (options.refreshFails)
            return json({ error: "invalid_grant", error_description: "secret must not leak" }, 400);
          rejectAccessToken = false;
        } else {
          expect(params.get("code")).toBe("test-code");
          expect(
            NodeCrypto.createHash("sha256")
              .update(params.get("code_verifier")!)
              .digest("base64url"),
          ).toBe(authorization?.searchParams.get("code_challenge"));
          expect(params.get("redirect_uri")).toBe(authorization?.searchParams.get("redirect_uri"));
        }
        return json({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (url.pathname === "/mcp/") {
        if (rejectAccessToken)
          return new Response("{}", {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${PAGES_ORIGIN}/.well-known/oauth-protected-resource"`,
            },
          });
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-access-token");
        if (init?.method === "GET") return new Response(null, { status: 405 });
        if (init?.method === "DELETE") {
          terminated++;
          return new Response(null, { status: 204 });
        }
        const message = JSON.parse(String(init?.body));
        if (failedRequest && failedRequest.method === message.method) {
          const { unavailable } = failedRequest;
          failedRequest = undefined;
          if (unavailable) return json({ error: "private upstream detail" }, 503);
          throw new Error("private network detail");
        }
        const response = (result: unknown) => json({ jsonrpc: "2.0", id: message.id, result });
        if (message.method === "initialize") {
          const initialized = response({
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "test-pages", version: "1" },
          });
          initialized.headers.set("Mcp-Session-Id", "test-session");
          return initialized;
        }
        if (message.method === "notifications/initialized")
          return new Response(null, { status: 202 });
        if (message.method === "tools/list")
          return response({
            tools: [
              {
                name: "pages_list_projects",
                description: "List projects",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
              {
                name: "pages_read_file",
                description: "Read a file",
                inputSchema: {
                  type: "object",
                  properties: { path: { type: "string", maxLength: 200 } },
                  required: ["path"],
                  additionalProperties: false,
                },
              },
              { name: "pages_upload_commit", inputSchema: { type: "object" } },
            ],
          });
        if (message.method === "tools/call") {
          invoked.push(message.params.name);
          if (toolGate) {
            const gate = toolGate;
            toolGate = undefined;
            gate.started();
            await gate.wait;
          }
          return response({
            content: [
              { type: "text", text: "A page" },
              { type: "resource_link", uri: "https://other.invalid/never-fetch", name: "remote" },
            ],
            structuredContent: { pages: [{ title: "Decision" }] },
          });
        }
      }
      throw new Error("Unexpected test endpoint");
    },
  });
  return {
    connection,
    calls,
    invoked,
    browserOpened,
    store,
    get stored() {
      return stored;
    },
    get authorization() {
      return authorization;
    },
    expire() {
      rejectAccessToken = true;
    },
    get refreshCount() {
      return refreshCount;
    },
    get terminated() {
      return terminated;
    },
    failNextRequest(method: string, unavailable: boolean) {
      failedRequest = { method, unavailable };
    },
    holdNextToolCall() {
      let begin: () => void = () => undefined;
      let release: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        begin = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      toolGate = { started: begin, wait };
      return { started, release };
    },
  };
}

describe("Published Pages connection", () => {
  it("starts only on an explicit click, performs SDK PKCE, and exposes only bounded read tools/results", async () => {
    const test = fixture();
    try {
      expect((await test.connection.status()).state).toBe("signed-out");
      await expect(test.connection.listTools()).rejects.toThrow("Connect to Stark Pages");
      expect(test.calls).toEqual([]);
      expect((await test.connection.connect()).state).toBe("connecting");
      await test.connection.settled();
      expect(await test.connection.status()).toEqual({ state: "connected", message: null });
      const tools = await test.connection.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["pages_list_projects", "pages_read_file"]);
      expect(tools[1]?.inputSchema.required).toEqual(["path"]);
      expect(await test.connection.read({ tool: "pages_list_projects", arguments: {} })).toEqual({
        content: [{ type: "text", text: "A page" }],
        structuredContent: { pages: [{ title: "Decision" }] },
        isError: false,
      });
      expect(test.stored?.tokens?.refresh_token).toBe("test-refresh-token");
      expect(JSON.stringify({ tools, status: await test.connection.status() })).not.toContain(
        "test-client-secret",
      );
      expect(test.terminated).toBe(3);
    } finally {
      await test.connection.dispose();
    }
  });

  it("rejects writes and invalid runtime-schema arguments before invoking any tool", async () => {
    const test = fixture();
    try {
      await test.connection.connect();
      await test.connection.settled();
      // A compromised renderer cannot widen the backend allowlist.
      await expect(
        test.connection.read({ tool: "pages_upload_commit", arguments: {} } as never),
      ).rejects.toThrow("not supported");
      await expect(
        test.connection.read({ tool: "pages_read_file", arguments: {} }),
      ).rejects.toThrow("not supported");
      await expect(
        test.connection.read({
          tool: "pages_read_file",
          arguments: { path: "index.html", injected: true },
        }),
      ).rejects.toThrow("not supported");
      expect(test.invoked).toEqual([]);
      await test.connection.read({ tool: "pages_read_file", arguments: { path: "index.html" } });
      expect(test.invoked).toEqual(["pages_read_file"]);
    } finally {
      await test.connection.dispose();
    }
  });

  it("refreshes its own expired token without another browser sign-in", async () => {
    const test = fixture();
    try {
      await test.connection.connect();
      await test.connection.settled();
      const previousAuthorization = test.authorization;
      test.expire();
      const [tools, result] = await Promise.all([
        test.connection.listTools(),
        test.connection.read({ tool: "pages_list_projects", arguments: {} }),
      ]);
      expect(tools).toHaveLength(2);
      expect(result.isError).toBe(false);
      expect(test.refreshCount).toBe(1);
      expect(test.authorization).toBe(previousAuthorization);
    } finally {
      await test.connection.dispose();
    }
  });

  it.each([
    { method: "tools/list", unavailable: false },
    { method: "tools/call", unavailable: true },
  ])(
    "keeps credentials and retries after a temporary $method failure",
    async ({ method, unavailable }) => {
      const test = fixture();
      try {
        await test.connection.connect();
        await test.connection.settled();
        const credentials = structuredClone(test.stored);
        const authorization = test.authorization;
        const oauthCalls = test.calls.filter((path) => ["/register", "/token"].includes(path));
        test.failNextRequest(method, unavailable);
        const read = () =>
          method === "tools/list"
            ? test.connection.listTools()
            : test.connection.read({ tool: "pages_list_projects", arguments: {} });
        await expect(read()).rejects.toThrow(new PublishedPagesFailure("network").message);
        expect(await test.connection.status()).toEqual({ state: "connected", message: null });
        expect(test.stored).toEqual(credentials);
        await expect(read()).resolves.toBeDefined();
        expect(test.stored).toEqual(credentials);
        expect(test.authorization).toBe(authorization);
        expect(test.calls.filter((path) => ["/register", "/token"].includes(path))).toEqual(
          oauthCalls,
        );
      } finally {
        await test.connection.dispose();
      }
    },
  );

  it("cancels pending OAuth and clears credentials without late callbacks restoring them", async () => {
    const test = fixture({ autoCallback: false });
    await test.connection.connect();
    await test.browserOpened;
    const url = new URL(test.authorization!.searchParams.get("redirect_uri")!);
    await test.connection.disconnect();
    await test.connection.settled();
    expect(await test.connection.status()).toEqual({ state: "signed-out", message: null });
    expect(test.stored).toBeUndefined();
    await expect(fetch(url)).rejects.toThrow();
    await test.connection.dispose();
  });

  it("serializes reads and invalidates queued work when the user disconnects", async () => {
    const test = fixture();
    await test.connection.connect();
    await test.connection.settled();
    const gate = test.holdNextToolCall();
    const first = test.connection.read({ tool: "pages_list_projects", arguments: {} });
    await gate.started;
    const callsBeforeQueue = test.calls.length;
    const queued = test.connection.listTools();
    const outcomes = Promise.allSettled([first, queued]);
    await test.connection.disconnect();
    gate.release();
    expect((await outcomes).map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(test.calls).toHaveLength(callsBeforeQueue);
    expect(test.stored).toBeUndefined();
    await test.connection.dispose();
  });

  it("fails before registration when secure storage is unavailable", async () => {
    const test = fixture({ storageFails: true });
    await test.connection.connect();
    await test.connection.settled();
    expect((await test.connection.status()).message).toContain("securely save");
    expect(test.calls).toEqual([]);
    await test.connection.dispose();
  });

  it.each([400, 401, 403, 500])(
    "reports registration refusal only for a rejected client (%s)",
    async (registrationStatus) => {
      const test = fixture({ registrationStatus });
      try {
        await test.connection.connect();
        await test.connection.settled();
        const status = await test.connection.status();
        expect(status.state).toBe("error");
        expect(status.message).toBe(
          new PublishedPagesFailure(registrationStatus === 500 ? "network" : "registration")
            .message,
        );
        expect(test.authorization).toBeUndefined();
        expect(test.stored).toBeUndefined();
      } finally {
        await test.connection.dispose();
      }
    },
  );

  it("clears a connection when the token cannot be stored securely", async () => {
    const test = fixture({ saveTokensFails: true });
    await test.connection.connect();
    await test.connection.settled();
    expect((await test.connection.status()).state).toBe("error");
    expect((await test.connection.status()).message).toContain("securely save");
    expect(test.stored).toBeUndefined();
    await expect(test.connection.listTools()).rejects.toThrow();
    await test.connection.dispose();
  });

  it("fails closed on a rejected refresh without reopening the browser or leaking server error text", async () => {
    const test = fixture({ refreshFails: true });
    await test.connection.connect();
    await test.connection.settled();
    const authorization = test.authorization;
    test.expire();
    await expect(test.connection.listTools()).rejects.toThrow();
    expect((await test.connection.status()).state).toBe("error");
    expect(JSON.stringify(await test.connection.status())).not.toContain("secret must not leak");
    expect(test.authorization).toBe(authorization);
    expect(test.stored?.tokens).toBeUndefined();
    await test.connection.dispose();
  });

  it("does not send codes or client secrets to a foreign token endpoint advertised by metadata", async () => {
    const test = fixture({ tokenEndpoint: "https://other.invalid/token" });
    await test.connection.connect();
    await test.connection.settled();
    expect((await test.connection.status()).state).toBe("error");
    expect(test.stored).toBeUndefined();
    expect(test.calls).not.toContain("/token");
    await test.connection.dispose();
  });
});
