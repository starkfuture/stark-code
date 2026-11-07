#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - The archive signer uses Node key objects and file handles.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { encodeUiBundle, MAX_UI_BUNDLE_BYTES } from "@starkfuture/shared/desktopUiBundle";

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      dist: { type: "string" },
      target: { type: "string" },
      revision: { type: "string" },
      "key-file": { type: "string" },
      output: { type: "string" },
    },
  });
  const revision = Number(values.revision);
  if (
    !values.dist ||
    !values.target ||
    !values["key-file"] ||
    !values.output ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new Error(
      "Use --dist <built UI> --target <shell target> --revision <integer> --key-file <PEM> --output <.starkui>",
    );
  }
  const root = NodePath.resolve(values.dist);
  const assets = new Map<string, Uint8Array>();
  let total = 0;
  for (const entry of await NodeFSP.readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) throw new Error("UI build contains a special file or symbolic link");
    if (entry.name.endsWith(".map")) continue;
    const file = NodePath.join(entry.parentPath, entry.name);
    total += (await NodeFSP.stat(file)).size;
    if (total > MAX_UI_BUNDLE_BYTES) throw new Error("UI assets exceed the size limit");
    assets.set(
      NodePath.relative(root, file).split(NodePath.sep).join("/"),
      await NodeFSP.readFile(file),
    );
  }
  const bundle = encodeUiBundle({
    target: values.target,
    revision,
    assets: new Map(
      Array.from(assets.entries()).sort(([left], [right]) => left.localeCompare(right)),
    ),
    privateKey: NodeCrypto.createPrivateKey(await NodeFSP.readFile(values["key-file"])),
  });
  await NodeFSP.writeFile(values.output, bundle, { flag: "wx" });
  process.stdout.write(
    "Wrote signed interface revision " + revision + " (" + bundle.byteLength + " bytes)\n",
  );
}

await main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? error.message : "Could not build UI bundle") + "\n",
  );
  process.exitCode = 1;
});
