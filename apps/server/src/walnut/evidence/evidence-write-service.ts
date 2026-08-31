// EvidenceWriteServiceImpl (spec 003 §B2 VERBATIM, P2-E2) — the ONLY path by which Evidence,
// SourcePointer, and Citation records can be minted or transitioned (INV-4: no evidence without
// verified provenance). `createEvidence` runs the pinned pipeline, first failure wins:
//   1. schema sanity (incl. unknown derivedFromEvidenceIds entries)
//   2. safe, readable source (sources.read)
//   3. INV-6 classification monotonicity against current contributor versions
//   4. supersession-target validity (must be current ACTIVE)
//   5. mint + append the SourcePointer (BEFORE verification — the verifier resolves it through
//      the repository/sources; if verification fails the appended pointer stays as a harmless
//      orphan, because the store is append-only)
//   6. citation verification (INV-5/HC-6, delegated to CitationVerifier — never reimplemented)
//   7. mint + append the Citation
//   8. mint + append the Evidence
//   9. ledger `evidence.created` on the producer Run's chain, post-redaction payload
// `supersede`/`revoke`/`compromise` all follow the append-a-version-and-close-the-prior-one
// pattern (spec 003 §B2) and append their matching ledger event to the governance chain
// (runId: null).

import { randomUUID } from "node:crypto";
import type { CitationVerifier } from "../ports.js";
import { appendRedactedEvent } from "../shared/ledger-events.js";
import { sha256Prefixed } from "../shared/hash.js";
import {
  CLASSIFICATION_ORDER,
  type Citation,
  type Classification,
  type Evidence,
  type SourcePointer,
} from "../types.js";
import type { EvidenceLedger } from "./ledger.js";
import type { EvidenceStore } from "./evidence-store.js";
import { REDACTOR_VERSION, type Redactor } from "./redactor.js";
import type { WorkspaceSourceResolver } from "./workspace-source.js";

function isClassification(value: unknown): value is Classification {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(CLASSIFICATION_ORDER, value)
  );
}

// 1-based line number of the character at `charIndex` in `content`, counting `\n` occurrences
// strictly before it (spec pin: "compute lineStart/lineEnd 1-based by counting '\n' before
// charStart/charEnd in content").
function lineNumberAt(content: string, charIndex: number): number {
  const bound = Math.max(0, Math.min(charIndex, content.length));
  let newlines = 0;
  for (let index = 0; index < bound; index += 1) {
    if (content.charCodeAt(index) === 10) newlines += 1;
  }
  return newlines + 1;
}

export interface CreateEvidenceInput {
  claim: string;
  subjectKey: string | null;
  predicate: string | null;
  producerAgentId: string;
  producerRunId: string;
  classification: Classification;
  requiredScopes: string[];
  source: { path: string; quote: string; charStart: number; charEnd: number };
  derivedFromEvidenceIds: string[];
  supersedesEvidenceId: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export type CreateEvidenceFailureReason =
  | "unsafe_path"
  | "citation_mismatch"
  | "classification_violation"
  | "schema_invalid"
  | "supersedes_target_invalid";

export type CreateEvidenceResult =
  | { ok: true; evidence: Evidence }
  | { ok: false; reason: CreateEvidenceFailureReason; detail: string };

export interface EvidenceWriteService {
  createEvidence(input: CreateEvidenceInput): Promise<CreateEvidenceResult>;
  supersede(
    evidenceId: string,
    replacementEvidenceId: string,
  ): Promise<{ superseded: Evidence; replacement: Evidence }>;
  revoke(evidenceId: string, reason: string): Promise<Evidence>;
  compromise(evidenceId: string, reason: string): Promise<Evidence>;
}

export interface EvidenceWriteServiceDeps {
  store: EvidenceStore;
  sources: WorkspaceSourceResolver;
  verifier: CitationVerifier;
  ledger: EvidenceLedger;
  redactor: Redactor;
}

export class EvidenceWriteServiceImpl implements EvidenceWriteService {
  constructor(private readonly deps: EvidenceWriteServiceDeps) {}

  async createEvidence(input: CreateEvidenceInput): Promise<CreateEvidenceResult> {
    // 1. Schema sanity.
    if (input.claim.trim().length === 0) {
      return { ok: false, reason: "schema_invalid", detail: "claim must be non-empty" };
    }
    if (!isClassification(input.classification)) {
      return {
        ok: false,
        reason: "schema_invalid",
        detail: `unknown classification: ${String(input.classification)}`,
      };
    }
    const { source } = input;
    if (
      !Number.isFinite(source.charStart) ||
      !Number.isFinite(source.charEnd) ||
      source.charStart < 0 ||
      source.charEnd < 0 ||
      source.charStart >= source.charEnd
    ) {
      return {
        ok: false,
        reason: "schema_invalid",
        detail: "source.charStart must be >= 0 and strictly less than source.charEnd",
      };
    }

    const contributors: Evidence[] = [];
    for (const contributorId of input.derivedFromEvidenceIds) {
      const contributor = await this.deps.store.getEvidence(contributorId);
      if (contributor === null) {
        return {
          ok: false,
          reason: "schema_invalid",
          detail: `unknown derivedFromEvidenceIds entry: ${contributorId}`,
        };
      }
      contributors.push(contributor);
    }

    // 2. Safe, verifiable source read. `unsafe_path` from the resolver passes straight through;
    // `not_found`/`unreadable` means the path was safe but the quote cannot be verified.
    const resolved = await this.deps.sources.read(input.producerAgentId, source.path);
    if (!resolved.ok) {
      if (resolved.reason === "unsafe_path") {
        return { ok: false, reason: "unsafe_path", detail: `unsafe source path: ${source.path}` };
      }
      return {
        ok: false,
        reason: "citation_mismatch",
        detail: `source unavailable: ${resolved.reason}`,
      };
    }

    // 3. INV-6 monotonicity: derived classification must never be weaker than any contributor.
    const inputOrder = CLASSIFICATION_ORDER[input.classification];
    const maxContributorOrder = contributors.reduce(
      (max, contributor) => Math.max(max, CLASSIFICATION_ORDER[contributor.classification]),
      -1,
    );
    if (maxContributorOrder > inputOrder) {
      return {
        ok: false,
        reason: "classification_violation",
        detail: `classification ${input.classification} is weaker than a contributor's classification`,
      };
    }

    // 4. Supersession target validity.
    if (input.supersedesEvidenceId !== null) {
      const target = await this.deps.store.getEvidence(input.supersedesEvidenceId);
      if (target === null || target.status !== "ACTIVE") {
        return {
          ok: false,
          reason: "supersedes_target_invalid",
          detail: `supersedesEvidenceId ${input.supersedesEvidenceId} is not a current ACTIVE evidence`,
        };
      }
    }

    const now = new Date().toISOString();
    const lineStart = lineNumberAt(resolved.content, source.charStart);
    const lineEnd = lineNumberAt(resolved.content, source.charEnd);

    // 5. Mint + append the SourcePointer FIRST. If citation verification (step 6) rejects, this
    // record stays as a harmless orphan — the store is append-only and never rewound.
    const pointer: SourcePointer = {
      pointerId: `ptr_${randomUUID()}`,
      sourceId: `workspace://${input.producerAgentId}/${source.path}`,
      kind: "workspace_file",
      locator: { agentId: input.producerAgentId, path: source.path },
      contentHash: resolved.currentHash,
      mediaType: null,
      charStart: source.charStart,
      charEnd: source.charEnd,
      lineStart,
      lineEnd,
      observedAt: now,
      classification: input.classification,
    };
    await this.deps.store.appendPointer(pointer);

    // 6. Citation verification — delegated to CitationVerifier (HC-6/INV-5), never reimplemented.
    const verification = await this.deps.verifier.verify({
      quote: source.quote,
      charStart: source.charStart,
      charEnd: source.charEnd,
      pointer,
    });
    if (verification.verification !== "VERIFIED") {
      return {
        ok: false,
        reason: "citation_mismatch",
        detail: `${verification.verification}: ${verification.detail}`,
      };
    }

    // 7. Mint the Citation.
    const citation: Citation = {
      citationId: `cit_${randomUUID()}`,
      pointerId: pointer.pointerId,
      quotePreview: source.quote.slice(0, 120),
      quoteHash: verification.quoteHash,
      charStart: source.charStart,
      charEnd: source.charEnd,
      lineStart,
      lineEnd,
      verification: "VERIFIED",
      verifiedAt: now,
    };
    // 8. Mint the Evidence, then atomically commit it with its verified Citation.
    const evidence: Evidence = {
      evidenceId: `ev_${randomUUID()}`,
      version: 1,
      subjectKey: input.subjectKey,
      predicate: input.predicate,
      claim: input.claim,
      producerAgentId: input.producerAgentId,
      producerRunId: input.producerRunId,
      sourcePointerId: pointer.pointerId,
      citationId: citation.citationId,
      classification: input.classification,
      requiredScopes: input.requiredScopes,
      status: "ACTIVE",
      validFrom: input.validFrom,
      validTo: input.validTo,
      recordedAt: now,
      txClosedAt: null,
      supersedesEvidenceId: input.supersedesEvidenceId,
      derivedFromEvidenceIds: input.derivedFromEvidenceIds,
      claimHash: sha256Prefixed(input.claim),
    };
    await this.deps.store.appendVerifiedEvidence(citation, evidence);

    // 9. Ledger `evidence.created` on the producer Run's chain — post-redaction payload, real
    // receipt (the claim text may echo workspace/agent-authored content, HC-4).
    const redaction = this.deps.redactor.redact(evidence);
    try {
      await this.deps.ledger.append({
        runId: input.producerRunId,
        agentId: input.producerAgentId,
        capsuleId: null,
        kind: "evidence.created",
        actor: "middleware",
        occurredAt: now,
        safePayload: redaction.safeValue,
        redactionReceipt: {
          applied: redaction.replacementCount > 0,
          categories: redaction.categories,
          replacementCount: redaction.replacementCount,
          redactorVersion: REDACTOR_VERSION,
        },
        supersedesEventId: null,
      });
    } catch (error) {
      // Persistence spans two append-only stores. If the audit append fails after the evidence
      // commit, fail closed by immediately making that evidence non-active before propagating the
      // failure. It remains inspectable as a compromised version rather than usable unaudited.
      await this.deps.store.transitionEvidence(evidence.evidenceId, "COMPROMISED", "ACTIVE");
      throw error;
    }

    return { ok: true, evidence };
  }

  async supersede(
    evidenceId: string,
    replacementEvidenceId: string,
  ): Promise<{ superseded: Evidence; replacement: Evidence }> {
    const replacement = await this.deps.store.getEvidence(replacementEvidenceId);
    if (replacement === null || replacement.supersedesEvidenceId !== evidenceId) {
      throw new Error(
        `Replacement ${replacementEvidenceId} does not declare supersedesEvidenceId === ${evidenceId}`,
      );
    }
    const { previous, current: nextVersion } = await this.deps.store.transitionEvidence(
      evidenceId,
      "SUPERSEDED",
      "ACTIVE",
    );

    await this.appendGovernanceEvent("evidence.superseded", previous.producerAgentId, {
      evidenceId,
      newVersion: nextVersion.version,
      replacementEvidenceId,
    });

    return { superseded: nextVersion, replacement };
  }

  async revoke(evidenceId: string, reason: string): Promise<Evidence> {
    return this.transitionStatus(evidenceId, "REVOKED", "evidence.revoked", reason);
  }

  async compromise(evidenceId: string, reason: string): Promise<Evidence> {
    return this.transitionStatus(evidenceId, "COMPROMISED", "evidence.compromised", reason);
  }

  private async transitionStatus(
    evidenceId: string,
    status: "REVOKED" | "COMPROMISED",
    kind: "evidence.revoked" | "evidence.compromised",
    reason: string,
  ): Promise<Evidence> {
    const { previous, current: nextVersion } = await this.deps.store.transitionEvidence(
      evidenceId,
      status,
    );

    await this.appendGovernanceEvent(kind, previous.producerAgentId, { evidenceId, reason });

    return nextVersion;
  }

  // Governance-chain event (runId: null) — same redact-then-append shape as createEvidence's
  // evidence.created, applied uniformly even though only the `reason` field on revoke/compromise
  // is genuinely free text (HC-4).
  private async appendGovernanceEvent(
    kind: "evidence.superseded" | "evidence.revoked" | "evidence.compromised",
    agentId: string,
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
