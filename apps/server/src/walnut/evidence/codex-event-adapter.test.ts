import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyCodexEvent } from "./codex-event-adapter.js";

// The real, sanitized Codex JSONL stream captured during P0-5/P0-6 (results/
// p0-5-real-codex-jsonl.sanitized.ndjson) — 12 lines, one turn with an early metadata error, two
// command executions, and a final turn.completed with usage.
const FIXTURE_PATH = fileURLToPath(
  new URL("../../../../../results/p0-5-real-codex-jsonl.sanitized.ndjson", import.meta.url),
);

async function loadFixtureLines(): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  return raw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("classifyCodexEvent — real sanitized Codex JSONL fixture (12 lines)", () => {
  it("classifies every line in the fixture exactly as pinned", async () => {
    const lines = await loadFixtureLines();
    expect(lines).toHaveLength(12);

    // 1. thread.started
    expect(classifyCodexEvent(lines[0] as Record<string, unknown>)).toMatchObject({
      kind: "runtime.thread",
      runtimeType: "thread.started",
      runtimeItemId: null,
      status: "observed",
      summarySource: null,
      metadata: { threadId: "[REDACTED_THREAD_ID]" },
    });

    // 2. item.completed / item.type "error" -> runtime.error, always observed
    expect(classifyCodexEvent(lines[1] as Record<string, unknown>)).toMatchObject({
      kind: "runtime.error",
      runtimeType: "item.completed:error",
      runtimeItemId: "item_0",
      status: "observed",
      summarySource:
        "Model metadata for [REDACTED_ENDPOINT_ID] not found. Defaulting to fallback metadata; this can degrade performance and cause issues.",
    });

    // 3. turn.started
    expect(classifyCodexEvent(lines[2] as Record<string, unknown>)).toMatchObject({
      kind: "runtime.turn",
      runtimeType: "turn.started",
      runtimeItemId: null,
      status: "started",
      summarySource: null,
    });

    // 4. item.completed / agent_message (item_1)
    expect(classifyCodexEvent(lines[3] as Record<string, unknown>)).toMatchObject({
      kind: "runtime.message",
      runtimeType: "item.completed:agent_message",
      runtimeItemId: "item_1",
      status: "completed",
      summarySource:
        "I'll inspect the current file, then replace its contents with the new version without a trailing newline.",
    });

    // 5. item.started / command_execution (item_2, exit_code null)
    expect(classifyCodexEvent(lines[4] as Record<string, unknown>)).toMatchObject({
      kind: "runtime.command",
      runtimeType: "item.started:command_execution",
      runtimeItemId: "item_2",
      status: "started",
      summarySource: "/usr/bin/bash -lc 'cat -A phase0.txt'",
    });

    // 6. item.completed / command_execution (item_2, exit_code 0)
    expect(classifyCodexEvent(lines[5] as Record<string, unknown>)).toMatchObject({
      kind: "runtime.command",
      runtimeType: "item.completed:command_execution",
      runtimeItemId: "item_2",
      status: "completed",
      summarySource: "/usr/bin/bash -lc 'cat -A phase0.txt'",
    });

    // 7. item.started / command_execution (item_4)
    expect(classifyCodexEvent(lines[6] as Record<string, unknown>)).toMatchObject({
      kind: "runtime.command",
      runtimeType: "item.started:command_execution",
      runtimeItemId: "item_4",
      status: "started",
    });

    // 8. item.completed / command_execution (item_4, exit_code 0)
    expect(classifyCodexEvent(lines[7] as Record<string, unknown>)).toMatchObject({
      kind: "runtime.command",
      runtimeType: "item.completed:command_execution",
      runtimeItemId: "item_4",
      status: "completed",
    });

    // 9. item.started / command_execution (item_6)
    expect(classifyCodexEvent(lines[8] as Record<string, unknown>)).toMatchObject({
      kind: "runtime.command",
      runtimeType: "item.started:command_execution",
      runtimeItemId: "item_6",
      status: "started",
    });

    // 10. item.completed / command_execution (item_6, exit_code 0)
    expect(classifyCodexEvent(lines[9] as Record<string, unknown>)).toMatchObject({
      kind: "runtime.command",
      runtimeType: "item.completed:command_execution",
      runtimeItemId: "item_6",
      status: "completed",
    });

    // 11. item.completed / agent_message (item_7)
    expect(classifyCodexEvent(lines[10] as Record<string, unknown>)).toMatchObject({
      kind: "runtime.message",
      runtimeType: "item.completed:agent_message",
      runtimeItemId: "item_7",
      status: "completed",
      summarySource: "Perfect! The file now contains the requested value with no trailing newline. SECOND_TURN_OK",
    });

    // 12. turn.completed with usage
    expect(classifyCodexEvent(lines[11] as Record<string, unknown>)).toMatchObject({
      kind: "runtime.turn",
      runtimeType: "turn.completed",
      runtimeItemId: null,
      status: "completed",
      summarySource: null,
      metadata: { inputTokens: 51920, cachedInputTokens: 0, outputTokens: 414 },
    });
  });
});

describe("classifyCodexEvent — edge cases outside the fixture", () => {
  it("an unrecognised top-level type becomes runtime.unknown, never dropped", () => {
    expect(classifyCodexEvent({ type: "session.rotated", foo: "bar" })).toEqual({
      kind: "runtime.unknown",
      runtimeType: "session.rotated",
      runtimeItemId: null,
      status: "observed",
      summarySource: null,
      metadata: {},
    });
  });

  it("a missing/non-string type becomes runtime.unknown with a null runtimeType", () => {
    expect(classifyCodexEvent({ foo: "bar" })).toEqual({
      kind: "runtime.unknown",
      runtimeType: null,
      runtimeItemId: null,
      status: "observed",
      summarySource: null,
      metadata: {},
    });
  });

  it("an unrecognised item.type becomes runtime.unknown but keeps the item id and runtimeType", () => {
    expect(
      classifyCodexEvent({
        type: "item.completed",
        item: { id: "item_99", type: "custom_widget", status: "completed" },
      }),
    ).toEqual({
      kind: "runtime.unknown",
      runtimeType: "item.completed:custom_widget",
      runtimeItemId: "item_99",
      status: "completed",
      summarySource: null,
      metadata: {},
    });
  });

  it("a command_execution item.completed with a non-zero exit_code classifies as failed", () => {
    expect(
      classifyCodexEvent({
        type: "item.completed",
        item: {
          id: "item_42",
          type: "command_execution",
          command: "/usr/bin/false",
          exit_code: 2,
        },
      }),
    ).toMatchObject({
      kind: "runtime.command",
      runtimeItemId: "item_42",
      status: "failed",
      summarySource: "/usr/bin/false",
    });
  });

  it("item.updated always classifies as observed", () => {
    expect(
      classifyCodexEvent({
        type: "item.updated",
        item: { id: "item_7", type: "command_execution", command: "echo hi" },
      }),
    ).toMatchObject({ kind: "runtime.command", status: "observed" });
  });

  it("a top-level error event uses the message field", () => {
    expect(classifyCodexEvent({ type: "error", message: "boom" })).toMatchObject({
      kind: "runtime.error",
      runtimeType: "error",
      status: "observed",
      summarySource: "boom",
    });
  });

  it("an item event whose item is not an object falls through to runtime.unknown", () => {
    expect(classifyCodexEvent({ type: "item.completed", item: "not-an-object" })).toEqual({
      kind: "runtime.unknown",
      runtimeType: "item.completed",
      runtimeItemId: null,
      status: "observed",
      summarySource: null,
      metadata: {},
    });
  });
});
