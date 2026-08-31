// processOutbox (doc 03 §14, spec 003 §B2 caller; P2-E2) — reads a completed Run's workspace
// outbox (`.walnut/outbox.json`) and turns each schema-valid entry into a call to
// EvidenceWriteService.createEvidence. THE MODEL NEVER MUTATES THE EVIDENCE STORE — this reader
// is the only path evidence can be proposed through (INV-4); creation itself still runs the full
// EvidenceWriteService pipeline (safe path, citation verification, INV-6, ...).

import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Evidence } from "../types.js";

const outboxSourceSchema = z.object({
  path: z.string(),
  quote: z.string(),
  charStart: z.number(),
  charEnd: z.number(),
});

const outboxEntrySchema = z.object({
  claim: z.string(),
  classification: z.enum(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]),
  requiredScopes: z.array(z.string()),
  source: outboxSourceSchema,
  derivedFromEvidenceIds: z.array(z.string()),
  subjectKey: z.string().nullable().default(null),
  predicate: z.string().nullable().default(null),
  validFrom: z.string().nullable().default(null),
  validTo: z.string().nullable().default(null),
  supersedesEvidenceId: z.string().nullable().default(null),
});

export type OutboxEntry = z.infer<typeof outboxEntrySchema>;

export interface OutboxRejection {
  index: number;
  reason: string;
  detail: string;
}

// Deliberately narrower than the full EvidenceWriteService port — the outbox reader only ever
// calls createEvidence, and accepting a widened `reason: string` here keeps this module
// decoupled from EvidenceWriteServiceImpl's literal failure-reason union.
export interface OutboxWriteService {
  createEvidence(input: {
    claim: string;
    subjectKey: string | null;
    predicate: string | null;
    producerAgentId: string;
    producerRunId: string;
    classification: OutboxEntry["classification"];
    requiredScopes: string[];
    source: { path: string; quote: string; charStart: number; charEnd: number };
    derivedFromEvidenceIds: string[];
    supersedesEvidenceId: string | null;
    validFrom: string | null;
    validTo: string | null;
  }): Promise<{ ok: true; evidence: Evidence } | { ok: false; reason: string; detail: string }>;
}

export interface ProcessOutboxInput {
  workspacePath: string;
  agentId: string;
  runId: string;
  writeService: OutboxWriteService;
}

export interface ProcessOutboxResult {
  accepted: Evidence[];
  rejected: OutboxRejection[];
}

function outboxPath(workspacePath: string): string {
  return path.join(workspacePath, ".walnut", "outbox.json");
}

function processedPath(workspacePath: string, runId: string): string {
  return path.join(workspacePath, ".walnut", `outbox.processed-${runId}.json`);
}

export async function processOutbox(input: ProcessOutboxInput): Promise<ProcessOutboxResult> {
  const filePath = outboxPath(input.workspacePath);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { accepted: [], rejected: [] };
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    // Malformed JSON: reject the whole outbox, leave the file in place for inspection.
    return {
      accepted: [],
      rejected: [
        {
          index: -1,
          reason: "schema_invalid",
          detail: `outbox is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  if (
    typeof parsedJson !== "object" ||
    parsedJson === null ||
    Array.isArray(parsedJson) ||
    !Array.isArray((parsedJson as { evidence?: unknown }).evidence)
  ) {
    // Top-level shape is not `{ evidence: [...] }`: same treatment, leave the file in place.
    return {
      accepted: [],
      rejected: [
        {
          index: -1,
          reason: "schema_invalid",
          detail: "outbox top-level shape must be { evidence: [...] }",
        },
      ],
    };
  }

  const rawEntries = (parsedJson as { evidence: unknown[] }).evidence;
  const accepted: Evidence[] = [];
  const rejected: OutboxRejection[] = [];

  for (let index = 0; index < rawEntries.length; index += 1) {
    const parsedEntry = outboxEntrySchema.safeParse(rawEntries[index]);
    if (!parsedEntry.success) {
      rejected.push({
        index,
        reason: "schema_invalid",
        detail: parsedEntry.error.message,
      });
      continue;
    }

    const entry = parsedEntry.data;
    const result = await input.writeService.createEvidence({
      claim: entry.claim,
      subjectKey: entry.subjectKey,
      predicate: entry.predicate,
      producerAgentId: input.agentId,
      producerRunId: input.runId,
      classification: entry.classification,
      requiredScopes: entry.requiredScopes,
      source: entry.source,
      derivedFromEvidenceIds: entry.derivedFromEvidenceIds,
      supersedesEvidenceId: entry.supersedesEvidenceId,
      validFrom: entry.validFrom,
      validTo: entry.validTo,
    });

    if (result.ok) {
      accepted.push(result.evidence);
    } else {
      rejected.push({ index, reason: result.reason, detail: result.detail });
    }
  }

  // Top-level shape was valid, so every entry (accepted or rejected) has now been read out of
  // the outbox: rename so a restart never double-ingests. The two malformed/bad-shape returns
  // above short-circuit before this line and leave the file in place, as pinned.
  await rename(filePath, processedPath(input.workspacePath, input.runId));

  return { accepted, rejected };
}
