/** Written into private app state so packaged and source launches use the same hook. */
export const nativeReplyHookSource = String.raw`"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
let input = "";
let bytes = 0;
let oversized = false;
let finished = false;
const finish = () => { if (!finished) { finished = true; process.stdout.write("{}\n"); } };
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  bytes += Buffer.byteLength(chunk);
  if (bytes > 1048576) { oversized = true; input = ""; }
  else if (!oversized) input += chunk;
});
process.stdin.on("error", finish);
process.stdin.on("end", () => {
  try {
    if (oversized) return finish();
    const hook = JSON.parse(input);
    if (hook.hook_event_name !== "Stop" || hook.agent_id ||
        typeof hook.session_id !== "string" || !hook.session_id ||
        typeof hook.last_assistant_message !== "string" ||
        !hook.last_assistant_message.trim() ||
        Buffer.byteLength(hook.last_assistant_message) > 131072) return finish();
    const endpoint = new URL(process.env.STARK_NATIVE_REPLY_ENDPOINT || "");
    const token = process.env.STARK_NATIVE_REPLY_TOKEN || "";
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
        endpoint.pathname !== "/native-replies" || endpoint.search || endpoint.hash ||
        endpoint.username || endpoint.password || !/^[a-f0-9]{64}$/.test(token)) return finish();
    const body = JSON.stringify({
      deliveryId: crypto.randomUUID(), hook_event_name: hook.hook_event_name,
      session_id: hook.session_id, turn_id: hook.turn_id ?? null,
      last_assistant_message: hook.last_assistant_message,
      stop_hook_active: hook.stop_hook_active === true
    });
    let attempts = 0;
    const send = () => {
      const request = http.request(endpoint, { method: "POST", headers: {
        authorization: "Bearer " + token, "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      } }, response => { response.resume(); response.on("end", finish); response.on("error", finish); });
      request.on("error", () => { if (++attempts < 2) send(); else finish(); });
      request.setTimeout(2000, () => request.destroy());
      request.end(body);
    };
    send();
  } catch { finish(); }
});
`;

export function nativeReplyHookCommand(input: {
  readonly nodeExecutable: string;
  readonly scriptPath: string;
  readonly platform: NodeJS.Platform;
}): string {
  if (input.platform === "win32") {
    const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
    return `set ELECTRON_RUN_AS_NODE=1&& ${quote(input.nodeExecutable)} ${quote(input.scriptPath)}`;
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `ELECTRON_RUN_AS_NODE=1 ${quote(input.nodeExecutable)} ${quote(input.scriptPath)}`;
}
