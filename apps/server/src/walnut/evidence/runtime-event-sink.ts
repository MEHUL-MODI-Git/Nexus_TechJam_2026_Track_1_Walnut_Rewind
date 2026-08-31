// WalnutRuntimeEventSink (spec 001 §4 `RuntimeEventSink`; spec 002 §6 failure semantics; overlay
// P1-E2/P1-E4). Implements the upstream provider-neutral RuntimeEventSink contract: consumes one
// raw Codex JSONL line at a time (or, defensively, an already-parsed object), classifies it,
// redacts it, and appends a chained LedgerEvent. Parse/classify/redact failures produce typed
// events and never throw (INV-17: never drop, never crash). Ledger/IO failures PROPAGATE — a
// broken chain must fail the Run loudly (INV-13).

import { randomUUID } from "node:crypto";
import type { RuntimeEventSink } from "../../types.js";
import type { RuntimeEventRecord } from "../types.js";
import { isPlainObject } from "../shared/guards.js";
import { sha256Prefixed } from "../shared/hash.js";
import { notAppliedReceipt, receiptFrom } from "../shared/ledger-events.js";
import { classifyCodexEvent } from "./codex-event-adapter.js";
import { canonicalJson } from "./canonical-json.js";
import type { EvidenceLedger } from "./ledger.js";
import type { Redactor, RedactionResult } from "./redactor.js";

const SUMMARY_MAX_LENGTH = 200;

function hashOnlyPayload(raw: string): { byteLength: number; rawHash: string } {
  return {
    byteLength: Buffer.byteLength(raw, "utf8"),
    rawHash: sha256Prefixed(raw),
  };
}

// Normal runners pass the original JSONL string. Defensive callers may pass a non-JSON value
// that caused the Redactor itself to reject (BigInt, cycles, accessors, functions, etc.). The
// failure path still needs bytes to hash without invoking JSON.stringify, toJSON, or getters.
function serializeUnknownForHash(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "symbol") return `[symbol:${value.description ?? ""}]`;
  if (typeof value === "function") return "[function]";

  if (ancestors.has(value)) return "[circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        items.push(
          descriptor && "value" in descriptor
            ? serializeUnknownForHash(descriptor.value, ancestors)
            : "[hole-or-accessor]",
        );
      }
      return `[${items.join(",")}]`;
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries = Object.keys(descriptors)
      .sort()
      .map((key) => {
        const descriptor = descriptors[key];
        const serialized =
          descriptor && "value" in descriptor
            ? serializeUnknownForHash(descriptor.value, ancestors)
            : "[accessor]";
        return `${JSON.stringify(key)}:${serialized}`;
      });
    const symbolCount = Object.getOwnPropertySymbols(value).length;
    if (symbolCount > 0) entries.push(`"[symbol-keys]":${symbolCount}`);
    return `{${entries.join(",")}}`;
  } catch {
    return `[unserializable:${typeof value}]`;
  } finally {
    ancestors.delete(value);
  }
}

function redactString(redactor: Redactor, value: string): string {
  const result = redactor.redact(value);
  return typeof result.safeValue === "string" ? result.safeValue : value;
}

function redactMetadata(
  metadata: Record<string, string | number | boolean | null>,
  redactor: Redactor,
): Record<string, string | number | boolean | null> {
  const redacted: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    redacted[key] = typeof value === "string" ? redactString(redactor, value) : value;
  }
  return redacted;
}

export interface WalnutRuntimeEventSinkDeps {
  ledger: EvidenceLedger;
  redactor: Redactor;
}

export class WalnutRuntimeEventSink implements RuntimeEventSink {
  private readonly ledger: EvidenceLedger;
  private readonly redactor: Redactor;

  constructor(deps: WalnutRuntimeEventSinkDeps) {
    this.ledger = deps.ledger;
    this.redactor = deps.redactor;
  }

  async accept(input: {
    runId: string;
    agentId: string;
    provider: "local-process" | "container";
    rawEvent: unknown;
    receivedAt: string;
  }): Promise<void> {
    let parsedEvent: Record<string, unknown>;

    if (typeof input.rawEvent === "string") {
      let parsedUnknown: unknown;
      try {
        parsedUnknown = JSON.parse(input.rawEvent);
      } catch {
        await this.ledger.append({
          runId: input.runId,
          agentId: input.agentId,
          capsuleId: null,
          kind: "runtime.parse_failure",
          actor: "runtime",
          occurredAt: input.receivedAt,
          safePayload: hashOnlyPayload(input.rawEvent),
          redactionReceipt: notAppliedReceipt(),
          supersedesEventId: null,
        });
        return;
      }
      parsedEvent = isPlainObject(parsedUnknown) ? parsedUnknown : { value: parsedUnknown };
    } else if (isPlainObject(input.rawEvent)) {
      // Defensive: callers are contracted to pass the raw JSONL line string, but a caller that
      // already parsed the event should not be forced to re-stringify it.
      parsedEvent = input.rawEvent;
    } else {
      parsedEvent = { value: input.rawEvent };
    }

    const classification = classifyCodexEvent(parsedEvent);

    let redaction: RedactionResult;
    try {
      redaction = this.redactor.redact(parsedEvent);
    } catch {
      const raw =
        typeof input.rawEvent === "string"
          ? input.rawEvent
          : serializeUnknownForHash(input.rawEvent);
      await this.ledger.append({
        runId: input.runId,
        agentId: input.agentId,
        capsuleId: null,
        kind: "redaction_failure",
        actor: "runtime",
        occurredAt: input.receivedAt,
        safePayload: hashOnlyPayload(raw),
        redactionReceipt: notAppliedReceipt(),
        supersedesEventId: null,
      });
      return;
    }

    const safeSummary =
      classification.summarySource !== null
        ? redactString(this.redactor, classification.summarySource).slice(0, SUMMARY_MAX_LENGTH)
        : null;

    const redactionReceipt = receiptFrom(redaction);

    const record: RuntimeEventRecord = {
      runtimeEventId: `revt_${randomUUID()}`,
      runId: input.runId,
      agentId: input.agentId,
      provider: input.provider,
      kind: classification.kind,
      runtimeType: classification.runtimeType,
      runtimeItemId: classification.runtimeItemId,
      status: classification.status,
      occurredAt: input.receivedAt,
      recordedAt: new Date().toISOString(),
      safeSummary,
      payloadHash: sha256Prefixed(canonicalJson(redaction.safeValue)),
      metadata: redactMetadata(classification.metadata, this.redactor),
      redactionReceipt,
    };

    await this.ledger.append({
      runId: input.runId,
      agentId: input.agentId,
      capsuleId: null,
      kind: "runtime.event",
      actor: "runtime",
      occurredAt: input.receivedAt,
      safePayload: record,
      redactionReceipt,
      supersedesEventId: null,
    });
  }
}
