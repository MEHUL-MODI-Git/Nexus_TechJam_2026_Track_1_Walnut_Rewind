import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { LedgerEvent, RedactionReceipt } from "../types.js";
import { sha256Hex, sha256Prefixed } from "../shared/hash.js";
import { canonicalJson } from "./canonical-json.js";

const GENESIS_HASH = "0".repeat(64);
const GOVERNANCE_CHAIN_ID = "_governance";
const SAFE_CHAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface LedgerAppendInput {
  runId: string | null;
  agentId: string | null;
  capsuleId: string | null;
  kind: string;
  actor: LedgerEvent["actor"];
  occurredAt: string;
  safePayload: unknown;
  redactionReceipt: RedactionReceipt;
  supersedesEventId: string | null;
}

export interface ChainVerification {
  ok: boolean;
  eventCount: number;
  brokenAtSequence?: number;
  reason?:
    | "hash_mismatch"
    | "prev_hash_mismatch"
    | "sequence_gap"
    | "parse_failure";
}

interface ChainHead {
  sequence: number;
  eventHash: string;
}

function withoutEventHash(event: LedgerEvent): Omit<LedgerEvent, "eventHash"> {
  const { eventHash: _eventHash, ...record } = event;
  return record;
}

function linesFromNdjson(raw: string): string[] {
  if (raw.length === 0) return [];
  return (raw.endsWith("\n") ? raw.slice(0, -1) : raw).split("\n");
}

export class EvidenceLedger {
  private readonly evidenceDirectory: string;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(dataDirectory: string) {
    this.evidenceDirectory = path.join(dataDirectory, "walnut", "evidence");
  }

  append(input: LedgerAppendInput): Promise<LedgerEvent> {
    if (input.runId === GOVERNANCE_CHAIN_ID) {
      throw new TypeError("Ledger run ID collides with the governance chain");
    }
    const chainId = input.runId ?? GOVERNANCE_CHAIN_ID;
    this.validateChainId(chainId);

    let result!: LedgerEvent;
    const operation = (this.queues.get(chainId) ?? Promise.resolve()).then(async () => {
      const head = await this.loadHead(chainId);
      const sequence = head.sequence + 1;
      const previousHash = head.eventHash;
      const recordedAt = new Date().toISOString();
      const payloadHash = sha256Prefixed(canonicalJson(input.safePayload));
      const eventWithoutHash: Omit<LedgerEvent, "eventHash"> = {
        schemaVersion: 1,
        eventId: `levt_${randomUUID()}`,
        sequence,
        runId: input.runId,
        agentId: input.agentId,
        capsuleId: input.capsuleId,
        kind: input.kind,
        actor: input.actor,
        occurredAt: input.occurredAt,
        recordedAt,
        safePayload: input.safePayload,
        payloadHash,
        redactionReceipt: input.redactionReceipt,
        supersedesEventId: input.supersedesEventId,
        previousHash,
      };
      const eventHash = sha256Hex(
        previousHash + canonicalJson(eventWithoutHash),
      );
      result = { ...eventWithoutHash, eventHash };

      await mkdir(this.evidenceDirectory, { recursive: true, mode: 0o700 });
      await appendFile(this.chainPath(chainId), canonicalJson(result) + "\n", {
        encoding: "utf8",
        flag: "a",
        mode: 0o600,
      });
    });
    this.queues.set(
      chainId,
      operation.then(
        () => undefined,
        () => undefined,
      ),
    );
    return operation.then(() => result);
  }

  async verifyChain(chainId: string): Promise<ChainVerification> {
    this.validateChainId(chainId);
    let raw: string;
    try {
      raw = await readFile(this.chainPath(chainId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true, eventCount: 0 };
      }
      throw error;
    }

    const lines = linesFromNdjson(raw);
    let previousHash = GENESIS_HASH;
    for (let index = 0; index < lines.length; index += 1) {
      const expectedSequence = index + 1;
      let event: LedgerEvent;
      try {
        const parsed = JSON.parse(lines[index] as string) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new TypeError("Ledger line is not an object");
        }
        event = parsed as LedgerEvent;
      } catch {
        return {
          ok: false,
          eventCount: lines.length,
          brokenAtSequence: expectedSequence,
          reason: "parse_failure",
        };
      }
      if (event.sequence !== expectedSequence) {
        return {
          ok: false,
          eventCount: lines.length,
          brokenAtSequence: expectedSequence,
          reason: "sequence_gap",
        };
      }
      if (event.previousHash !== previousHash) {
        return {
          ok: false,
          eventCount: lines.length,
          brokenAtSequence: expectedSequence,
          reason: "prev_hash_mismatch",
        };
      }

      let recomputedHash: string;
      try {
        recomputedHash = sha256Hex(
          previousHash + canonicalJson(withoutEventHash(event)),
        );
      } catch {
        return {
          ok: false,
          eventCount: lines.length,
          brokenAtSequence: expectedSequence,
          reason: "parse_failure",
        };
      }
      if (event.eventHash !== recomputedHash) {
        return {
          ok: false,
          eventCount: lines.length,
          brokenAtSequence: expectedSequence,
          reason: "hash_mismatch",
        };
      }
      previousHash = event.eventHash;
    }
    return { ok: true, eventCount: lines.length };
  }

  // Additive read accessor (P3-D6/E1): every stored event on a chain, in file order, parsed from
  // NDJSON. [] for a chain with no file yet -- same "absent chain reads as empty" convention as
  // verifyChain's { ok: true, eventCount: 0 } case. Reuses the same line-splitting helper as
  // verifyChain; does not change append()/verifyChain() behaviour.
  async listEvents(chainId: string): Promise<LedgerEvent[]> {
    this.validateChainId(chainId);
    let raw: string;
    try {
      raw = await readFile(this.chainPath(chainId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return linesFromNdjson(raw).map((line) => JSON.parse(line) as LedgerEvent);
  }

  // Additive read accessor: the last event's { sequence, eventHash }, or null for an empty/absent
  // chain. Reads through listEvents rather than the in-memory append-path `heads` cache, so it is
  // safe to call from a process that never appended to this chain.
  async head(chainId: string): Promise<{ sequence: number; eventHash: string } | null> {
    const events = await this.listEvents(chainId);
    const last = events.at(-1);
    return last ? { sequence: last.sequence, eventHash: last.eventHash } : null;
  }

  private async loadHead(chainId: string): Promise<ChainHead> {
    // Re-verify on EVERY append. A cached head can become stale when an operator or another
    // process modifies the chain file after this instance has appended once; trusting it would
    // allow new records to be added behind already-tampered history (INV-13/HC-7).
    const verification = await this.verifyChain(chainId);
    if (!verification.ok) {
      throw new Error(
        `Refusing to append to broken ledger chain ${chainId} at sequence ${verification.brokenAtSequence ?? "unknown"}: ${verification.reason ?? "unknown"}`,
      );
    }
    if (verification.eventCount === 0) {
      return { sequence: 0, eventHash: GENESIS_HASH };
    }

    const raw = await readFile(this.chainPath(chainId), "utf8");
    const lines = linesFromNdjson(raw);
    const last = JSON.parse(lines.at(-1) as string) as LedgerEvent;
    return { sequence: last.sequence, eventHash: last.eventHash };
  }

  private validateChainId(chainId: string): void {
    if (chainId !== GOVERNANCE_CHAIN_ID && !SAFE_CHAIN_ID.test(chainId)) {
      throw new TypeError("Ledger chain ID is not a safe run ID");
    }
  }

  private chainPath(chainId: string): string {
    return path.join(this.evidenceDirectory, `${chainId}.ndjson`);
  }
}
