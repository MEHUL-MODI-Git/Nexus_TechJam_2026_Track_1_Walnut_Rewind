// Shared ledger-event helpers (behaviour-preserving extraction of the identical
// redact-then-append shape duplicated across evidence/evidence-write-service.ts's
// appendGovernanceEvent, context/share-service.ts's appendShareEvent,
// dependency/reconciliation.ts's appendGovernanceEvent, routes/walnut-routes.ts's
// appendGovernanceEvent, and the RedactionReceipt-shaped-but-not-actually-redacted
// `notAppliedReceipt()` duplicated in upstream agent-service.ts and
// evidence/runtime-event-sink.ts).

import type { RedactionCategory } from "../evidence/redactor.js";
import { REDACTOR_VERSION, type Redactor } from "../evidence/redactor.js";
import type { EvidenceLedger } from "../evidence/ledger.js";
import type { LedgerEvent, RedactionReceipt } from "../types.js";

// No redaction was performed on this payload -- documents that honestly rather than implying a
// redaction pass ran (upstream agent-service.ts's run.requested/capsule.finalized/
// outbox_processed, evidence/runtime-event-sink.ts's hash-only parse/redaction failures).
export function notAppliedReceipt(): RedactionReceipt {
  return {
    applied: false,
    categories: [],
    replacementCount: 0,
    redactorVersion: REDACTOR_VERSION,
  };
}

export function receiptFrom(redaction: {
  categories: RedactionCategory[];
  replacementCount: number;
}): RedactionReceipt {
  return {
    applied: redaction.replacementCount > 0,
    categories: redaction.categories,
    replacementCount: redaction.replacementCount,
    redactorVersion: REDACTOR_VERSION,
  };
}

export async function appendRedactedEvent(
  deps: { ledger: EvidenceLedger; redactor: Redactor },
  input: {
    runId: string | null;
    agentId: string | null;
    capsuleId: string | null;
    kind: string;
    actor: LedgerEvent["actor"];
    occurredAt: string;
    payload: unknown;
    supersedesEventId?: string | null;
  },
): Promise<void> {
  const redaction = deps.redactor.redact(input.payload);
  await deps.ledger.append({
    runId: input.runId,
    agentId: input.agentId,
    capsuleId: input.capsuleId,
    kind: input.kind,
    actor: input.actor,
    occurredAt: input.occurredAt,
    safePayload: redaction.safeValue,
    redactionReceipt: receiptFrom(redaction),
    supersedesEventId: input.supersedesEventId ?? null,
  });
}
