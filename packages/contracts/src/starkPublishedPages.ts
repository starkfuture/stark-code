import * as Schema from "effect/Schema";

export const StarkPublishedPagesToolName = Schema.Literals([
  "pages_list_projects",
  "pages_search",
  "pages_read_content",
  "pages_read_file",
  "pages_get_public_url",
]);
export type StarkPublishedPagesToolName = typeof StarkPublishedPagesToolName.Type;
export const StarkPublishedPagesStatus = Schema.Struct({
  state: Schema.Literals(["signed-out", "connecting", "connected", "error"]),
  message: Schema.NullOr(Schema.String),
});
export type StarkPublishedPagesStatus = typeof StarkPublishedPagesStatus.Type;
export const StarkPublishedPagesTool = Schema.Struct({
  name: StarkPublishedPagesToolName,
  title: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Record(Schema.String, Schema.Json),
});
export type StarkPublishedPagesTool = typeof StarkPublishedPagesTool.Type;
export const StarkPublishedPagesReadInput = Schema.Struct({
  tool: StarkPublishedPagesToolName,
  arguments: Schema.Record(Schema.String, Schema.Json),
});
export type StarkPublishedPagesReadInput = typeof StarkPublishedPagesReadInput.Type;
export const StarkPublishedPagesReadResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  structuredContent: Schema.optional(Schema.Json),
  isError: Schema.Boolean,
});
export type StarkPublishedPagesReadResult = typeof StarkPublishedPagesReadResult.Type;
export interface StarkPublishedPagesBridge {
  status(): Promise<StarkPublishedPagesStatus>;
  connect(): Promise<StarkPublishedPagesStatus>;
  disconnect(): Promise<StarkPublishedPagesStatus>;
  listTools(): Promise<readonly StarkPublishedPagesTool[]>;
  read(input: StarkPublishedPagesReadInput): Promise<StarkPublishedPagesReadResult>;
}
