import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WalnutRunStateStore } from "./run-state.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "walnut-run-state-"));
  directories.push(dir);
  return dir;
}

describe("WalnutRunStateStore", () => {
  it("defaults an unknown run to CLEAN with empty history", async () => {
    const store = new WalnutRunStateStore(await makeTempDir());
    expect(await store.get("run-unknown")).toBe("CLEAN");
    expect(await store.history("run-unknown")).toEqual([]);
    expect(await store.listAll()).toEqual([]);
  });

  it("stale -> tainted -> recovered appends to history without rewriting any entry", async () => {
    const store = new WalnutRunStateStore(await makeTempDir());

    await store.markStale("run-1", "ev-1", "evidence ev-1 revoked");
    await store.markTainted("run-1", "ev-2", "evidence ev-2 compromised");
    const recovered = await store.markRecovered("run-1", "run-2", "reconciled");

    expect(await store.get("run-1")).toBe("RECOVERED");
    expect(recovered.state).toBe("RECOVERED");

    const history = await store.history("run-1");
    expect(history).toEqual([
      {
        state: "STALE",
        reason: "evidence ev-1 revoked",
        at: expect.any(String),
        byRunId: null,
        triggerEvidenceId: "ev-1",
      },
      {
        state: "TAINTED",
        reason: "evidence ev-2 compromised",
        at: expect.any(String),
        byRunId: null,
        triggerEvidenceId: "ev-2",
      },
      {
        state: "RECOVERED",
        reason: "reconciled",
        at: expect.any(String),
        byRunId: "run-2",
        triggerEvidenceId: null,
      },
    ]);
  });

  it("markRecovered on a CLEAN run throws -- recovering a run that was never invalidated is a caller bug", async () => {
    const store = new WalnutRunStateStore(await makeTempDir());
    await expect(store.markRecovered("run-clean", "run-2", "reconciled")).rejects.toThrow();
    expect(await store.get("run-clean")).toBe("CLEAN");
    expect(await store.history("run-clean")).toEqual([]);
  });

  it("markRecovered succeeds from STALE directly, without first requiring TAINTED", async () => {
    const store = new WalnutRunStateStore(await makeTempDir());
    await store.markStale("run-3", "ev-9", "evidence ev-9 superseded");
    await store.markRecovered("run-3", "run-4", "reconciled");
    expect(await store.get("run-3")).toBe("RECOVERED");
  });

  it("persists across store re-instantiation against the same dataDir", async () => {
    const dataDir = await makeTempDir();
    const first = new WalnutRunStateStore(dataDir);
    await first.markStale("run-5", "ev-1", "reason");
    await first.markTainted("run-5", "ev-2", "reason2");

    const second = new WalnutRunStateStore(dataDir);
    expect(await second.get("run-5")).toBe("TAINTED");
    expect(await second.history("run-5")).toHaveLength(2);
  });

  it("listAll returns every run's record, sorted by runId", async () => {
    const store = new WalnutRunStateStore(await makeTempDir());
    await store.markStale("run-b", null, "reason");
    await store.markStale("run-a", null, "reason");

    const all = await store.listAll();
    expect(all.map((record) => record.runId)).toEqual(["run-a", "run-b"]);
  });

  it("unrestricted v1 transitions: any -> any is allowed except into RECOVERED from CLEAN", async () => {
    const store = new WalnutRunStateStore(await makeTempDir());
    await store.markTainted("run-6", "ev-1", "straight to tainted, no prior stale");
    expect(await store.get("run-6")).toBe("TAINTED");
    await store.markStale("run-6", "ev-2", "back to stale is allowed in v1");
    expect(await store.get("run-6")).toBe("STALE");
  });
});
