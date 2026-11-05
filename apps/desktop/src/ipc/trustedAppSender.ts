import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DESKTOP_HOST, getDesktopScheme } from "../electron/ElectronProtocol.ts";
import type * as DesktopIpc from "./DesktopIpc.ts";

/**
 * True only for the app's own main frame: `starkcode://app` (`starkcode-dev://app`
 * in development), or the dev server's origin in development. A mirror iframe, preview webview, or remote
 * page is never trusted with methods that read private state or change it.
 */
export const isTrustedAppSender = (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) =>
  Effect.gen(function* () {
    const window = yield* (yield* ElectronWindow.ElectronWindow).currentMainOrFirst;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const frame = (event as Pick<IpcMainInvokeEvent, "senderFrame" | "sender"> | undefined)
      ?.senderFrame;
    if (
      !event ||
      !frame ||
      Option.isNone(window) ||
      event.sender.id !== window.value.webContents.id ||
      frame !== window.value.webContents.mainFrame
    )
      return false;
    return yield* Effect.try(() => {
      const url = new URL(frame.url);
      if (url.username || url.password) return false;
      return (
        // The app's own scheme for this build: starkcode://app, or starkcode-dev://app in development.
        (url.protocol === `${getDesktopScheme(environment.isDevelopment)}:` &&
          url.hostname === DESKTOP_HOST) ||
        (environment.isDevelopment &&
          Option.isSome(environment.devServerUrl) &&
          url.origin === environment.devServerUrl.value.origin)
      );
    }).pipe(Effect.orElseSucceed(() => false));
  });
