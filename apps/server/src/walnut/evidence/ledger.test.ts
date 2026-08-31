import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerEvent, RedactionReceipt } from "../types.js";
import { canonicalJson } from "./canonical-json.js";
import { EvidenceLedger, type LedgerAppendInput } from "./ledger.js";

const temporaryDirectories: string[] = [];
const NO_REDACTION: RedactionReceipt = {
  applied: false,
  categories: [],
  replacementCount: 0,
  redactorVersion: "walnut-redactor-v1",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function setup(): Promise<{ root: string; ledger: EvidenceLedger }> {
  const root = await mkdtemp(path.join(tmpdir(), "walnut-ledger-test-"));
  temporaryDirectories.push(root);
  return { root, ledger: new EvidenceLedger(root) };
}

function input(
  runId: string | null,
  kind: string,
  safePayload: unknown,
): LedgerAppendInput {
  return {
    runId,
    agentId: runId ? "agent-1" : null,
    capsuleId: null,
    kind,
    actor: "middleware",
    occurredAt: "2026-08-27T00:00:00.000Z",
    safePayload,
    redactionReceipt: NO_REDACTION,
    supersedesEventId: null,
  };
}

function chainPath(root: string, chainId: string): string {
  return path.join(root, "walnut", "evidence", `${chainId}.ndjson`);
}

async function seedThree(root: string): Promise<{
  ledger: EvidenceLedger;
  filePath: string;
  records: LedgerEvent[];
}> {
  const ledger = new EvidenceLedger(root);
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    await ledger.append(input("run-1", `test.${sequence}`, { sequence }));
  }
  const filePath = chainPath(root, "run-1");
  const records = (await readFile(filePath, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as LedgerEvent);
  return { ledger, filePath, records };
}

async function writeRecords(filePath: string, records: LedgerEvent[]): Promise<void> {
  await writeFile(
    filePath,
    records.map((record) => canonicalJson(record)).join("\n") + "\n",
    "utf8",
  );
}

describe("EvidenceLedger", () => {
  it("appends canonical NDJSON with independent per-run and governance chains", async () => {
    const { root, ledger } = await setup();
    const first = await ledger.append(input("run-1", "run.requested", { z: 2, a: 1 }));
    const second = await ledger.append(input("run-1", "run.completed", { ok: true }));
    const governance = await ledger.append(input(null, "grant.issued", { grantId: "grant-1" }));

    expect(first.sequence).toBe(1);
    expect(first.previousHash).toBe("0".repeat(64));
    expect(second.sequence).toBe(2);
    expect(second.previousHash).toBe(first.eventHash);
    expect(governance.sequence).toBe(1);
    expect(governance.previousHash).toBe("0".repeat(64));
    expect(await ledger.verifyChain("run-1")).toEqual({ ok: true, eventCount: 2 });
    expect(await ledger.verifyChain("_governance")).toEqual({
      ok: true,
      eventCount: 1,
    });

    const stored = await readFile(chainPath(root, "run-1"), "utf8");
    expect(stored.endsWith("\n")).toBe(true);
    for (const line of stored.trimEnd().split("\n")) {
      expect(line).toBe(canonicalJson(JSON.parse(line)));
    }
  });

  it("serializes concurrent same-run appends and restores the head after restart", async () => {
    const { root, ledger } = await setup();
    const events = await Promise.all(
      Array.from({ length: 12 }, (_value, index) =>
        ledger.append(input("run-concurrent", "runtime.event", { index })),
      ),
    );
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 12 }, (_value, index) => index + 1),
    );

    const restarted = new EvidenceLedger(root);
    const next = await restarted.append(
      input("run-concurrent", "run.completed", { completed: true }),
    );
    expect(next.sequence).toBe(13);
    expect(await restarted.verifyChain("run-concurrent")).toEqual({
      ok: true,
      eventCount: 13,
    });
  });

  it("detects the modify/delete/insert/reorder tamper matrix", async () => {
    const cases: Array<{
      name: string;
      tamper(records: LedgerEvent[]): LedgerEvent[];
      reason: "hash_mismatch" | "sequence_gap";
      brokenAtSequence: number;
    }> = [
      {
        name: "modify",
        tamper: (records) => [
          records[0] as LedgerEvent,
          { ...(records[1] as LedgerEvent), safePayload: { changed: true } },
          records[2] as LedgerEvent,
        ],
        reason: "hash_mismatch",
        brokenAtSequence: 2,
      },
      {
        name: "delete",
        tamper: (records) => [records[0] as LedgerEvent, records[2] as LedgerEvent],
        reason: "sequence_gap",
        brokenAtSequence: 2,
      },
      {
        name: "insert",
        tamper: (records) => [
          records[0] as LedgerEvent,
          records[0] as LedgerEvent,
          records[1] as LedgerEvent,
          records[2] as LedgerEvent,
        ],
        reason: "sequence_gap",
        brokenAtSequence: 2,
      },
      {
        name: "reorder",
        tamper: (records) => [
          records[1] as LedgerEvent,
          records[0] as LedgerEvent,
          records[2] as LedgerEvent,
        ],
        reason: "sequence_gap",
        brokenAtSequence: 1,
      },
    ];

    for (const testCase of cases) {
      const root = await mkdtemp(path.join(tmpdir(), `walnut-ledger-${testCase.name}-`));
      temporaryDirectories.push(root);
      const { ledger, filePath, records } = await seedThree(root);
      await writeRecords(filePath, testCase.tamper(records));
      expect(await ledger.verifyChain("run-1"), testCase.name).toMatchObject({
        ok: false,
        brokenAtSequence: testCase.brokenAtSequence,
        reason: testCase.reason,
      });
    }
  });

  it("reports parse and previous-hash failures and refuses to append after tampering", async () => {
    const { root } = await setup();
    const { filePath, records } = await seedThree(root);
    const verifier = new EvidenceLedger(root);

    await writeFile(filePath, "not-json\n", "utf8");
    expect(await verifier.verifyChain("run-1")).toEqual({
      ok: false,
      eventCount: 1,
      brokenAtSequence: 1,
      reason: "parse_failure",
    });

    await writeRecords(filePath, [
      records[0] as LedgerEvent,
      {
        ...(records[1] as LedgerEvent),
        previousHash: "f".repeat(64),
      },
      records[2] as LedgerEvent,
    ]);
    expect(await verifier.verifyChain("run-1")).toMatchObject({
      ok: false,
      brokenAtSequence: 2,
      reason: "prev_hash_mismatch",
    });
    await expect(
      new EvidenceLedger(root).append(input("run-1", "run.completed", {})),
    ).rejects.toThrow("Refusing to append to broken ledger chain");
  });

  it("refuses to append through the same live instance after its on-disk chain is tampered", async () => {
    const { root, ledger } = await setup();
    await ledger.append(input("run-live", "run.requested", { value: 1 }));

    const filePath = chainPath(root, "run-live");
    const stored = JSON.parse((await readFile(filePath, "utf8")).trim()) as LedgerEvent;
    await writeRecords(filePath, [{ ...stored, safePayload: { value: 9 } }]);

    await expect(
      ledger.append(input("run-live", "run.completed", { value: 2 })),
    ).rejects.toThrow("Refusing to append to broken ledger chain");
    expect(await ledger.verifyChain("run-live")).toMatchObject({
      ok: false,
      brokenAtSequence: 1,
      reason: "hash_mismatch",
    });
  });

  it("listEvents/head round-trip and read empty/null for an absent chain", async () => {
    const { ledger } = await setup();
    expect(await ledger.listEvents("nope")).toEqual([]);
    expect(await ledger.head("nope")).toBeNull();

    const first = await ledger.append(input("run-2", "run.requested", { a: 1 }));
    const second = await ledger.append(input("run-2", "run.completed", { ok: true }));

    expect(await ledger.listEvents("run-2")).toEqual([first, second]);
    expect(await ledger.head("run-2")).toEqual({
      sequence: second.sequence,
      eventHash: second.eventHash,
    });
  });

  it("returns an empty valid chain for a missing file and rejects unsafe IDs", async () => {
    const { ledger } = await setup();
    expect(await ledger.verifyChain("missing-run")).toEqual({
      ok: true,
      eventCount: 0,
    });
    expect(() => ledger.append(input("../escape", "runtime.event", {}))).toThrow(
      "safe run ID",
    );
    expect(() =>
      ledger.append(input("_governance", "runtime.event", {})),
    ).toThrow("collides");
    await expect(ledger.verifyChain("nested/run")).rejects.toThrow("safe run ID");
  });
});
