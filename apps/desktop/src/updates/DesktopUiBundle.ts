// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

export const UI_POLICY_FILE = "stark-ui-update.json";
export const MAX_UI_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const MAX_ASSETS = 8192;
const MAGIC = Buffer.from("STARKUI1");
const HEADER_BYTES = MAGIC.length + 4 + 64;
const INDEX = "index.html";

type UiPolicyBase = { readonly target: string; readonly url: string; readonly publicKey: string };
export type UiUpdatePolicy = UiPolicyBase &
  ({ readonly kind: "pilot"; readonly pilotHome: string } | { readonly kind: "stark" });

type AssetRecord = { readonly path: string; readonly bytes: number; readonly sha256: string };
type BundleAsset = AssetRecord & { readonly offset: number };

export interface OpenUiBundle {
  readonly revision: number;
  readonly files: ReadonlyMap<string, BundleAsset>;
  readonly handle: NodeFSP.FileHandle;
}

function asObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Expected an object");
  }
  return input as Record<string, unknown>;
}

function readPublicKey(key: string) {
  const encoded = Buffer.from(key, "base64");
  if (encoded.length !== 44 || encoded.toString("base64") !== key) {
    throw new Error("Invalid UI update key");
  }
  const publicKey = NodeCrypto.createPublicKey({ key: encoded, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Invalid UI update key");
  return publicKey;
}

export function decodeUiUpdatePolicy(
  input: unknown,
  approvedOrigins: ReadonlyArray<string>,
): UiUpdatePolicy {
  const { kind, target, url, publicKey, pilotHome } = asObject(input);
  if (
    typeof target !== "string" ||
    !/^[A-Za-z0-9._:+-]{1,128}$/.test(target) ||
    typeof publicKey !== "string" ||
    publicKey.length > 128 ||
    typeof url !== "string" ||
    url.length > 512
  ) {
    throw new Error("Invalid UI update policy");
  }
  readPublicKey(publicKey);
  const feed = new URL(url);
  if (
    feed.username ||
    feed.password ||
    feed.search ||
    feed.hash ||
    !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.starkui$/.test(feed.pathname) ||
    feed.href !== url
  ) {
    throw new Error("Invalid UI feed URL");
  }
  if (
    kind === "pilot" &&
    feed.protocol === "http:" &&
    feed.hostname === "127.0.0.1" &&
    feed.port &&
    typeof pilotHome === "string" &&
    NodePath.isAbsolute(pilotHome) &&
    NodePath.resolve(pilotHome) === pilotHome
  ) {
    return { kind, target, url, publicKey, pilotHome };
  }
  if (
    kind === "stark" &&
    pilotHome === undefined &&
    feed.protocol === "https:" &&
    approvedOrigins.includes(feed.origin)
  ) {
    return { kind, target, url, publicKey };
  }
  throw new Error("UI feed is outside the approved update origins or pilot profile");
}

function isAssetPath(name: string) {
  return (
    name.length <= 256 &&
    name.split("/").every((part) => part !== "." && part !== ".." && /^[\w.@+-]+$/.test(part))
  );
}

function decodeManifest(bytes: Buffer, target: string) {
  const manifest = asObject(JSON.parse(bytes.toString("utf8")));
  const revision = manifest.revision;
  if (
    manifest.format !== 1 ||
    manifest.target !== target ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > MAX_ASSETS
  ) {
    throw new Error("Invalid UI bundle manifest or incompatible shell");
  }
  const files = new Map<string, BundleAsset>();
  let offset = HEADER_BYTES + bytes.byteLength;
  for (const raw of manifest.files) {
    const { path, bytes, sha256 } = asObject(raw);
    if (
      typeof path !== "string" ||
      !isAssetPath(path) ||
      files.has(path) ||
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_ASSET_BYTES ||
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(sha256)
    ) {
      throw new Error("Invalid UI asset");
    }
    files.set(path, { path, bytes, sha256, offset });
    offset += bytes;
    if (offset > MAX_UI_BUNDLE_BYTES) throw new Error("UI bundle too large");
  }
  if (!files.get(INDEX)?.bytes) throw new Error("UI bundle is missing its entry page");
  return { revision, files, size: offset };
}

async function readExactly(handle: NodeFSP.FileHandle, length: number, offset: number) {
  const buffer = Buffer.alloc(length);
  let cursor = 0;
  while (cursor < length) {
    const { bytesRead } = await handle.read(buffer, cursor, length - cursor, offset + cursor);
    if (bytesRead === 0) throw new Error("Truncated UI bundle");
    cursor += bytesRead;
  }
  return buffer;
}

async function readVerifiedAsset(handle: NodeFSP.FileHandle, asset: BundleAsset) {
  const bytes = await readExactly(handle, asset.bytes, asset.offset);
  if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new Error("UI asset integrity check failed");
  }
  return bytes;
}

export function readUiBundleAsset(bundle: OpenUiBundle, path: string) {
  const asset = bundle.files.get(path);
  if (asset === undefined) throw new Error("Unknown UI asset");
  return readVerifiedAsset(bundle.handle, asset);
}

/** Opens one verified release. The caller owns the handle after a successful open. */
export async function openUiBundle(file: string, policy: UiUpdatePolicy): Promise<OpenUiBundle> {
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_UI_BUNDLE_BYTES || stat.size <= HEADER_BYTES) {
      throw new Error("Invalid UI bundle size");
    }
    const header = await readExactly(handle, HEADER_BYTES, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC))
      throw new Error("Invalid UI bundle header");
    const manifestLength = header.readUInt32BE(MAGIC.length);
    if (manifestLength === 0 || manifestLength > MAX_MANIFEST_BYTES) {
      throw new Error("Invalid UI manifest length");
    }
    const manifestBytes = await readExactly(handle, manifestLength, HEADER_BYTES);
    if (
      !NodeCrypto.verify(
        null,
        manifestBytes,
        readPublicKey(policy.publicKey),
        header.subarray(MAGIC.length + 4),
      )
    ) {
      throw new Error("UI update signature check failed");
    }
    const manifest = decodeManifest(manifestBytes, policy.target);
    if (manifest.size !== stat.size) throw new Error("UI bundle size differs from its manifest");
    for (const asset of manifest.files.values()) await readVerifiedAsset(handle, asset);
    return { revision: manifest.revision, files: manifest.files, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function encodeUiBundle(input: {
  readonly target: string;
  readonly revision: number;
  readonly assets: ReadonlyMap<string, Uint8Array>;
  readonly privateKey: NodeCrypto.KeyObject;
}) {
  if (input.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 key");
  const files = Array.from(input.assets, ([path, bytes]) => ({
    path,
    bytes: bytes.byteLength,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  }));
  const manifest = Buffer.from(
    JSON.stringify({ format: 1, target: input.target, revision: input.revision, files }),
  );
  if (manifest.byteLength > MAX_MANIFEST_BYTES) throw new Error("UI manifest too large");
  decodeManifest(manifest, input.target);
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  header.writeUInt32BE(manifest.byteLength, MAGIC.length);
  NodeCrypto.sign(null, manifest, input.privateKey).copy(header, MAGIC.length + 4);
  return Buffer.concat([header, manifest, ...input.assets.values()]);
}
