// WalnutRunStateStore (spec 001 §14, docs/walnut/04-DATA-MODEL-API-CONTRACTS.md §14; INV-10
// groundwork, HC-7). Parallel metadata ONLY -- this store never touches the starter-kit Run
// record; `state` here is Walnut's own bitemporal-adjacent view of a run's health, kept entirely
// separate (doc 04 §14: "Store separately from Starter Kit Run status").
//
// JSON house pattern: one file at <dataDir>/walnut/run-state/run-states.json, atomic tmp+rename,
// clone-mutate-persist-swap chained through a queue (same shape as ../auth/grant-store.ts).
//
// History is APPEND-ONLY: every transition pushes a new entry; no entry is ever rewritten. The
// top-level `state`/`updatedAt` fields on a record are derived convenience -- the history array
// is the source of truth for that run's timeline.

import path from "node:path";
import { JsonFileState } from "../shared/json-file-state.js";
import type { WalnutRunState } from "../types.js";

export interface RunStateHistoryEntry {
  state: WalnutRunState;
  reason: string;
  at: string;
  byRunId: string | null;
  triggerEvidenceId: string | null;
}

export interface RunStateRecord {
  runId: string;
  state: WalnutRunState;
  updatedAt: string;
  history: RunStateHistoryEntry[];
}

interface RunStatesFile {
  version: 1;
  records: Record<string, RunStateRecord>;
}

const emptyRunStatesFile = (): RunStatesFile => ({ version: 1, records: {} });

// markRecovered is the one transition with a precondition in v1: recovering a run that was never
// marked STALE/TAINTED is a caller bug (there is nothing to recover from), so it throws rather
// than silently minting a recovery history for a CLEAN run.
const RECOVERABLE_FROM: readonly WalnutRunState[] = ["STALE", "TAINTED"];

function byOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class WalnutRunStateStore {
  private readonly state: JsonFileState<RunStatesFile>;

  constructor(dataDir: string) {
    this.state = new JsonFileState<RunStatesFile>({
      filePath: path.join(dataDir, "walnut", "run-state", "run-states.json"),
      empty: emptyRunStatesFile,
      validate: (parsed) => {
        const file = parsed as RunStatesFile;
        if (file.version !== 1 || typeof file.records !== "object" || file.records === null) {
          throw new Error("Unsupported run-states file format");
        }
        return file;
      },
    });
  }

  // Defaults to CLEAN for a run with no recorded transition yet -- CLEAN is never persisted by
  // itself, only observed as the absence of a record.
  async get(runId: string): Promise<WalnutRunState> {
    const file = await this.state.read();
    return file.records[runId]?.state ?? "CLEAN";
  }

  async history(runId: string): Promise<RunStateHistoryEntry[]> {
    const file = await this.state.read();
    return file.records[runId]?.history ?? [];
  }

  async listAll(): Promise<RunStateRecord[]> {
    const file = await this.state.read();
    return Object.values(file.records).sort((a, b) => byOrdinal(a.runId, b.runId));
  }

  async markStale(
    runId: string,
    triggerEvidenceId: string | null,
    reason: string,
  ): Promise<RunStateRecord> {
    return this.transition(runId, "STALE", reason, { byRunId: null, triggerEvidenceId });
  }

  async markTainted(
    runId: string,
    triggerEvidenceId: string | null,
    reason: string,
  ): Promise<RunStateRecord> {
    return this.transition(runId, "TAINTED", reason, { byRunId: null, triggerEvidenceId });
  }

  async markRecovered(runId: string, byRunId: string, reason: string): Promise<RunStateRecord> {
    return this.transition(
      runId,
      "RECOVERED",
      reason,
      { byRunId, triggerEvidenceId: null },
      RECOVERABLE_FROM,
    );
  }

  private async transition(
    runId: string,
    nextState: WalnutRunState,
    reason: string,
    extra: { byRunId: string | null; triggerEvidenceId: string | null },
    requiredCurrentStates?: readonly WalnutRunState[],
  ): Promise<RunStateRecord> {
    return this.state.mutate((file) => {
      const existing = file.records[runId];
      const currentState = existing?.state ?? "CLEAN";
      if (requiredCurrentStates && !requiredCurrentStates.includes(currentState)) {
        throw new Error(
          `Cannot transition run ${runId} to ${nextState} from ${currentState}: requires one of [${requiredCurrentStates.join(", ")}]`,
        );
      }
      const at = new Date().toISOString();
      const entry: RunStateHistoryEntry = { state: nextState, reason, at, ...extra };
      const nextRecord: RunStateRecord = {
        runId,
        state: nextState,
        updatedAt: at,
        history: [...(existing?.history ?? []), entry],
      };
      file.records[runId] = nextRecord;
      return nextRecord;
    });
  }
}
