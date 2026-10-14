import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";
import * as StarkPages from "../../starkPages/StarkPages.ts";

const Root = Schema.String.check(Schema.isMaxLength(4096));
export const findMirror = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STARK_PAGES_MIRROR_CHANNEL,
  payload: Root,
  result: Schema.NullOr(Schema.Struct({ root: Schema.String, port: Schema.Int })),
  handler: Effect.fn("desktop.ipc.starkPages.findMirror")(function* (root) {
    return yield* (yield* StarkPages.StarkPages).findMirror(root);
  }),
});
export const openFollow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STARK_PAGES_OPEN_EXTERNAL_CHANNEL,
  payload: Schema.Struct({ projectRoot: Root, url: Schema.Unknown }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.starkPages.openFollow")(function* (input) {
    return yield* (yield* StarkPages.StarkPages).openFollow(input);
  }),
});
export const openLink = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STARK_PAGES_OPEN_LINK_CHANNEL,
  payload: Schema.Unknown,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.starkPages.openLink")(function* (url) {
    return yield* (yield* StarkPages.StarkPages).openLink(url);
  }),
});
