import {
  StarkPublishedPagesStatus,
  StarkPublishedPagesOpenInput,
  StarkPublishedPageDocument,
  StarkPublishedPagesTool,
  StarkPublishedPagesReadInput,
  StarkPublishedPagesReadResult,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as PublishedPages from "../../starkPages/PublishedPages.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { PUBLISHED_PAGES_CHANNELS } from "../publishedPagesChannels.ts";
import { isTrustedAppSender } from "../trustedAppSender.ts";

const authorized = Effect.fn("desktop.publishedPages.authorize")(function* (
  event?: DesktopIpc.DesktopIpcInvokeEvent,
) {
  // A mirror iframe, preview webview, or remote page may never access the app's Pages identity.
  if (!(yield* isTrustedAppSender(event)))
    return yield* new PublishedPages.PublishedPagesRequestError({ reason: "invalid" });
  return yield* PublishedPages.PublishedPages;
});

export const status = DesktopIpc.makeIpcMethod({
  channel: PUBLISHED_PAGES_CHANNELS.status,
  payload: Schema.Void,
  result: StarkPublishedPagesStatus,
  handler: (_input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).status();
    }),
});
export const connect = DesktopIpc.makeIpcMethod({
  channel: PUBLISHED_PAGES_CHANNELS.connect,
  payload: Schema.Void,
  result: StarkPublishedPagesStatus,
  handler: (_input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).connect();
    }),
});
export const disconnect = DesktopIpc.makeIpcMethod({
  channel: PUBLISHED_PAGES_CHANNELS.disconnect,
  payload: Schema.Void,
  result: StarkPublishedPagesStatus,
  handler: (_input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).disconnect();
    }),
});
export const listTools = DesktopIpc.makeIpcMethod({
  channel: PUBLISHED_PAGES_CHANNELS.listTools,
  payload: Schema.Void,
  result: Schema.Array(StarkPublishedPagesTool),
  handler: (_input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).listTools();
    }),
});
export const read = DesktopIpc.makeIpcMethod({
  channel: PUBLISHED_PAGES_CHANNELS.read,
  payload: StarkPublishedPagesReadInput,
  result: StarkPublishedPagesReadResult,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).read(input);
    }),
});

export const openPage = DesktopIpc.makeIpcMethod({
  channel: PUBLISHED_PAGES_CHANNELS.openPage,
  payload: StarkPublishedPagesOpenInput,
  result: StarkPublishedPageDocument,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).openPage(input);
    }),
});
