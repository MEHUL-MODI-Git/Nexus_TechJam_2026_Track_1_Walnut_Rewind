// EvidenceStore (spec 003 §B1/§B2, P2-E1) — single JSON file persisting every Evidence,
// SourcePointer, and Citation record for this deployment. Records are append-only: the only
// permitted mutation of an already-stored Evidence record is filling a null `txClosedAt`
// (spec 003 §B2). Same clone-mutate-persist-swap queue + atomic tmp+rename pattern as
// ../auth/grant-store.ts.
//
// FileEvidenceRepository (spec 003 §B1) is the real EvidenceRepository implementation over this
// store plus a WorkspaceSourceResolver — it replaces the Phase-1 empty-repository stand-in
// (removed) in the composition root.

import path from "node:path";
import type { EvidenceRepository } from "../ports.js";
import { evidenceKnownAt } from "../context/temporal-resolver.js";
import { JsonFileState } from "../shared/json-file-state.js";
import type { Citation, Evidence, SourcePointer } from "../types.js";
import type { WorkspaceSourceResolver } from "./workspace-source.js";

interface EvidenceStoreFile {
  version: 1;
  evidence: Evidence[];
  pointers: SourcePointer[];
  citations: Citation[];
}

const emptyStoreFile = (): EvidenceStoreFile => ({
  version: 1,
  evidence: [],
  pointers: [],
  citations: [],
});

function highestVersion(records: Evidence[], evidenceId: string): Evidence | null {
  let latest: Evidence | null = null;
  for (const record of records) {
    if (record.evidenceId !== evidenceId) continue;
    if (latest === null || record.version > latest.version) latest = record;
  }
  return latest;
}

export class EvidenceStore {
  private readonly state: JsonFileState<EvidenceStoreFile>;

  constructor(dataDir: string) {
    this.state = new JsonFileState<EvidenceStoreFile>({
      filePath: path.join(dataDir, "walnut", "evidence", "evidence-store.json"),
      empty: emptyStoreFile,
      validate: (parsed) => {
        const file = parsed as EvidenceStoreFile;
        if (
          file.version !== 1 ||
          !Array.isArray(file.evidence) ||
          !Array.isArray(file.pointers) ||
          !Array.isArray(file.citations)
        ) {
          throw new Error("Unsupported evidence store file format");
        }
        return file;
      },
    });
  }

  async appendEvidence(evidence: Evidence): Promise<Evidence> {
    return this.state.mutate((file) => {
      file.evidence.push(evidence);
      return evidence;
    });
  }

  // Fills a null `txClosedAt` on the stored version record identified by (evidenceId, version).
  // This is the ONLY permitted mutation of an already-stored version (spec 003 §B2). Rejects
  // (throws) if the version does not exist, or if it is already closed.
  async closeEvidenceVersion(evidenceId: string, version: number): Promise<void> {
    await this.state.mutate((file) => {
      const record = file.evidence.find(
        (item) => item.evidenceId === evidenceId && item.version === version,
      );
      if (!record) {
        throw new Error(`Unknown evidence version: ${evidenceId}@${version}`);
      }
      if (record.txClosedAt !== null) {
        throw new Error(`Evidence version already closed: ${evidenceId}@${version}`);
      }
      record.txClosedAt = new Date().toISOString();
    });
  }

  async appendPointer(pointer: SourcePointer): Promise<SourcePointer> {
    return this.state.mutate((file) => {
      file.pointers.push(pointer);
      return pointer;
    });
  }

  async appendCitation(citation: Citation): Promise<Citation> {
    return this.state.mutate((file) => {
      file.citations.push(citation);
      return citation;
    });
  }

  // Commits the two records that establish a verified Evidence atomically. The SourcePointer is
  // intentionally minted before citation verification and may remain orphaned on a mismatch,
  // but a Citation must never be visible without its Evidence (or vice versa).
  async appendVerifiedEvidence(citation: Citation, evidence: Evidence): Promise<Evidence> {
    return this.state.mutate((file) => {
      if (!file.pointers.some((pointer) => pointer.pointerId === citation.pointerId)) {
        throw new Error(`Unknown source pointer: ${citation.pointerId}`);
      }
      if (citation.citationId !== evidence.citationId) {
        throw new Error(`Citation ${citation.citationId} does not belong to ${evidence.evidenceId}`);
      }
      if (file.citations.some((item) => item.citationId === citation.citationId)) {
        throw new Error(`Duplicate citation: ${citation.citationId}`);
      }
      if (
        file.evidence.some(
          (item) => item.evidenceId === evidence.evidenceId && item.version === evidence.version,
        )
      ) {
        throw new Error(`Duplicate evidence version: ${evidence.evidenceId}@${evidence.version}`);
      }
      file.citations.push(citation);
      file.evidence.push(evidence);
      return evidence;
    });
  }

  // Serializes read-current + close-current + append-next in one durable mutation. This avoids
  // duplicate version numbers and multiple open transaction-time versions under concurrent
  // lifecycle requests.
  async transitionEvidence(
    evidenceId: string,
    status: Evidence["status"],
    requiredCurrentStatus?: Evidence["status"],
  ): Promise<{ previous: Evidence; current: Evidence }> {
    return this.state.mutate((file) => {
      const previous = highestVersion(file.evidence, evidenceId);
      if (previous === null) {
        throw new Error(`Unknown evidence: ${evidenceId}`);
      }
      if (previous.txClosedAt !== null) {
        throw new Error(`Current evidence version is already closed: ${evidenceId}@${previous.version}`);
      }
      if (requiredCurrentStatus !== undefined && previous.status !== requiredCurrentStatus) {
        throw new Error(`Evidence ${evidenceId} is not current ${requiredCurrentStatus} evidence`);
      }

      const now = new Date().toISOString();
      previous.txClosedAt = now;
      const current: Evidence = {
        ...previous,
        version: previous.version + 1,
        status,
        recordedAt: now,
        txClosedAt: null,
      };
      file.evidence.push(current);
      return { previous: structuredClone(previous), current };
    });
  }

  // No `version` = highest stored version for that evidenceId.
  async getEvidence(evidenceId: string, version?: number): Promise<Evidence | null> {
    const file = await this.state.read();
    if (version !== undefined) {
      return (
        file.evidence.find(
          (item) => item.evidenceId === evidenceId && item.version === version,
        ) ?? null
      );
    }
    return highestVersion(file.evidence, evidenceId);
  }

  // Highest version per evidenceId, across ALL statuses (ACTIVE/SUPERSEDED/REVOKED/COMPROMISED)
  // — filtering by status/classification is authorization's job, not the repository's.
  async listCurrentEvidence(): Promise<Evidence[]> {
    const file = await this.state.read();
    const currentById = new Map<string, Evidence>();
    for (const record of file.evidence) {
      const existing = currentById.get(record.evidenceId);
      if (!existing || record.version > existing.version) {
        currentById.set(record.evidenceId, record);
      }
    }
    return [...currentById.values()];
  }

  // Read-all accessors (P2-X1): every stored record, ALL versions/statuses, unfiltered — additive,
  // no behaviour change to the existing highest-version/single-record readers above. Consumed by
  // the dependency projector (needs every Evidence version to compute SUPERSEDES edges) and by
  // the evidence-detail route (needs every version of one evidenceId).
  async listAllVersions(): Promise<Evidence[]> {
    const file = await this.state.read();
    return structuredClone(file.evidence);
  }

  async listAllPointers(): Promise<SourcePointer[]> {
    const file = await this.state.read();
    return structuredClone(file.pointers);
  }

  async getPointer(pointerId: string): Promise<SourcePointer | null> {
    const file = await this.state.read();
    return file.pointers.find((item) => item.pointerId === pointerId) ?? null;
  }

  async getCitation(citationId: string): Promise<Citation | null> {
    const file = await this.state.read();
    return file.citations.find((item) => item.citationId === citationId) ?? null;
  }

}

export class FileEvidenceRepository implements EvidenceRepository {
  constructor(private readonly deps: { store: EvidenceStore; sources: WorkspaceSourceResolver }) {}

  async getEvidence(evidenceId: string, version?: number): Promise<Evidence | null> {
    return this.deps.store.getEvidence(evidenceId, version);
  }

  async listCandidateEvidence(query: { agentId: string; knownAt?: string }): Promise<Evidence[]> {
    if (query.knownAt === undefined) {
      return this.deps.store.listCurrentEvidence();
    }
    const knownAt = new Date(query.knownAt).toISOString();
    return evidenceKnownAt(await this.deps.store.listAllVersions(), knownAt);
  }

  async getSourcePointer(pointerId: string): Promise<SourcePointer | null> {
    return this.deps.store.getPointer(pointerId);
  }

  async getCitation(citationId: string): Promise<Citation | null> {
    return this.deps.store.getCitation(citationId);
  }

  async resolveSourceContent(pointerId: string): Promise<
    | { ok: true; content: string; currentHash: string; drifted: boolean }
    | { ok: false; reason: "not_found" | "unsafe_path" | "unreadable" }
  > {
    const pointer = await this.deps.store.getPointer(pointerId);
    if (pointer === null) {
      return { ok: false, reason: "not_found" };
    }

    const locatorAgentId = pointer.locator["agentId"];
    const locatorPath = pointer.locator["path"];
    if (typeof locatorAgentId !== "string" || typeof locatorPath !== "string") {
      return { ok: false, reason: "not_found" };
    }

    const resolved = await this.deps.sources.read(locatorAgentId, locatorPath);
    if (!resolved.ok) {
      return resolved;
    }
    return {
      ok: true,
      content: resolved.content,
      currentHash: resolved.currentHash,
      drifted: resolved.currentHash !== pointer.contentHash,
    };
  }
}
