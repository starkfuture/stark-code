// The health probe bounds bytes as they arrive, never follows redirects, and sends no Origin.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  isMirrorFollowUrl,
  isOpenableStarkPageLink,
  type StarkPagesMirror,
} from "@starkfuture/shared/starkPages";
import * as ElectronShell from "../electron/ElectronShell.ts";

const MirrorDescriptor = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 4317, maximum: 4337 })),
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
});
const decodeMirror = Schema.decodeUnknownOption(Schema.fromJsonString(MirrorDescriptor));
const decodeHealth = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ ok: Schema.Literal(true), root: Schema.String, pid: Schema.Int }),
  ),
);

export class StarkPages extends Context.Service<
  StarkPages,
  {
    readonly findMirror: (projectRoot: string) => Effect.Effect<StarkPagesMirror | null>;
    readonly openFollow: (input: {
      readonly projectRoot: string;
      readonly url: unknown;
    }) => Effect.Effect<boolean>;
    readonly openLink: (url: unknown) => Effect.Effect<boolean>;
  }
>()("@starkfuture/desktop/starkPages/StarkPages") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shell = yield* ElectronShell.ElectronShell;
  const findMirror = Effect.fn("StarkPages.findMirror")(function* (projectRoot: string) {
    if (projectRoot.length > 4096 || !path.isAbsolute(projectRoot)) return null;
    const root = path.resolve(projectRoot);
    const file = path.join(root, "pages", ".spage", "mirror.json");
    const stat = yield* fs.stat(file).pipe(Effect.option);
    if (Option.isNone(stat) || stat.value.type !== "File" || Number(stat.value.size) > 8192)
      return null;
    const text = yield* fs.readFileString(file).pipe(Effect.option);
    if (Option.isNone(text)) return null;
    const descriptor = decodeMirror(text.value);
    if (Option.isNone(descriptor)) return null;
    const mirror = descriptor.value;
    return yield* Effect.callback<StarkPagesMirror | null>((resume) => {
      let settled = false;
      const finish = (result: StarkPagesMirror | null) => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed(result));
      };
      // A single Node request sends no Origin and never follows redirects.
      // The secret stays here; the renderer receives only the validated port/root.
      const request = NodeHttp.request(
        {
          hostname: "127.0.0.1",
          port: mirror.port,
          method: "GET",
          path: "/health",
          headers: { "X-Spage-Token": mirror.token },
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            finish(null);
            return;
          }
          response.setEncoding("utf8");
          let body = "";
          response.on("data", (chunk: string) => {
            body += chunk;
            if (Buffer.byteLength(body) > 8192) {
              request.destroy();
              finish(null);
            }
          });
          response.on("error", () => finish(null));
          response.on("end", () => {
            const health = decodeHealth(body);
            finish(
              Option.isSome(health) &&
                path.resolve(health.value.root) === root &&
                health.value.pid === mirror.pid
                ? { root, port: mirror.port }
                : null,
            );
          });
        },
      );
      request.on("error", () => finish(null));
      request.setTimeout(2000, () => {
        request.destroy();
        finish(null);
      });
      request.end();
      return Effect.sync(() => request.destroy());
    });
  });
  const openFollow = Effect.fn("StarkPages.openFollow")(function* (input: {
    readonly projectRoot: string;
    readonly url: unknown;
  }) {
    const mirror = yield* findMirror(input.projectRoot);
    if (mirror === null || !isMirrorFollowUrl(input.url, mirror.port)) return false;
    return yield* shell.openExternal(input.url);
  });
  return StarkPages.of({
    findMirror,
    openFollow,
    openLink: (raw) =>
      isOpenableStarkPageLink(raw) ? shell.openExternal(raw) : Effect.succeed(false),
  });
});

export const layer = Layer.effect(StarkPages, make);
