import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextCapsule } from "../types.js";
import { EvidenceLedger } from "../evidence/ledger.js";
import { Redactor } from "../evidence/redactor.js";
import {
  ReconciliationServiceImpl,
  ReconciliationStore,
  type ReconciliationCapsuleLookup,
} from "./reconciliation.js";
import { WalnutRunStateStore } from "./run-state.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "walnut-reconciliation-"));
  directories.push(dir);
  return dir;
}

function makeCapsule(overrides: Partial<ContextCapsule> = {}): ContextCapsule {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    capsuleId: "cap_old",
    runId: "run-old",
    agentId: "agent-1",
    agentVersionId: "ver-1",
    agentPrincipalId: "prin-alice",
    onBehalfOfPrincipalId: null,
    policyRevision: 1,
    policyHash: "ph-1",
    evidence: [],
    deniedEvidenceDecisionIds: [],
    createdAt: now,
    transactionCut: now,
    capsuleHash: "chash-1",
    ...overrides,
  };
}

// A stub capsule lookup keyed by runId, with an optional per-runId call counter so a test can
// simulate "the capsule appears on the Nth poll" without a real runner in the loop.
function makeCapsuleLookup(
  byRunId: Record<string, (callNumber: number) => ContextCapsule | null>,
): ReconciliationCapsuleLookup {
  const callCounts = new Map<string, number>();
  return {
    async getByRunId(runId: string): Promise<ContextCapsule | null> {
      const resolver = byRunId[runId];
      if (!resolver) return null;
      const callNumber = (callCounts.get(runId) ?? 0) + 1;
      callCounts.set(runId, callNumber);
      return resolver(callNumber);
    },
  };
}

async function makeHarness() {
  const dataDir = await makeTempDir();
  const runStates = new WalnutRunStateStore(dataDir);
  const ledger = new EvidenceLedger(dataDir);
  const redactor = new Redactor();
  const store = new ReconciliationStore(dataDir);
  return { dataDir, runStates, ledger, redactor, store };
}

describe("ReconciliationServiceImpl", () => {
  it("happy path: STALE run reconciles into a COMPLETED record, old run RECOVERED, governance chain in order", async () => {
    const { runStates, ledger, redactor, store } = await makeHarness();
    await runStates.markStale("run-old", "ev-1", "evidence ev-1 revoked");

    const capsules = makeCapsuleLookup({
      "run-old": () => makeCapsule({ capsuleId: "cap_old", runId: "run-old" }),
      // Appears on the second poll.
      "run-new": (callNumber) =>
        callNumber >= 2 ? makeCapsule({ capsuleId: "cap_new", runId: "run-new" }) : null,
    });

    const service = new ReconciliationServiceImpl({
      runStates,
      capsules,
      ledger,
      redactor,
      store,
      startRun: async () => ({ runId: "run-new" }),
    });

    const record = await service.reconcile("run-old", "original prompt", "agent-1");

    expect(record.result).toBe("COMPLETED");
    expect(record.staleRunId).toBe("run-old");
    expect(record.replacementRunId).toBe("run-new");
    expect(record.oldCapsuleId).toBe("cap_old");
    expect(record.newCapsuleId).toBe("cap_new");
    expect(record.triggerEvidenceIds).toEqual(["ev-1"]);

    expect(await runStates.get("run-old")).toBe("RECOVERED");
    const history = await runStates.history("run-old");
    expect(history.at(-1)).toMatchObject({ state: "RECOVERED", byRunId: "run-new" });

    expect(await store.listAll()).toEqual([record]);

    const verification = await ledger.verifyChain("_governance");
    expect(verification.ok).toBe(true);
    expect(verification.eventCount).toBe(2);
  }, 10000);

  it("reconcile of a CLEAN run throws before any ledger event", async () => {
    const { runStates, ledger, redactor, store } = await makeHarness();

    const service = new ReconciliationServiceImpl({
      runStates,
      capsules: makeCapsuleLookup({}),
      ledger,
      redactor,
      store,
      startRun: async () => {
        throw new Error("startRun must not be called for a CLEAN run");
      },
    });

    await expect(service.reconcile("run-clean", "prompt", "agent-1")).rejects.toThrow(
      /STALE or TAINTED/,
    );

    const verification = await ledger.verifyChain("_governance");
    expect(verification.eventCount).toBe(0);
    expect(await store.listAll()).toEqual([]);
  });

  it("startRun throwing appends reconciliation.failed and rethrows, without persisting a record", async () => {
    const { runStates, ledger, redactor, store } = await makeHarness();
    await runStates.markTainted("run-old", "ev-2", "evidence ev-2 compromised");

    const capsules = makeCapsuleLookup({
      "run-old": () => makeCapsule({ capsuleId: "cap_old", runId: "run-old" }),
    });

    const service = new ReconciliationServiceImpl({
      runStates,
      capsules,
      ledger,
      redactor,
      store,
      startRun: async () => {
        throw new Error("boom: runner unavailable");
      },
    });

    await expect(service.reconcile("run-old", "prompt", "agent-1")).rejects.toThrow(
      /boom: runner unavailable/,
    );

    // The old run must not have been marked RECOVERED.
    expect(await runStates.get("run-old")).toBe("TAINTED");

    const verification = await ledger.verifyChain("_governance");
    expect(verification.ok).toBe(true);
    expect(verification.eventCount).toBe(2);

    expect(await store.listAll()).toEqual([]);
  });

  it("capsule polling exhausted after the replacement run was created: FAILED record persisted, old run left un-recovered", async () => {
    const { runStates, ledger, redactor, store } = await makeHarness();
    await runStates.markStale("run-old", "ev-3", "evidence ev-3 superseded");

    const capsules = makeCapsuleLookup({
      "run-old": () => makeCapsule({ capsuleId: "cap_old", runId: "run-old" }),
      // "run-new" never gets a capsule.
    });

    const service = new ReconciliationServiceImpl({
      runStates,
      capsules,
      ledger,
      redactor,
      store,
      startRun: async () => ({ runId: "run-new" }),
    });

    await expect(service.reconcile("run-old", "prompt", "agent-1")).rejects.toThrow(
      /no ContextCapsule after polling/,
    );

    expect(await runStates.get("run-old")).toBe("STALE");

    const records = await store.listAll();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      result: "FAILED",
      staleRunId: "run-old",
      replacementRunId: "run-new",
      oldCapsuleId: "cap_old",
      newCapsuleId: "",
    });

    const verification = await ledger.verifyChain("_governance");
    expect(verification.ok).toBe(true);
    expect(verification.eventCount).toBe(2);
  }, 10000);

  it("throws if the stale run has no capsule (predates Walnut context capture)", async () => {
    const { runStates, ledger, redactor, store } = await makeHarness();
    await runStates.markStale("run-old", "ev-1", "reason");

    const service = new ReconciliationServiceImpl({
      runStates,
      capsules: makeCapsuleLookup({}),
      ledger,
      redactor,
      store,
      startRun: async () => ({ runId: "run-new" }),
    });

    await expect(service.reconcile("run-old", "prompt", "agent-1")).rejects.toThrow(
      /no ContextCapsule/,
    );
    const verification = await ledger.verifyChain("_governance");
    expect(verification.eventCount).toBe(0);
  });
});

// Concurrency regression: two concurrent reconcile() calls for the same
// stale run must create AT MOST one replacement Run and one terminal record; the losing caller
// must reject cleanly without leaving a second Run or a false COMPLETED record behind.
describe("ReconciliationServiceImpl — R-10 concurrency", () => {
  it("two simultaneous reconciles: exactly one startRun, one COMPLETED record, loser rejects", async () => {
    const { runStates, ledger, redactor, store } = await makeHarness();
    await runStates.markTainted("run-old", "ev-1", "evidence ev-1 compromised");

    let startRunCalls = 0;
    const capsules = makeCapsuleLookup({
      "run-old": () => makeCapsule(),
      "run-new-1": () => makeCapsule({ capsuleId: "cap_new_1", runId: "run-new-1" }),
    });

    const service = new ReconciliationServiceImpl({
      runStates,
      capsules,
      ledger,
      redactor,
      store,
      startRun: async () => {
        startRunCalls += 1;
        // Yield so the second reconcile() would interleave here if the queue did not serialize.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { runId: `run-new-${startRunCalls}` };
      },
    });

    const [first, second] = await Promise.allSettled([
      service.reconcile("run-old", "original prompt", "agent-1"),
      service.reconcile("run-old", "original prompt", "agent-1"),
    ]);

    // Exactly one winner, one loser (order is deterministic: the queue runs them in call order).
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(String(second.reason)).toContain("expected STALE or TAINTED");
    }

    // Exactly one replacement Run was ever started.
    expect(startRunCalls).toBe(1);

    // Exactly one stored record, and it is the winner's COMPLETED record — no false/duplicate.
    const records = await store.listAll();
    expect(records).toHaveLength(1);
    expect(records[0]?.result).toBe("COMPLETED");
    expect(records[0]?.replacementRunId).toBe("run-new-1");

    // The old run is RECOVERED exactly once, by the winner's replacement.
    expect(await runStates.get("run-old")).toBe("RECOVERED");
    const recoveredEntries = (await runStates.history("run-old")).filter(
      (entry) => entry.state === "RECOVERED",
    );
    expect(recoveredEntries).toHaveLength(1);
    expect(recoveredEntries[0]?.byRunId).toBe("run-new-1");

    // Governance chain stays verifiable and carries exactly one reconciliation.completed.
    const verification = await ledger.verifyChain("_governance");
    expect(verification.ok).toBe(true);
    const events = await ledger.listEvents("_governance");
    expect(events.filter((event) => event.kind === "reconciliation.completed")).toHaveLength(1);
    // The loser rejected at step 1, so it appended no started/failed events of its own:
    expect(events.filter((event) => event.kind === "reconciliation.started")).toHaveLength(1);
  });
});
