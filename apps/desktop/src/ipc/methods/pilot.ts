import {
  PilotActivityInput,
  PilotActivityResponse,
  PilotAnswerResponse,
  PilotAskInput,
  PilotCancelAskResult,
  PilotChatInput,
  PilotChatResponse,
  PilotNudgeInput,
  PilotNudgeResponse,
  PilotSettingsInput,
  PilotSettingsResponse,
  PilotDecideInput,
  PilotDecisionResponse,
  PilotFindingsInput,
  PilotFindingsResponse,
  PilotPauseInput,
  PilotPauseResponse,
  PilotStatusResponse,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Pilot from "../../pilot/Pilot.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { PILOT_CHANNELS } from "../pilotChannels.ts";
import { isTrustedAppSender } from "../trustedAppSender.ts";

class PilotSenderError extends Schema.TaggedError<PilotSenderError>()("PilotSenderError", {}) {
  override get message() {
    return "Pilot is available only to the Stark Code window.";
  }
}

// Findings quote source code, the chat quotes the person's own prompts and
// rules, and decide/pause/ask/nudge/settings change Pilot's state or spend its budget,
// so every method is limited to the app's own window.
const authorized = Effect.fn("desktop.pilot.authorize")(function* (
  event?: DesktopIpc.DesktopIpcInvokeEvent,
) {
  if (!(yield* isTrustedAppSender(event))) return yield* new PilotSenderError();
  return yield* Pilot.Pilot;
});

export const status = DesktopIpc.makeIpcMethod({
  channel: PILOT_CHANNELS.status,
  payload: Schema.Void,
  result: PilotStatusResponse,
  handler: (_input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).status();
    }),
});

export const findings = DesktopIpc.makeIpcMethod({
  channel: PILOT_CHANNELS.findings,
  payload: PilotFindingsInput,
  result: PilotFindingsResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).findings(input);
    }),
});

export const activity = DesktopIpc.makeIpcMethod({
  channel: PILOT_CHANNELS.activity,
  payload: PilotActivityInput,
  result: PilotActivityResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).activity(input);
    }),
});

export const decide = DesktopIpc.makeIpcMethod({
  channel: PILOT_CHANNELS.decide,
  payload: PilotDecideInput,
  result: PilotDecisionResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).decide(input);
    }),
});

export const pause = DesktopIpc.makeIpcMethod({
  channel: PILOT_CHANNELS.pause,
  payload: PilotPauseInput,
  result: PilotPauseResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).pause(input);
    }),
});

export const resume = DesktopIpc.makeIpcMethod({
  channel: PILOT_CHANNELS.resume,
  payload: PilotPauseInput,
  result: PilotPauseResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).resume(input);
    }),
});

export const chat = DesktopIpc.makeIpcMethod({
  channel: PILOT_CHANNELS.chat,
  payload: PilotChatInput,
  result: PilotChatResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).chat(input);
    }),
});

export const ask = DesktopIpc.makeIpcMethod({
  channel: PILOT_CHANNELS.ask,
  payload: PilotAskInput,
  result: PilotAnswerResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).ask(input);
    }),
});

export const cancelAsk = DesktopIpc.makeIpcMethod({
  channel: PILOT_CHANNELS.cancelAsk,
  payload: Schema.Void,
  result: PilotCancelAskResult,
  handler: (_input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).cancelAsk();
    }),
});

export const nudge = DesktopIpc.makeIpcMethod({
  channel: PILOT_CHANNELS.nudge,
  payload: PilotNudgeInput,
  result: PilotNudgeResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).nudge(input);
    }),
});

export const settings = DesktopIpc.makeIpcMethod({
  channel: PILOT_CHANNELS.settings,
  payload: PilotSettingsInput,
  result: PilotSettingsResponse,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).settings(input);
    }),
});
