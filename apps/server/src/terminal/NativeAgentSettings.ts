import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeUnknownEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);
class NativeAgentSettingsInvalidError extends Schema.TaggedError<NativeAgentSettingsInvalidError>()(
  "NativeAgentSettingsInvalidError",
  {},
) {
  override get message() {
    return "Custom Claude settings must contain a JSON object.";
  }
}

export function mergeNativeSettings(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const previous = result[key];
    Object.defineProperty(result, key, {
      value: isObject(previous) && isObject(value) ? mergeNativeSettings(previous, value) : value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/** Preserve custom settings files while adding the per-session supervision policy. */
export const prepareNativeClaudeSettings = Effect.fn("terminal.prepareNativeClaudeSettings")(
  function* (input: {
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly home: string;
    readonly stateDir: string;
    readonly lifetime: Scope.Scope;
  }) {
    const sources: string[] = [];
    const args: string[] = [];
    for (let index = 0; index < input.args.length; index++) {
      const arg = input.args[index]!;
      if (arg === "--settings") sources.push(input.args[++index] ?? "");
      else if (arg.startsWith("--settings=")) sources.push(arg.slice("--settings=".length));
      else args.push(arg);
    }
    if (sources.length < 2) return [...input.args];
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let merged: Record<string, unknown> = {};
    for (const source of sources) {
      const text = source.trim().startsWith("{")
        ? source
        : yield* fs.readFileString(path.resolve(input.cwd, expandHomePath(source, input.home)));
      const value = yield* decodeSettings(text).pipe(
        Effect.mapError(() => new NativeAgentSettingsInvalidError({})),
      );
      merged = mergeNativeSettings(merged, value);
    }
    const cache = path.join(input.stateDir, "cache", "native-agent-settings");
    yield* fs.makeDirectory(cache, { recursive: true, mode: 0o700 });
    const directory = yield* fs.makeTempDirectory({ directory: cache, prefix: "session-" });
    const filename = path.join(directory, "settings.json");
    const serialized = yield* encodeSettings(merged).pipe(
      Effect.mapError(() => new NativeAgentSettingsInvalidError({})),
    );
    yield* fs.writeFileString(filename, serialized, { mode: 0o600 });
    yield* Scope.addFinalizer(
      input.lifetime,
      fs.remove(directory, { recursive: true }).pipe(Effect.ignore),
    );
    return [...args, "--settings", filename];
  },
);
