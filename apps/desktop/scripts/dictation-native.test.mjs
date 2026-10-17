import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { buildDictation, dictationArchitectures } from "./build-dictation.mjs";

// oxlint-disable-next-line starkcode/no-global-process-runtime -- This test compiles a native helper for the actual host.
const hostPlatform = process.platform;

describe.skipIf(hostPlatform !== "darwin")("bundled on-device dictation helper", () => {
  let directory;
  let bundle;
  let executable;
  beforeAll(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-dictation-test-"));
    bundle = NodePath.join(directory, "Stark Dictation.app");
    buildDictation({ arch: "universal", output: bundle });
    executable = NodePath.join(bundle, "Contents/MacOS/stark-dictation");
  }, 60_000);
  afterAll(() => {
    if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("ships a signed executable for both Mac architectures with microphone entitlement", () => {
    const architectures = NodeChildProcess.execFileSync("lipo", ["-archs", executable], {
      encoding: "utf8",
    });
    expect(architectures).toContain("arm64");
    expect(architectures).toContain("x86_64");
    NodeChildProcess.execFileSync("codesign", ["--verify", "--strict", bundle]);
    const signature = NodeChildProcess.spawnSync(
      "codesign",
      ["--display", "--entitlements", "-", bundle],
      { encoding: "utf8" },
    );
    expect(signature.status).toBe(0);
    expect(signature.stdout + signature.stderr).toContain("com.apple.security.device.audio-input");
    const plist = NodeChildProcess.execFileSync(
      "plutil",
      ["-convert", "json", "-o", "-", NodePath.join(bundle, "Contents/Info.plist")],
      { encoding: "utf8" },
    );
    expect(JSON.parse(plist).NSSpeechRecognitionUsageDescription).toContain("on this Mac");
  });

  it("can inspect local language support without starting a microphone or permission request", () => {
    const result = NodeChildProcess.spawnSync(executable, ["--check", "--locale", "en-US"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ supported: expect.any(Boolean), locale: "en-US" });
  });

  it("rejects invalid commands before it could request microphone access", () => {
    const result = NodeChildProcess.spawnSync(executable, ["--invalid"], { encoding: "utf8" });
    expect(result.status).toBe(64);
    expect(JSON.parse(result.stdout).type).toBe("error");
    expect(() => dictationArchitectures("invalid")).toThrow("Unsupported");
  });
});
