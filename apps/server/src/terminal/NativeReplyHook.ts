/** Keep a complete UTF-8 prefix; never split a multibyte character. */
export function truncateNativeReplyText(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= 131_072) return { text, truncated: false };
  let end = 131_072;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/** Written into private app state so packaged and source launches use the same hook. */
export const nativeReplyHookSource = String.raw`"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const truncateReply = ${truncateNativeReplyText.toString()};
let input = "";
let bytes = 0;
let oversized = false;
let finished = false;
const finish = () => { if (!finished) { finished = true; process.stdout.write("{}\n"); } };
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  bytes += Buffer.byteLength(chunk);
  if (bytes > 8388608) { oversized = true; input = ""; }
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
        !hook.last_assistant_message.trim()) return finish();
    const endpoint = new URL(process.env.STARK_NATIVE_REPLY_ENDPOINT || "");
    const token = process.env.STARK_NATIVE_REPLY_TOKEN || "";
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
        endpoint.pathname !== "/native-replies" || endpoint.search || endpoint.hash ||
        endpoint.username || endpoint.password || !/^[a-f0-9]{64}$/.test(token)) return finish();
    const reply = truncateReply(hook.last_assistant_message);
    const body = JSON.stringify({
      deliveryId: crypto.randomUUID(), hook_event_name: hook.hook_event_name,
      session_id: hook.session_id, turn_id: hook.turn_id ?? null,
      last_assistant_message: reply.text, truncated: reply.truncated,
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
  readonly provider: "claude" | "codex";
}): string {
  if (input.platform === "win32" && input.provider === "codex") {
    // Codex invokes Windows command hooks through COMSPEC/cmd.exe. Encoding the
    // PowerShell command keeps %, !, quotes and shell syntax in paths literal.
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const command = `$env:ELECTRON_RUN_AS_NODE='1'; & ${quote(input.nodeExecutable)} ${quote(input.scriptPath)}; exit $LASTEXITCODE`;
    return `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`;
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const shellPath = (value: string) =>
    input.platform === "win32" ? value.replaceAll("\\", "/") : value;
  return `ELECTRON_RUN_AS_NODE=1 ${quote(shellPath(input.nodeExecutable))} ${quote(shellPath(input.scriptPath))}`;
}
