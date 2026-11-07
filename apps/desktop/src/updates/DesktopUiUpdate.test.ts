// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  decodeUiUpdatePolicy,
  encodeUiBundle,
  openUiBundle,
  readUiBundleAsset,
} from "@starkfuture/shared/desktopUiBundle";
import { checkForUiUpdate } from "./DesktopUiUpdate.ts";

const keys = NodeCrypto.generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const target = "pilot:17ca";
const makeBundle = (revision: number, forTarget = target) =>
  encodeUiBundle({
    target: forTarget,
    revision,
    assets: new Map([
      ["index.html", Buffer.from('<script src="/assets/main.js"></script>')],
      ["assets/main.js", Buffer.from("interfaceRevision=" + revision)],
      ["assets/large.bin", Buffer.alloc(2 * 1024 * 1024, 37)],
    ]),
    privateKey: keys.privateKey,
  });

describe("desktop interface update", () => {
  let home: string;
  beforeEach(async () => {
    home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stark-ui-update-test-"));
  });
  afterEach(async () => {
    await NodeFSP.rm(home, { recursive: true, force: true });
  });

  it("pins production origins and limits pilot feeds to an isolated loopback URL", () => {
    expect(() =>
      decodeUiUpdatePolicy(
        {
          kind: "stark",
          target,
          publicKey,
          url: "https://assets.example.test/ui.starkui",
        },
        [],
      ),
    ).toThrow();
    expect(() =>
      decodeUiUpdatePolicy(
        {
          kind: "pilot",
          target,
          publicKey,
          url: "http://192.168.1.1:9876/ui.starkui",
          pilotHome: home,
        },
        [],
      ),
    ).toThrow();
    expect(
      decodeUiUpdatePolicy(
        {
          kind: "pilot",
          target,
          publicKey,
          url: "http://127.0.0.1:9876/ui.starkui",
          pilotHome: home,
        },
        [],
      ),
    ).toMatchObject({ kind: "pilot", pilotHome: home });
  });

  it("rejects an incompatible or incomplete release before serving its entry point", async () => {
    const file = NodePath.join(home, "release.starkui");
    const policy = decodeUiUpdatePolicy(
      {
        kind: "pilot",
        target,
        publicKey,
        url: "http://127.0.0.1:9876/ui.starkui",
        pilotHome: home,
      },
      [],
    );
    await NodeFSP.writeFile(file, makeBundle(1, "another-shell"));
    await expect(openUiBundle(file, policy)).rejects.toThrow(/incompatible/);
    await NodeFSP.writeFile(file, makeBundle(1).subarray(0, -1));
    await expect(openUiBundle(file, policy)).rejects.toThrow(/size/);
    const forged = makeBundle(1);
    forged[12] = (forged[12] ?? 0) ^ 1;
    await NodeFSP.writeFile(file, forged);
    await expect(openUiBundle(file, policy)).rejects.toThrow(/signature/);
  });

  it.effect(
    "stages a signed release, retains an open snapshot and rejects replay or corruption",
    () =>
      Effect.gen(function* () {
        let offered = makeBundle(1);
        const server = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeHttp.Server>((done, fail) => {
                const local = NodeHttp.createServer((_request, response) => {
                  response.writeHead(200, {
                    Connection: "close",
                    "Content-Length": offered.length,
                  });
                  response.end(offered);
                });
                local.once("error", fail).listen(0, "127.0.0.1", () => done(local));
              }),
          ),
          (local) => Effect.promise(() => new Promise<void>((done) => local.close(() => done()))),
        );
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test address");
        const policy = decodeUiUpdatePolicy(
          {
            kind: "pilot",
            target,
            publicKey,
            url: "http://127.0.0.1:" + address.port + "/ui.starkui",
            pilotHome: home,
          },
          [],
        );
        const check = () => checkForUiUpdate(home, policy);
        expect((yield* check()).stagedRevision).toBe(1);
        const active = yield* Effect.acquireRelease(
          Effect.promise(() => openUiBundle(NodePath.join(home, "1.starkui"), policy)),
          (bundle) => Effect.promise(() => bundle.handle.close()),
        );
        offered = makeBundle(2);
        expect((yield* check()).stagedRevision).toBe(2);
        offered = makeBundle(3);
        expect((yield* check()).stagedRevision).toBe(3);
        offered = makeBundle(1);
        expect((yield* check()).stagedRevision).toBeUndefined();
        offered = makeBundle(4);
        const last = offered.length - 1;
        offered[last] = (offered[last] ?? 0) ^ 1;
        expect(yield* Effect.flip(check())).toMatchObject({
          _tag: "UiUpdateError",
          cause: expect.objectContaining({ message: expect.stringMatching(/integrity/) }),
        });
        expect((yield* Effect.promise(() => NodeFSP.readdir(home))).sort()).toEqual([
          "2.starkui",
          "3.starkui",
        ]);
        expect(
          (yield* Effect.promise(() => readUiBundleAsset(active, "assets/main.js"))).toString(),
        ).toBe("interfaceRevision=1");
        const staged = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(home, "3.starkui")),
        );
        expect(staged.equals(makeBundle(3))).toBe(true);
      }),
  );
});
