import { describe, expect, it } from "vite-plus/test";
import { createNativeMcpWarningDetector } from "./nativeMcpWarning";

describe("native MCP warning detection", () => {
  it.each([
    ['MCP server "pages" needs authentication', "sign-in"],
    ['⎿  Error: MCP server "pages" rejected the session credential (HTTP 401)', "sign-in"],
    ["MCP authentication required. Reconnect to continue using this server.", "sign-in"],
    ['MCP server "pages" is not connected: private diagnostic', "connection"],
    ["⚠ MCP client for `pages` failed to start: private diagnostic", "connection"],
    ["⚠ MCP startup incomplete (failed: pages)", "connection"],
    ["MCP startup incomplete: pages", "connection"],
  ] as const)("recognizes a provider diagnostic: %s", (text, expected) => {
    expect(createNativeMcpWarningDetector().read(text)).toBe(expected);
  });

  it("reads split text, ANSI colors and split control sequences", () => {
    const detector = createNativeMcpWarningDetector();
    expect(detector.read("\u001b[")).toBeUndefined();
    expect(detector.read("31m⚠ MCP client for `pa")).toBeUndefined();
    expect(detector.read("ges` failed to st")).toBeUndefined();
    expect(detector.read("art\u001b[0m: https://private.example/token\n")).toBe("connection");
    expect(detector.read("\u001b]8;;https://private.example\u001b")).toBeUndefined();
    expect(detector.read('\\MCP server "pages" needs authentication\u001b]8;;\u0007')).toBe(
      "sign-in",
    );
  });

  it("ignores OSC contents, ordinary conversation, commands and tool failures", () => {
    const detector = createNativeMcpWarningDetector();
    for (const text of [
      'The MCP server "pages" is not connected in this example.',
      'If MCP server "pages" needs authentication, use Settings.',
      "$ echo 'MCP server \"pages\" is not connected'",
      '> MCP server "pages" is not connected',
      "MCP tool call failed: invalid arguments",
      'MCP server "pages" connected successfully',
      "MCP startup completed",
      '\u001b]0;MCP server "pages" needs authentication\u0007normal output',
    ])
      expect(detector.read(`${text}\n`)).toBeUndefined();
    expect(detector.read('```text\nMCP server "pages" is not connected\n```\n')).toBeUndefined();
    expect(detector.read('MCP server "pages" is not connected\n')).toBe("connection");
  });

  it("bounds a long line without treating its suffix as a new diagnostic", () => {
    const detector = createNativeMcpWarningDetector();
    expect(detector.read("x".repeat(100_000))).toBeUndefined();
    expect(detector.read('MCP server "pages" needs authentication')).toBeUndefined();
    expect(detector.read('\nMCP server "pages" needs authentication')).toBe("sign-in");
  });

  it("detects snapshot history and deduplicates repaint without downgrading auth", () => {
    const detector = createNativeMcpWarningDetector();
    expect(detector.read('old prompt\nMCP server "pages" is not connected\n', true)).toBe(
      "connection",
    );
    expect(detector.read('MCP server "pages" is not connected\r')).toBeUndefined();
    expect(detector.read('MCP server "pages" needs authentication\r')).toBe("sign-in");
    expect(detector.read('MCP server "pages" is not connected\r')).toBeUndefined();
    expect(detector.read("MCP client for `other` failed to start\n", true)).toBe("connection");
  });
});
