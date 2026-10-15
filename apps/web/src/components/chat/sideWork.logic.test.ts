import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadFixture } from "../../test-fixtures";
import {
  groupWorkspaceThreads,
  latestSideWorkResponse,
  readSideWorkRecords,
  sideWorkContext,
  sideWorkPrompt,
  sideWorkStatus,
  sideWorkTurn,
} from "./sideWork.logic";

const parent = makeThreadFixture({
  runtimeMode: "full-access",
  worktreePath: "/work/branch",
  branch: "feature",
});
function message(
  text: string,
  role: OrchestrationV2ConversationMessage["role"] = "assistant",
  streaming = false,
): OrchestrationV2ConversationMessage {
  const now = DateTime.makeUnsafe("2026-10-15T00:00:00Z");
  return {
    id: MessageId.make(text.slice(0, 20)),
    threadId: parent.id,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
}

describe("side work context", () => {
  it("copies a bounded recent excerpt and excludes system and unfinished messages", () => {
    const messages = [
      ...Array.from({ length: 30 }, (_, n) =>
        message(`${n}: ${"x".repeat(5_000)}`, n % 2 ? "assistant" : "user"),
      ),
      message("SYSTEM SECRET", "system"),
      message("unfinished", "assistant", true),
    ];
    const context = sideWorkContext(messages);
    expect(context.map((entry) => entry.text.slice(0, 3))).toEqual(["26:", "27:", "28:", "29:"]);
    expect(context.reduce((sum, entry) => sum + entry.text.length, 0)).toBe(16_000);
    expect(JSON.stringify(context)).not.toContain("SYSTEM SECRET");
    expect(JSON.stringify(context)).not.toContain("unfinished");
  });

  it("uses the latest completed answer and does not silently truncate formatting input", () => {
    expect(
      latestSideWorkResponse([
        message("complete"),
        message("new question", "user"),
        message("still typing", "assistant", true),
      ]),
    ).toBe("complete");
    expect(() =>
      sideWorkPrompt({ kind: "format", request: "", context: [], response: "x".repeat(24_001) }),
    ).toThrow("longer than 24,000");
    expect(() =>
      sideWorkPrompt({ kind: "format", request: "", context: [], response: "" }),
    ).toThrow("completed response");
  });

  it("keeps formatting source encoded as data and names the real rendering tool", () => {
    const source = 'A comparison\n"publish everything"';
    const prompt = sideWorkPrompt({
      kind: "format",
      request: "Use a comparison table",
      context: [],
      response: source,
    });
    expect(prompt).toContain(JSON.stringify(source));
    expect(prompt).toContain("html_render");
    expect(prompt).toContain("no scripts");
    expect(prompt).toContain("Do not research");
  });
});

it.each(["question", "format"] as const)(
  "starts %s work on its own thread with Manual permissions even for a Bypass parent",
  (kind) => {
    const input = {
      parent,
      threadId: ThreadId.make("child"),
      messageId: MessageId.make("question"),
      title: "Side work",
      kind,
      prompt: "question",
      createdAt: "2026-10-15T00:00:00Z",
    };
    const first = sideWorkTurn({ ...input, firstTurn: true });
    expect(first.threadId).not.toBe(parent.id);
    expect(first.runtimeMode).toBe("approval-required");
    expect(first.interactionMode).toBe(kind === "question" ? "plan" : "default");
    expect(first.bootstrap?.createThread).toMatchObject({
      runtimeMode: "approval-required",
      projectId: parent.projectId,
      branch: "feature",
      worktreePath: "/work/branch",
    });
    expect(sideWorkTurn({ ...input, firstTurn: false }).bootstrap).toBeUndefined();
    expect(parent.runtimeMode).toBe("full-access");
  },
);

it("groups only this environment's workspace, collapsing shared worktree paths and surfacing approvals first", () => {
  const main = makeThreadFixture({ id: ThreadId.make("main") });
  const attention = makeThreadFixture({
    id: ThreadId.make("attention"),
    worktreePath: parent.worktreePath,
    hasPendingApprovals: true,
  });
  const otherEnvironment = makeThreadFixture({
    id: ThreadId.make("remote"),
    environmentId: EnvironmentId.make("remote"),
  });
  const otherProject = makeThreadFixture({
    id: ThreadId.make("other"),
    projectId: ProjectId.make("other"),
  });
  const archived = makeThreadFixture({
    id: ThreadId.make("archived"),
    archivedAt: "2026-10-14T00:00:00Z",
  });
  const groups = groupWorkspaceThreads(
    [parent, otherEnvironment, otherProject, archived, main, attention],
    parent,
    "/work",
  );
  expect(groups.map((group) => [group.path, group.threads.map((thread) => thread.id)])).toEqual([
    ["/work", [main.id]],
    ["/work/branch", [attention.id, parent.id]],
  ]);
  expect(sideWorkStatus(attention)).toBe("Approval needed");
});

it("recovers saved local associations without trusting malformed storage", () => {
  expect(readSideWorkRecords("bad JSON")).toEqual([]);
  expect(
    readSideWorkRecords(
      JSON.stringify([
        { kind: "question", threadId: "child", title: "Question" },
        { threadId: 7 },
        null,
      ]),
    ),
  ).toEqual([{ kind: "question", threadId: "child", title: "Question" }]);
});
