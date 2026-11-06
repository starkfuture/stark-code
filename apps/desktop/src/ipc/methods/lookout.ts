import {
  LookoutActivityInput,
  LookoutActivityResponse,
  LookoutAnswerResponse,
  LookoutAskInput,
  LookoutCancelAskResult,
  LookoutChatInput,
  LookoutChatResponse,
  LookoutNudgeInput,
  LookoutNudgeResponse,
  LookoutDecideInput,
  LookoutDecisionResponse,
  LookoutFindingsInput,
  LookoutFindingsResponse,
  LookoutPauseInput,
  LookoutPauseResponse,
  LookoutStatusResponse,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Lookout from "../../lookout/Lookout.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { LOOKOUT_CHANNELS } from "../lookoutChannels.ts";
import { isTrustedAppSender } from "../trustedAppSender.ts";

class LookoutSenderError extends Schema.TaggedError<LookoutSenderError>()(
  "LookoutSenderError",
  {},
) {
  override get message() {
    return "Lookout is available only to the Stark Code window.";
  }
}

// Findings quote source code, the chat quotes the person's own prompts and
// rules, and decide/pause/ask/nudge change Lookout's state or spend its budget,
// so every method is limited to the app's own window.
const authorized = Effect.fn("desktop.lookout.authorize")(function* (
  event?: DesktopIpc.DesktopIpcInvokeEvent,
) {
  if (!(yield* isTrustedAppSender(event))) return yield* new LookoutSenderError();
  return yield* Lookout.Lookout;
});

export const status = DesktopIpc.makeIpcMethod({
  channel: LOOKOUT_CHANNELS.status,
  payload: Schema.Void,
  result: LookoutStatusResponse,
  handler: (_input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).status();
    }),
});

export const findings = DesktopIpc.makeIpcMethod({
  channel: LOOKOUT_CHANNELS.findings,
  payload: LookoutFindingsInput,
  result: LookoutFindingsResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).findings(input);
    }),
});

export const activity = DesktopIpc.makeIpcMethod({
  channel: LOOKOUT_CHANNELS.activity,
  payload: LookoutActivityInput,
  result: LookoutActivityResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).activity(input);
    }),
});

export const decide = DesktopIpc.makeIpcMethod({
  channel: LOOKOUT_CHANNELS.decide,
  payload: LookoutDecideInput,
  result: LookoutDecisionResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).decide(input);
    }),
});

export const pause = DesktopIpc.makeIpcMethod({
  channel: LOOKOUT_CHANNELS.pause,
  payload: LookoutPauseInput,
  result: LookoutPauseResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).pause(input);
    }),
});

export const resume = DesktopIpc.makeIpcMethod({
  channel: LOOKOUT_CHANNELS.resume,
  payload: LookoutPauseInput,
  result: LookoutPauseResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).resume(input);
    }),
});

export const chat = DesktopIpc.makeIpcMethod({
  channel: LOOKOUT_CHANNELS.chat,
  payload: LookoutChatInput,
  result: LookoutChatResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).chat(input);
    }),
});

export const ask = DesktopIpc.makeIpcMethod({
  channel: LOOKOUT_CHANNELS.ask,
  payload: LookoutAskInput,
  result: LookoutAnswerResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).ask(input);
    }),
});

export const cancelAsk = DesktopIpc.makeIpcMethod({
  channel: LOOKOUT_CHANNELS.cancelAsk,
  payload: Schema.Void,
  result: LookoutCancelAskResult,
  handler: (_input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).cancelAsk();
    }),
});

export const nudge = DesktopIpc.makeIpcMethod({
  channel: LOOKOUT_CHANNELS.nudge,
  payload: LookoutNudgeInput,
  result: LookoutNudgeResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).nudge(input);
    }),
});
