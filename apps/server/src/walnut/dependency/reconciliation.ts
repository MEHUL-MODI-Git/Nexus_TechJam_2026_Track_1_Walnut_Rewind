// ReconciliationServiceImpl (spec 001 §16, docs/walnut/04-DATA-MODEL-API-CONTRACTS.md §16;
// INV-10, HC-7). Recovery is a NEW Run -- the old (STALE/TAINTED) Run is never mutated. The new
// Run is created through the injected `startRun` callback (in production, AgentService.
// sendMessage, wired at the composition root -- this module never wires it, which is exactly what
// keeps it decoupled from the runtime plane and keeps INV-10 true by construction: there is no
// code path here that could touch the old Run).
//
// reconcile() pipeline (spec pin, in order):
//   1. staleRunId's current WalnutRunState must be STALE or TAINTED -- reconciling a CLEAN run is
//      a caller bug, not "a free rerun button" (spec note).
//   2. Old capsule via capsules.getByRunId. A capsule-less run predates Walnut and cannot be
//      reconciled -- throw rather than smuggling an empty-string oldCapsuleId through the typed
//      contract (doc 04 §16 requires oldCapsuleId: string, not string | null).
//   3. Append `reconciliation.started` on the governance chain (runId: null; redact-then-append,
//      same shape as ../evidence/evidence-write-service.ts's appendGovernanceEvent).
//   4. Start the replacement run through the injected callback.
//   5. Poll the new run's capsule (it exists as soon as the run is running -- sendMessage builds
//      the capsule before the runner starts -- but the run may still be mid-startup when we ask).
//   6. Mint + persist ONE ReconciliationRecord with the final result (STARTED is never persisted
//      on its own -- the started/completed/failed ledger events carry the timeline; the stored
//      record is the outcome), markRecovered the old run, append `reconciliation.completed`.
// On any failure after step 3, append `reconciliation.failed` (redacted) and rethrow. A record is
// persisted with result "FAILED" only if the replacement run was already created (steps 4-5
// failed); if step 4 itself failed, nothing is persisted (there is nothing to describe yet beyond
// the ledger event).

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ContextCapsule, ReconciliationRecord } from "../types.js";
import type { EvidenceLedger } from "../evidence/ledger.js";
import type { Redactor } from "../evidence/redactor.js";
import { JsonFileState } from "../shared/json-file-state.js";
import { appendRedactedEvent } from "../shared/ledger-events.js";
import type { WalnutRunStateStore } from "./run-state.js";

const CAPSULE_POLL_ATTEMPTS = 10;
const CAPSULE_POLL_INTERVAL_MS = 200;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// -- Reconciliation records store (house pattern, this module owns it) -------------------------
//
// JSON at <dataDir>/walnut/reconciliations/reconciliations.json. Records are appended, never
// rewritten -- there is no update-in-place path (HC-7: the record persisted at the end of a
// reconcile() call IS the outcome; there is no separate STARTED record to later mutate).

export interface ReconciliationRecordStore {
  append(record: ReconciliationRecord): Promise<void>;
  listAll(): Promise<ReconciliationRecord[]>;
}

interface ReconciliationsFile {
  version: 1;
  records: ReconciliationRecord[];
}

const emptyReconciliationsFile = (): ReconciliationsFile => ({ version: 1, records: [] });

export class ReconciliationStore implements ReconciliationRecordStore {
  private readonly state: JsonFileState<ReconciliationsFile>;

  constructor(dataDir: string) {
    this.state = new JsonFileState<ReconciliationsFile>({
      filePath: path.join(dataDir, "walnut", "reconciliations", "reconciliations.json"),
      empty: emptyReconciliationsFile,
      validate: (parsed) => {
        const file = parsed as ReconciliationsFile;
        if (file.version !== 1 || !Array.isArray(file.records)) {
          throw new Error("Unsupported reconciliations file format");
        }
        return file;
      },
    });
  }

  async append(record: ReconciliationRecord): Promise<void> {
    await this.state.mutate((file) => {
      file.records.push(record);
    });
  }

  async listAll(): Promise<ReconciliationRecord[]> {
    const file = await this.state.read();
    return [...file.records];
  }
}

// -- Service -------------------------------------------------------------------------------------

export interface ReconciliationCapsuleLookup {
  getByRunId(runId: string): Promise<ContextCapsule | null>;
}

export interface ReconciliationServiceDeps {
  runStates: WalnutRunStateStore;
  capsules: ReconciliationCapsuleLookup;
  ledger: EvidenceLedger;
  redactor: Redactor;
  store: ReconciliationRecordStore;
  startRun: (agentId: string, prompt: string) => Promise<{ runId: string }>;
}

export interface ReconciliationService {
  reconcile(
    staleRunId: string,
    originalPrompt: string,
    agentId: string,
  ): Promise<ReconciliationRecord>;
  listAll(): Promise<ReconciliationRecord[]>;
}

export class ReconciliationServiceImpl implements ReconciliationService {
  // Review finding: all reconcile() calls serialize through this queue so the
  // STALE/TAINTED check is ATOMIC with respect to other reconciles. Without it, two concurrent
  // calls for the same stale run both passed the pre-check, both started replacement Runs, and
  // both persisted COMPLETED records — the reproduced INV-10/HC-7 violation. With it, the losing
  // caller enters the critical section only after the winner finished, re-reads the state (now
  // RECOVERED), and rejects at step 1 without ever invoking startRun. A queue error never poisons
  // subsequent calls (same `.catch(() => undefined)` chaining as the JSON stores).
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReconciliationServiceDeps) {}

  async reconcile(
    staleRunId: string,
    originalPrompt: string,
    agentId: string,
  ): Promise<ReconciliationRecord> {
    let record!: ReconciliationRecord;
    const operation = this.queue.then(async () => {
      record = await this.reconcileSerialized(staleRunId, originalPrompt, agentId);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return record;
  }

  private async reconcileSerialized(
    staleRunId: string,
    originalPrompt: string,
    agentId: string,
  ): Promise<ReconciliationRecord> {
    // 1. Recovery responds to invalidation -- it is not a free rerun button. This check runs
    // inside the serialization queue, so it is also the concurrency guard (see queue note above).
    const currentState = await this.deps.runStates.get(staleRunId);
    if (currentState !== "STALE" && currentState !== "TAINTED") {
      throw new Error(
        `Cannot reconcile run ${staleRunId}: current WalnutRunState is ${currentState}, expected STALE or TAINTED`,
      );
    }

    // 2. A capsule-less run predates Walnut and cannot be reconciled.
    const oldCapsule = await this.deps.capsules.getByRunId(staleRunId);
    if (oldCapsule === null) {
      throw new Error(
        `Cannot reconcile run ${staleRunId}: it has no ContextCapsule (predates Walnut context capture)`,
      );
    }

    const triggerEvidenceIds = await this.triggerEvidenceIdsFor(staleRunId);

    // 3. Governance event before anything mutates.
    await this.appendGovernanceEvent(agentId, "reconciliation.started", {
      staleRunId,
      oldCapsuleId: oldCapsule.capsuleId,
      triggerEvidenceIds,
    });

    // 4. The new run goes through the injected callback -- the old run is never touched here.
    let replacementRunId: string;
    try {
      const started = await this.deps.startRun(agentId, originalPrompt);
      replacementRunId = started.runId;
    } catch (error) {
      await this.appendGovernanceEvent(agentId, "reconciliation.failed", {
        staleRunId,
        reason: errorMessage(error),
      });
      throw error;
    }

    // 5. The capsule exists as soon as the run is running; poll briefly for it.
    let newCapsuleId: string;
    try {
      newCapsuleId = await this.pollForNewCapsuleId(replacementRunId);
    } catch (error) {
      // The replacement run was already created, so a FAILED record is persisted (spec pin).
      // newCapsuleId has no capsule to report -- "" is the documented sentinel for "no capsule
      // was ever produced for this run", the one case the string-typed contract has no null to
      // express.
      const failedRecord: ReconciliationRecord = {
        reconciliationId: `rec_${randomUUID()}`,
        triggerEvidenceIds,
        staleRunId,
        replacementRunId,
        oldCapsuleId: oldCapsule.capsuleId,
        newCapsuleId: "",
        createdAt: new Date().toISOString(),
        result: "FAILED",
      };
      await this.deps.store.append(failedRecord);
      await this.appendGovernanceEvent(agentId, "reconciliation.failed", {
        staleRunId,
        replacementRunId,
        reason: errorMessage(error),
      });
      throw error;
    }

    // 6. Claim the recovery transition FIRST, then persist the outcome (R-10 ordering fix: a
    // COMPLETED record is only ever written after markRecovered succeeded, so a failed or lost
    // transition can never leave a false COMPLETED record behind). If markRecovered throws, the
    // replacement run already exists — persist a FAILED record (same shape as the poll-failure
    // path) so the created run is never orphaned from the audit trail, then rethrow.
    try {
      await this.deps.runStates.markRecovered(staleRunId, replacementRunId, "reconciled");
    } catch (error) {
      const failedRecord: ReconciliationRecord = {
        reconciliationId: `rec_${randomUUID()}`,
        triggerEvidenceIds,
        staleRunId,
        replacementRunId,
        oldCapsuleId: oldCapsule.capsuleId,
        newCapsuleId,
        createdAt: new Date().toISOString(),
        result: "FAILED",
      };
      await this.deps.store.append(failedRecord);
      await this.appendGovernanceEvent(agentId, "reconciliation.failed", {
        staleRunId,
        replacementRunId,
        reason: errorMessage(error),
      });
      throw error;
    }

    const record: ReconciliationRecord = {
      reconciliationId: `rec_${randomUUID()}`,
      triggerEvidenceIds,
      staleRunId,
      replacementRunId,
      oldCapsuleId: oldCapsule.capsuleId,
      newCapsuleId,
      createdAt: new Date().toISOString(),
      result: "COMPLETED",
    };
    await this.deps.store.append(record);
    await this.appendGovernanceEvent(agentId, "reconciliation.completed", {
      staleRunId,
      replacementRunId,
      oldCapsuleId: oldCapsule.capsuleId,
      newCapsuleId,
    });

    return record;
  }

  async listAll(): Promise<ReconciliationRecord[]> {
    return this.deps.store.listAll();
  }

  private async triggerEvidenceIdsFor(runId: string): Promise<string[]> {
    const history = await this.deps.runStates.history(runId);
    const ids = new Set<string>();
    for (const entry of history) {
      if (entry.triggerEvidenceId !== null) ids.add(entry.triggerEvidenceId);
    }
    return [...ids].sort();
  }

  private async pollForNewCapsuleId(runId: string): Promise<string> {
    for (let attempt = 0; attempt < CAPSULE_POLL_ATTEMPTS; attempt += 1) {
      const capsule = await this.deps.capsules.getByRunId(runId);
      if (capsule !== null) return capsule.capsuleId;
      await sleep(CAPSULE_POLL_INTERVAL_MS);
    }
    throw new Error(`Replacement run ${runId} has no ContextCapsule after polling`);
  }

  // Governance-chain event (runId: null) -- same redact-then-append shape as
  // ../evidence/evidence-write-service.ts's appendGovernanceEvent.
  private async appendGovernanceEvent(
    agentId: string,
    kind: "reconciliation.started" | "reconciliation.completed" | "reconciliation.failed",
    payload: Record<string, unknown>,
  ): Promise<void> {
    await appendRedactedEvent(
      { ledger: this.deps.ledger, redactor: this.deps.redactor },
      {
        runId: null,
        agentId,
        capsuleId: null,
        kind,
        actor: "middleware",
        occurredAt: new Date().toISOString(),
        payload,
        supersedesEventId: null,
      },
    );
  }
}
