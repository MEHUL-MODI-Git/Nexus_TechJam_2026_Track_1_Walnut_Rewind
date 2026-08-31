import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerEvent, RuntimeEventRecord } from "../types.js";
import { EvidenceLedger } from "./ledger.js";
import { Redactor, type RedactionResult } from "./redactor.js";
import { WalnutRuntimeEventSink } from "./runtime-event-sink.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "walnut-runtime-sink-test-"));
  temporaryDirectories.push(root);
  return root;
}

function chainPath(root: string, runId: string): string {
  return path.join(root, "walnut", "evidence", `${runId}.ndjson`);
}

async function readChainRecords(root: string, runId: string): Promise<LedgerEvent[]> {
  const raw = await readFile(chainPath(root, runId), "utf8");
  return raw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as LedgerEvent);
}

async function readChainBytes(root: string, runId: string): Promise<string> {
  return readFile(chainPath(root, runId), "utf8");
}

// A redactor that always throws, regardless of input — used to exercise the redaction_failure
// path (spec 002 §6) without depending on any specific input triggering a real redactor bug.
class ThrowingRedactor extends Redactor {
  override redact(_value: unknown): RedactionResult {
    throw new Error("simulated redactor failure");
  }
}

describe("WalnutRuntimeEventSink.accept", () => {
  it("(a) a valid JSONL line becomes one chained runtime.event LedgerEvent carrying the RuntimeEventRecord", async () => {
    const root = await makeRoot();
    const ledger = new EvidenceLedger(root);
    const redactor = new Redactor({ environment: {} });
    const sink = new WalnutRuntimeEventSink({ ledger, redactor });

    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "Hello there." },
    });

    await sink.accept({
      runId: "run-1",
      agentId: "agent-1",
      provider: "local-process",
      rawEvent: line,
      receivedAt: "2026-08-27T00:00:00.000Z",
    });

    const records = await readChainRecords(root, "run-1");
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("runtime.event");
    expect(records[0]?.actor).toBe("runtime");
    expect(records[0]?.runId).toBe("run-1");
    expect(records[0]?.agentId).toBe("agent-1");

    const record = records[0]?.safePayload as RuntimeEventRecord;
    expect(record.kind).toBe("runtime.message");
    expect(record.runId).toBe("run-1");
    expect(record.agentId).toBe("agent-1");
    expect(record.provider).toBe("local-process");
    expect(record.status).toBe("completed");
    expect(record.safeSummary).toBe("Hello there.");
    expect(record.runtimeItemId).toBe("item_1");
    expect(record.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(await ledger.verifyChain("run-1")).toEqual({ ok: true, eventCount: 1 });
  });

  it("(b) a malformed line becomes runtime.parse_failure with byteLength/rawHash and the raw line is never persisted", async () => {
    const root = await makeRoot();
    const ledger = new EvidenceLedger(root);
    const redactor = new Redactor({ environment: {} });
    const sink = new WalnutRuntimeEventSink({ ledger, redactor });

    const malformed = "{not json";
    await sink.accept({
      runId: "run-2",
      agentId: "agent-1",
      provider: "local-process",
      rawEvent: malformed,
      receivedAt: "2026-08-27T00:00:00.000Z",
    });

    const records = await readChainRecords(root, "run-2");
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("runtime.parse_failure");
    const payload = records[0]?.safePayload as { byteLength: number; rawHash: string };
    expect(payload.byteLength).toBe(Buffer.byteLength(malformed, "utf8"));
    expect(payload.rawHash).toBe(
      `sha256:${createHash("sha256").update(malformed, "utf8").digest("hex")}`,
    );
    expect(records[0]?.redactionReceipt).toEqual({
      applied: false,
      categories: [],
      replacementCount: 0,
      redactorVersion: "walnut-redactor-v1",
    });

    // CRITICAL (INV-18): the raw malformed line must not appear anywhere in the chain file bytes.
    const chainBytes = await readChainBytes(root, "run-2");
    expect(chainBytes.includes(malformed)).toBe(false);

    expect(await ledger.verifyChain("run-2")).toEqual({ ok: true, eventCount: 1 });
  });

  it("(c) a planted secret in a command string never reaches the persisted chain bytes", async () => {
    const root = await makeRoot();
    const ledger = new EvidenceLedger(root);
    const SECRET = "TEST_SECRET_VALUE_xyz";
    const redactor = new Redactor({ environment: {}, knownSecretValues: [SECRET] });
    const sink = new WalnutRuntimeEventSink({ ledger, redactor });

    const line = JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_2",
        type: "command_execution",
        command: `/usr/bin/bash -lc 'echo ${SECRET}'`,
        exit_code: 0,
      },
    });

    await sink.accept({
      runId: "run-3",
      agentId: "agent-1",
      provider: "container",
      rawEvent: line,
      receivedAt: "2026-08-27T00:00:00.000Z",
    });

    const chainBytes = await readChainBytes(root, "run-3");
    expect(chainBytes.includes(SECRET)).toBe(false);

    const records = await readChainRecords(root, "run-3");
    const record = records[0]?.safePayload as RuntimeEventRecord;
    expect(record.redactionReceipt.applied).toBe(true);
    expect(record.redactionReceipt.categories.length).toBeGreaterThan(0);
    expect(record.safeSummary?.includes(SECRET)).toBe(false);

    expect(await ledger.verifyChain("run-3")).toEqual({ ok: true, eventCount: 1 });
  });

  it("(d) a throwing redactor produces a hash-only redaction_failure event and the chain still verifies", async () => {
    const root = await makeRoot();
    const ledger = new EvidenceLedger(root);
    const redactor = new ThrowingRedactor({ environment: {} });
    const sink = new WalnutRuntimeEventSink({ ledger, redactor });

    const line = JSON.stringify({ type: "thread.started", thread_id: "thread-x" });
    await sink.accept({
      runId: "run-4",
      agentId: "agent-1",
      provider: "local-process",
      rawEvent: line,
      receivedAt: "2026-08-27T00:00:00.000Z",
    });

    const records = await readChainRecords(root, "run-4");
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("redaction_failure");
    const payload = records[0]?.safePayload as { byteLength: number; rawHash: string };
    expect(payload.byteLength).toBe(Buffer.byteLength(line, "utf8"));
    expect(payload.rawHash).toBe(`sha256:${createHash("sha256").update(line, "utf8").digest("hex")}`);
    expect(records[0]?.redactionReceipt.applied).toBe(false);

    expect(await ledger.verifyChain("run-4")).toEqual({ ok: true, eventCount: 1 });
  });

  it("hashes non-JSON defensive inputs without throwing or dropping failure events", async () => {
    const root = await makeRoot();
    const ledger = new EvidenceLedger(root);
    const sink = new WalnutRuntimeEventSink({ ledger, redactor: new Redactor({ environment: {} }) });
    const cyclic: Record<string, unknown> = { value: "safe" };
    cyclic["self"] = cyclic;

    await expect(
      sink.accept({
        runId: "run-defensive",
        agentId: "agent-1",
        provider: "local-process",
        rawEvent: 1n,
        receivedAt: "2026-08-27T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
    await expect(
      sink.accept({
        runId: "run-defensive",
        agentId: "agent-1",
        provider: "local-process",
        rawEvent: cyclic,
        receivedAt: "2026-08-27T00:00:01.000Z",
      }),
    ).resolves.toBeUndefined();

    const records = await readChainRecords(root, "run-defensive");
    expect(records.map((event) => event.kind)).toEqual([
      "redaction_failure",
      "redaction_failure",
    ]);
    for (const event of records) {
      expect(event.safePayload).toMatchObject({
        byteLength: expect.any(Number),
        rawHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      expect(JSON.stringify(event.safePayload)).not.toContain("safe");
    }
    expect(await ledger.verifyChain("run-defensive")).toEqual({ ok: true, eventCount: 2 });
  });

  it("(e) events for the same run are appended in send order even when accept() calls race", async () => {
    const root = await makeRoot();
    const ledger = new EvidenceLedger(root);
    const redactor = new Redactor({ environment: {} });
    const sink = new WalnutRuntimeEventSink({ ledger, redactor });

    const lines = Array.from({ length: 8 }, (_value, index) =>
      JSON.stringify({
        type: "item.completed",
        item: { id: `item_${index}`, type: "agent_message", text: `message ${index}` },
      }),
    );

    // Fire all accept() calls without awaiting individually, exactly as the shared JSONL
    // consumer's per-run promise queue does — send order must still win (INV-14).
    await Promise.all(
      lines.map((line) =>
        sink.accept({
          runId: "run-5",
          agentId: "agent-1",
          provider: "local-process",
          rawEvent: line,
          receivedAt: "2026-08-27T00:00:00.000Z",
        }),
      ),
    );

    const records = await readChainRecords(root, "run-5");
    expect(records).toHaveLength(8);
    const ids = records.map((record) => (record.safePayload as RuntimeEventRecord).runtimeItemId);
    expect(ids).toEqual(Array.from({ length: 8 }, (_value, index) => `item_${index}`));

    expect(await ledger.verifyChain("run-5")).toEqual({ ok: true, eventCount: 8 });
  });
});
