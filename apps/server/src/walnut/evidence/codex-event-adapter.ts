// Classifies one raw Codex JSONL event (the `codex exec --json` protocol) into the pinned
// RuntimeEventKind taxonomy (spec 002 §6, overlay P1-E2). Pure and total: every input, including
// an unrecognised `type` or `item.type`, produces a classification — this module never throws
// and never drops an event silently (INV-17). `parsed` is the already-JSON.parsed event object;
// `runtime-event-sink.ts` owns parsing/redaction/persistence around this pure function.

import type { RuntimeEventKind } from "../types.js";
import { isPlainObject } from "../shared/guards.js";

export interface CodexEventClassification {
  kind: RuntimeEventKind;
  runtimeType: string | null;
  runtimeItemId: string | null;
  status: "started" | "completed" | "failed" | "observed";
  summarySource: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

const ITEM_TYPE_TO_KIND: Readonly<Record<string, RuntimeEventKind>> = {
  agent_message: "runtime.message",
  command_execution: "runtime.command",
  file_change: "runtime.file_change",
  mcp_tool_call: "runtime.mcp",
  web_search: "runtime.web_search",
  plan_update: "runtime.plan",
  todo_list: "runtime.plan",
  reasoning: "runtime.reasoning_metadata",
  error: "runtime.error",
};

function unknownClassification(rawType: unknown): CodexEventClassification {
  return {
    kind: "runtime.unknown",
    runtimeType: typeof rawType === "string" ? rawType : null,
    runtimeItemId: null,
    status: "observed",
    summarySource: null,
    metadata: {},
  };
}

function classifyItemEvent(
  eventType: "item.started" | "item.updated" | "item.completed",
  item: Record<string, unknown>,
): CodexEventClassification {
  const itemTypeRaw = item["type"];
  const itemType = typeof itemTypeRaw === "string" ? itemTypeRaw : null;
  const kind: RuntimeEventKind =
    itemType !== null && itemType in ITEM_TYPE_TO_KIND
      ? (ITEM_TYPE_TO_KIND[itemType] as RuntimeEventKind)
      : "runtime.unknown";

  let status: CodexEventClassification["status"];
  if (itemType === "error") {
    status = "observed";
  } else if (eventType === "item.started") {
    status = "started";
  } else if (eventType === "item.updated") {
    status = "observed";
  } else {
    const exitCode = item["exit_code"];
    status =
      itemType === "command_execution" && typeof exitCode === "number" && exitCode !== 0
        ? "failed"
        : "completed";
  }

  const runtimeItemId = item["id"] !== undefined ? String(item["id"]) : null;
  const runtimeType = `${eventType}:${itemType ?? String(itemTypeRaw)}`;

  let summarySource: string | null = null;
  if (itemType === "agent_message" && typeof item["text"] === "string") {
    summarySource = item["text"];
  } else if (itemType === "command_execution" && typeof item["command"] === "string") {
    summarySource = item["command"];
  } else if (itemType === "error" && typeof item["message"] === "string") {
    summarySource = item["message"];
  }

  return { kind, runtimeType, runtimeItemId, status, summarySource, metadata: {} };
}

export function classifyCodexEvent(parsed: Record<string, unknown>): CodexEventClassification {
  const type = parsed["type"];

  if (type === "thread.started") {
    return {
      kind: "runtime.thread",
      runtimeType: "thread.started",
      runtimeItemId: null,
      status: "observed",
      summarySource: null,
      metadata: { threadId: String(parsed["thread_id"] ?? "") },
    };
  }

  if (type === "turn.started") {
    return {
      kind: "runtime.turn",
      runtimeType: "turn.started",
      runtimeItemId: null,
      status: "started",
      summarySource: null,
      metadata: {},
    };
  }

  if (type === "turn.completed") {
    const usage = parsed["usage"];
    const metadata: Record<string, string | number | boolean | null> = {};
    if (isPlainObject(usage)) {
      if (typeof usage["input_tokens"] === "number") {
        metadata["inputTokens"] = usage["input_tokens"];
      }
      if (typeof usage["cached_input_tokens"] === "number") {
        metadata["cachedInputTokens"] = usage["cached_input_tokens"];
      }
      if (typeof usage["output_tokens"] === "number") {
        metadata["outputTokens"] = usage["output_tokens"];
      }
    }
    return {
      kind: "runtime.turn",
      runtimeType: "turn.completed",
      runtimeItemId: null,
      status: "completed",
      summarySource: null,
      metadata,
    };
  }

  if (type === "turn.failed") {
    return {
      kind: "runtime.turn",
      runtimeType: "turn.failed",
      runtimeItemId: null,
      status: "failed",
      summarySource: null,
      metadata: {},
    };
  }

  if (
    (type === "item.started" || type === "item.updated" || type === "item.completed") &&
    isPlainObject(parsed["item"])
  ) {
    return classifyItemEvent(type, parsed["item"]);
  }

  if (type === "error") {
    const message = parsed["message"];
    return {
      kind: "runtime.error",
      runtimeType: "error",
      runtimeItemId: null,
      status: "observed",
      summarySource: typeof message === "string" ? message : null,
      metadata: {},
    };
  }

  return unknownClassification(type);
}
