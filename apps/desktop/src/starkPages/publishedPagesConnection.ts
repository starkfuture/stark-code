// The official MCP SDK owns OAuth/PKCE and MCP framing. This adapter owns its app-local session.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  StarkPublishedPagesBridge,
  StarkPublishedPagesStatus,
  StarkPublishedPagesReadInput,
  StarkPublishedPagesReadResult,
  StarkPublishedPagesTool,
} from "@starkfuture/contracts";
import {
  boundedJson,
  isReadTool,
  PAGES_MCP_URL,
  PAGES_ORIGIN,
  PAGES_SCOPE,
  pinnedPagesFetch,
  PublishedPagesFailure,
  sanitizeReadResult,
  sanitizeReadTool,
} from "./publishedPagesPolicy.ts";
import { pagesOAuthCallback } from "./publishedPagesCallback.ts";
import type { PublishedPagesCredentials, PublishedPagesStore } from "./publishedPagesStore.ts";

const disconnected: StarkPublishedPagesStatus = { state: "signed-out", message: null };
export interface PublishedPagesConnection extends StarkPublishedPagesBridge {
  dispose(): Promise<void>;
  /** Lifecycle/test synchronization; never exposed over IPC. */
  settled(): Promise<void>;
}

export function createPublishedPagesConnection(input: {
  store: PublishedPagesStore;
  openExternal(url: string): Promise<boolean>;
  fetch?: FetchLike;
}): PublishedPagesConnection {
  let status: StarkPublishedPagesStatus = disconnected;
  let credentials: PublishedPagesCredentials | undefined;
  let loaded = false;
  let loading: Promise<void> | undefined;
  let generation = 0;
  let pending: Promise<void> = Promise.resolve();
  let requestQueue: Promise<void> = Promise.resolve();
  const controllers = new Set<AbortController>();
  const failure = (error: unknown) =>
    error instanceof PublishedPagesFailure ? error : new PublishedPagesFailure("network");
  const current = (expected: number) => {
    if (expected !== generation) throw new PublishedPagesFailure("cancelled");
  };
  const load = async () => {
    if (loaded) return;
    if (!loading)
      loading = (async () => {
        try {
          credentials = await input.store.load();
          if (credentials?.tokens) status = { state: "connected", message: null };
        } catch {
          status = { state: "error", message: new PublishedPagesFailure("storage").message };
        } finally {
          loaded = true;
        }
      })();
    await loading;
  };

  const provider = (
    expected: number,
    options?: { redirectUrl: string; state: string },
  ): OAuthClientProvider => {
    let verifier: string | undefined;
    let discovery: Awaited<ReturnType<NonNullable<OAuthClientProvider["discoveryState"]>>>;
    const persist = async () => {
      current(expected);
      if (!credentials) throw new PublishedPagesFailure("auth");
      await input.store.save(credentials);
      current(expected);
    };
    return {
      get redirectUrl() {
        return options?.redirectUrl ?? credentials?.redirectUrl;
      },
      get clientMetadata() {
        const redirect = options?.redirectUrl ?? credentials?.redirectUrl;
        if (!redirect) throw new PublishedPagesFailure("auth");
        return {
          client_name: "Stark Code",
          redirect_uris: [redirect],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post",
          scope: PAGES_SCOPE,
        };
      },
      state: () => {
        if (!options) throw new PublishedPagesFailure("auth");
        return options.state;
      },
      clientInformation: () => {
        current(expected);
        return credentials?.registration;
      },
      saveClientInformation: async (client) => {
        current(expected);
        if (!options) throw new PublishedPagesFailure("auth");
        credentials = { version: 1, redirectUrl: options.redirectUrl, registration: client };
        await persist();
      },
      tokens: () => {
        current(expected);
        return credentials?.tokens;
      },
      saveTokens: async (tokens) => {
        current(expected);
        if (!credentials) throw new PublishedPagesFailure("auth");
        credentials = { ...credentials, tokens };
        try {
          await persist();
        } catch (error) {
          credentials = undefined;
          throw error;
        }
      },
      redirectToAuthorization: async (url) => {
        current(expected);
        if (!options) throw new PublishedPagesFailure("auth");
        if (
          url.origin !== PAGES_ORIGIN ||
          url.pathname !== "/authorize" ||
          url.username ||
          url.password ||
          url.hash ||
          url.searchParams.get("state") !== options.state ||
          url.searchParams.get("redirect_uri") !== options.redirectUrl ||
          url.searchParams.get("code_challenge_method") !== "S256" ||
          !url.searchParams.get("code_challenge") ||
          url.searchParams.get("scope") !== PAGES_SCOPE
        )
          throw new PublishedPagesFailure("invalid");
        if (!(await input.openExternal(url.href))) throw new PublishedPagesFailure("network");
        current(expected);
        status = { state: "connecting", message: "Complete Stark Pages sign-in in your browser." };
      },
      saveCodeVerifier: (value) => {
        current(expected);
        verifier = value;
      },
      codeVerifier: () => {
        if (!verifier) throw new PublishedPagesFailure("auth");
        return verifier;
      },
      validateResourceURL: async (_url, resource) => {
        const expectedResource = `${PAGES_ORIGIN}/mcp`;
        if (resource && resource.replace(/\/$/, "") !== expectedResource)
          throw new PublishedPagesFailure("invalid");
        return new URL(expectedResource);
      },
      saveDiscoveryState: (value) => {
        current(expected);
        discovery = value;
      },
      discoveryState: () => discovery,
      invalidateCredentials: async (scope) => {
        current(expected);
        if (scope === "discovery" || scope === "all") discovery = undefined;
        if (scope === "verifier" || scope === "all") verifier = undefined;
        if (scope === "all" || scope === "client") {
          credentials = undefined;
          await input.store.clear();
        } else if (scope === "tokens" && credentials) {
          const { tokens: _tokens, ...remaining } = credentials;
          credentials = remaining;
          await persist();
        }
      },
    };
  };

  const withClient = async <T>(
    operation: (client: Client) => Promise<T>,
    expected: number,
    oauth?: OAuthClientProvider,
  ): Promise<T> => {
    current(expected);
    if (!credentials?.tokens) throw new PublishedPagesFailure("auth");
    const controller = new AbortController();
    controllers.add(controller);
    const client = new Client({ name: "stark-code-pages", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(PAGES_MCP_URL), {
      authProvider: oauth ?? provider(expected),
      fetch: pinnedPagesFetch(input.fetch, controller.signal),
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
    // SDK errors may include OAuth response bodies. Never log them or forward them to the renderer.
    client.onerror = () => undefined;
    try {
      // Adapt SDK1.29's exact-optional mismatch without weakening our compiler settings.
      // The HTTP transport retains the MCP session ID internally for every request.
      const wire: Transport = {
        start: async () => {
          transport.onclose = () => wire.onclose?.();
          transport.onerror = (error) => wire.onerror?.(error);
          transport.onmessage = (message) => wire.onmessage?.(message);
          await transport.start();
        },
        send: (message, options) => transport.send(message, options),
        close: () => transport.close(),
        setProtocolVersion: (version) => transport.setProtocolVersion(version),
      };
      await client.connect(wire, { timeout: 30_000 });
      const result = await operation(client);
      current(expected);
      return result;
    } finally {
      if (transport.sessionId && !controller.signal.aborted && expected === generation)
        await transport.terminateSession().catch(() => undefined);
      controller.abort();
      controllers.delete(controller);
      await client.close().catch(() => undefined);
    }
  };
  const tools = async (client: Client): Promise<StarkPublishedPagesTool[]> => {
    const found: StarkPublishedPagesTool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
      for (const tool of result.tools) {
        const allowed = sanitizeReadTool(tool);
        if (allowed && !found.some((entry) => entry.name === allowed.name)) found.push(allowed);
      }
      if (!result.nextCursor) return found;
      if (seen.has(result.nextCursor)) throw new PublishedPagesFailure("invalid");
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new PublishedPagesFailure("limit");
  };
  const request = <T>(operation: (client: Client) => Promise<T>): Promise<T> => {
    // Capture before queueing: sign-out cancels queued reads as well as active requests.
    const expected = generation;
    const result = requestQueue.then(async () => {
      current(expected);
      await load();
      current(expected);
      if (status.state !== "connected") throw new PublishedPagesFailure("auth");
      try {
        return await withClient(operation, expected);
      } catch (error) {
        const safe = failure(error);
        if (expected === generation && ["auth", "storage"].includes(safe.reason))
          status = { state: "error", message: safe.message };
        throw safe;
      }
    });
    requestQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const cancel = () => {
    generation++;
    for (const controller of controllers) controller.abort();
    controllers.clear();
  };

  return {
    status: async () => {
      await load();
      return status;
    },
    connect: async () => {
      await load();
      if (status.state === "connecting" || status.state === "connected") return status;
      cancel();
      const expected = generation;
      const controller = new AbortController();
      controllers.add(controller);
      status = { state: "connecting", message: "Opening Stark Pages sign-in…" };
      pending = (async () => {
        let callback: Awaited<ReturnType<typeof pagesOAuthCallback>> | undefined;
        try {
          await input.store.ready();
          current(expected);
          credentials = undefined;
          await input.store.clear();
          current(expected);
          const state = NodeCrypto.randomBytes(32).toString("hex");
          callback = await pagesOAuthCallback(state, controller.signal);
          current(expected);
          const oauth = provider(expected, { redirectUrl: callback.url, state });
          const options = {
            serverUrl: PAGES_MCP_URL,
            scope: PAGES_SCOPE,
            resourceMetadataUrl: new URL(`${PAGES_ORIGIN}/.well-known/oauth-protected-resource`),
            fetchFn: pinnedPagesFetch(input.fetch, controller.signal),
          };
          const outcome = await auth(oauth, options);
          if (outcome === "REDIRECT") {
            const authorizationCode = await callback.code;
            current(expected);
            status = { state: "connecting", message: "Finishing Stark Pages sign-in…" };
            if ((await auth(oauth, { ...options, authorizationCode })) !== "AUTHORIZED")
              throw new PublishedPagesFailure("auth");
          }
          await withClient(tools, expected, oauth);
          current(expected);
          status = { state: "connected", message: null };
        } catch (error) {
          if (expected === generation) {
            credentials = undefined;
            status = { state: "error", message: failure(error).message };
            await input.store.clear().catch(() => {
              status = { state: "error", message: new PublishedPagesFailure("storage").message };
            });
          }
        } finally {
          callback?.close();
          controller.abort();
          controllers.delete(controller);
        }
      })();
      return status;
    },
    disconnect: async () => {
      await load();
      cancel();
      credentials = undefined;
      try {
        await input.store.clear();
        status = disconnected;
      } catch {
        status = { state: "error", message: new PublishedPagesFailure("storage").message };
      }
      return status;
    },
    listTools: () => request(tools),
    read: (value: StarkPublishedPagesReadInput): Promise<StarkPublishedPagesReadResult> => {
      if (!isReadTool(value.tool)) return Promise.reject(new PublishedPagesFailure("invalid"));
      return request(async (client) => {
        const args = boundedJson(value.arguments, 32 * 1024);
        const schema = (await tools(client)).find(
          (entry) => entry.name === value.tool,
        )?.inputSchema;
        if (!schema) throw new PublishedPagesFailure("invalid");
        try {
          if (!new AjvJsonSchemaValidator().getValidator(schema)(args).valid)
            throw new PublishedPagesFailure("invalid");
        } catch {
          throw new PublishedPagesFailure("invalid");
        }
        const result = await client.callTool(
          { name: value.tool, arguments: value.arguments },
          undefined,
          { timeout: 30_000 },
        );
        return sanitizeReadResult(result);
      });
    },
    dispose: async () => {
      cancel();
      await Promise.all([pending, requestQueue]);
    },
    settled: () => pending,
  };
}
