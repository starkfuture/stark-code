import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { BRAND } from "@starkfuture/shared/branding";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  decodeUiUpdatePolicy,
  MAX_UI_BUNDLE_BYTES,
  openUiBundle,
  UI_POLICY_FILE,
  type UiUpdatePolicy,
} from "./DesktopUiBundle.ts";

class UiUpdateError extends Data.TaggedError("UiUpdateError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const decodePolicyJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

function revisionPath(directory: string, revision: number) {
  return NodePath.join(directory, String(revision) + ".starkui");
}

async function cachedRevisions(directory: string) {
  const files = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    },
  );
  return files
    .flatMap((file) => {
      if (!file.isFile() || !/^[1-9]\d*\.starkui$/.test(file.name)) return [];
      const revision = Number(file.name.slice(0, -8));
      return Number.isSafeInteger(revision) ? [revision] : [];
    })
    .sort((a, b) => b - a);
}

async function openNewest(directory: string, policy: UiUpdatePolicy) {
  for (const revision of (await cachedRevisions(directory)).slice(0, 2)) {
    const bundle = await openUiBundle(revisionPath(directory, revision), policy).catch(
      () => undefined,
    );
    if (bundle?.revision === revision) return bundle;
    await bundle?.handle.close();
  }
  return undefined;
}

async function stageVerifiedBundle(
  directory: string,
  pending: string,
  policy: UiUpdatePolicy,
  signal: AbortSignal,
) {
  const bundle = await openUiBundle(pending, policy);
  await bundle.handle.close();
  const [latest = 0] = await cachedRevisions(directory);
  if (bundle.revision <= latest || signal.aborted) return undefined;
  // Concurrent launches cannot overwrite a staged release. Open handles remain
  // usable after older releases are removed from the cache.
  try {
    await NodeFSP.link(pending, revisionPath(directory, bundle.revision));
  } catch (error) {
    if (hasCode(error, "EEXIST")) return undefined;
    throw error;
  }
  const obsolete = (await cachedRevisions(directory)).slice(2);
  await Promise.all(
    obsolete.map((revision) =>
      NodeFSP.unlink(revisionPath(directory, revision)).catch(() => undefined),
    ),
  );
  return bundle.revision;
}

/** Stage a complete signed release for the next server start. */
export const checkForUiUpdate = Effect.fn("DesktopUiUpdate.check")(
  function* (directory: string, policy: UiUpdatePolicy, etag?: string) {
    const response = yield* HttpClient.get(policy.url, {
      headers: {
        "Cache-Control": "no-cache",
        ...(etag === undefined ? {} : { "If-None-Match": etag }),
      },
    });
    if (response.status === 304) return { etag, stagedRevision: undefined };
    if (
      response.status !== 200 ||
      Number(response.headers["content-length"]) > MAX_UI_BUNDLE_BYTES
    ) {
      return yield* Effect.fail(
        new UiUpdateError({ message: "UI feed did not return a bounded release" }),
      );
    }
    yield* Effect.tryPromise(() => NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 }));
    const pending = NodePath.join(directory, ".download-" + NodeCrypto.randomUUID());
    const handle = yield* Effect.acquireRelease(
      Effect.tryPromise(() => NodeFSP.open(pending, "wx", 0o600)),
      (file) =>
        Effect.promise(async () => {
          await file.close().catch(() => undefined);
          await NodeFSP.unlink(pending).catch(() => undefined);
        }),
    );
    let bytes = 0;
    yield* Stream.runForEach(response.stream, (chunk) => {
      bytes += chunk.byteLength;
      return bytes > MAX_UI_BUNDLE_BYTES
        ? Effect.fail(new UiUpdateError({ message: "UI update exceeds size limit" }))
        : Effect.tryPromise({
            try: () => handle.writeFile(chunk),
            catch: (cause) => new UiUpdateError({ message: "Could not write UI bundle", cause }),
          });
    });
    yield* Effect.tryPromise(() => handle.sync());
    const stagedRevision = yield* Effect.tryPromise({
      try: (signal) => stageVerifiedBundle(directory, pending, policy, signal),
      catch: (cause) => new UiUpdateError({ message: "Could not stage UI bundle", cause }),
    });
    const nextEtag = response.headers.etag;
    return { etag: nextEtag && nextEtag.length <= 128 ? nextEtag : undefined, stagedRevision };
  },
  Effect.scoped,
  Effect.timeout("1 minute"),
  // Electron's bundled fetch can assert when a large response closes under backpressure.
  Effect.provide(NodeHttpClient.layerNodeHttp),
);

async function loadPolicy(staticDir: string, baseDir: string) {
  const raw = await NodeFSP.readFile(
    NodePath.join(NodePath.dirname(staticDir), UI_POLICY_FILE),
    "utf8",
  );
  if (raw.length > 4096) throw new Error("Invalid UI update policy");
  const policy = decodeUiUpdatePolicy(decodePolicyJson(raw), BRAND.updateFeedOrigins);
  return policy.kind === "stark" || NodePath.resolve(baseDir) === policy.pilotHome
    ? policy
    : undefined;
}

export const setup = Effect.fn("DesktopUiUpdate.setup")(function* (
  assetDirectory: string,
  baseDir: string,
) {
  if (process.env.STARK_CODE_USE_BUNDLED_UI === "1") return undefined;
  const policy = yield* Effect.tryPromise(() => loadPolicy(assetDirectory, baseDir)).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (policy === undefined) return undefined;

  const cacheKey = NodeCrypto.createHash("sha256")
    .update([policy.target, policy.url, policy.publicKey].join("\0"))
    .digest("hex");
  const directory = NodePath.join(baseDir, "cache", "desktop-ui", cacheKey);
  const active = yield* Effect.acquireRelease(
    Effect.tryPromise(() => openNewest(directory, policy)).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
    (bundle) =>
      Effect.promise(() => bundle?.handle.close().catch(() => undefined) ?? Promise.resolve()),
  );
  if (active)
    yield* Effect.logInfo("Using verified interface update", { revision: active.revision });

  let etag: string | undefined;
  const check = Effect.suspend(() => checkForUiUpdate(directory, policy, etag)).pipe(
    Effect.flatMap((result) => {
      etag = result.etag;
      return result.stagedRevision === undefined
        ? Effect.void
        : Effect.logInfo("Interface update staged for next launch", {
            revision: result.stagedRevision,
          });
    }),
    Effect.catch(() => Effect.logWarning("Interface update check failed")),
  );
  yield* check.pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped);
  return active;
});
