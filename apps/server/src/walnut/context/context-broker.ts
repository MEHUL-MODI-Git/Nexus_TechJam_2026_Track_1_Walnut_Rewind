// ContextBrokerImpl (spec 003 §A1) — authorizes candidate evidence BEFORE capsule assembly
// (HC-5), detects evidence conflicts among the authorized set (P3-C1, INV-22), builds and
// persists the immutable ContextCapsule, and renders the <WALNUT_CONTEXT> prompt block via
// context-renderer.ts.
//
// `kind: "clarification_required"` (frozen in the union since spec 003 §A1, only ever
// constructed here from P3-C1 onward): when the authorized evidence set contains a conflict
// (detectConflicts), the broker mints and persists exactly one ClarificationRequest for the
// FIRST conflict group and returns without ever assembling a capsule. No code path here chooses
// among conflicting evidence — that is the enforcement of "no silent pick, ever".

import { createHash, randomUUID } from "node:crypto";
import type { AuthorizationEvaluator } from "../auth/evaluator.js";
import { policyHash, type WalnutPolicy } from "../auth/policy.js";
import { canonicalJson } from "../evidence/canonical-json.js";
import type {
  CapsuleBuildInput,
  CapsuleBuildResult,
  CapsuleStore,
  ContextBroker,
  EvidenceRepository,
} from "../ports.js";
import type {
  AuthorizationDecision,
  ClarificationRequest,
  ContextCapsule,
  ContextEvidenceRef,
  Evidence,
} from "../types.js";
import type { ClarificationStoreImpl } from "./clarification-store.js";
import { detectConflicts } from "./conflict-detector.js";
import { renderCapsuleBlock, type ResolvedCapsuleRef } from "./context-renderer.js";

export interface ContextBrokerDeps {
  evidenceRepository: EvidenceRepository;
  evaluator: AuthorizationEvaluator;
  capsuleStore: CapsuleStore;
  policy: WalnutPolicy;
  clarifications: ClarificationStoreImpl;
  getGovernanceHead: () => Promise<number>;
}

export class ContextBrokerImpl implements ContextBroker {
  private readonly evidenceRepository: EvidenceRepository;
  private readonly evaluator: AuthorizationEvaluator;
  private readonly capsuleStore: CapsuleStore;
  private readonly policy: WalnutPolicy;
  private readonly clarifications: ClarificationStoreImpl;
  private readonly getGovernanceHead: () => Promise<number>;

  constructor(deps: ContextBrokerDeps) {
    this.evidenceRepository = deps.evidenceRepository;
    this.evaluator = deps.evaluator;
    this.capsuleStore = deps.capsuleStore;
    this.policy = deps.policy;
    this.clarifications = deps.clarifications;
    this.getGovernanceHead = deps.getGovernanceHead;
  }

  async build(input: CapsuleBuildInput): Promise<CapsuleBuildResult> {
    // 1. Run-level standing refusal — "denied" is reserved solely for run-level policy refusal,
    // independent of candidate evidence. No capsule is created or persisted on this path.
    if (this.policy.denyAgentIds.includes(input.agent.id)) {
      return {
        kind: "denied",
        decisions: [],
        reasonCode: "POLICY_DENIED",
        message: `Agent is deny-listed by policy revision ${this.policy.revision}`,
      };
    }

    // 2. Mint the capsule id up front so every per-evidence decision records it.
    const capsuleId = `cap_${randomUUID()}`;

    // 3. Candidate evidence — ALL statuses/classifications; authorization decides ALLOW/DENY.
    const candidates = await this.evidenceRepository.listCandidateEvidence({
      agentId: input.agent.id,
    });

    const allowedRefs: ContextEvidenceRef[] = [];
    const authorizedEvidence: Evidence[] = [];
    const deniedDecisions: AuthorizationDecision[] = [];
    const now = new Date().toISOString();

    // 4. Authorize each candidate, in order.
    for (const evidence of candidates) {
      const decision = await this.evaluator.authorize({
        agentId: input.agent.id,
        principalId: input.onBehalfOfPrincipalId,
        evidence,
        action: "consume",
        runId: input.run.id,
        capsuleId,
      });

      if (decision.result === "DENY") {
        deniedDecisions.push(decision);
        continue;
      }

      const pointer = await this.evidenceRepository.getSourcePointer(evidence.sourcePointerId);
      if (pointer === null) {
        // The evaluator already committed to ALLOW; a missing pointer for allowed evidence is a
        // bug, not a denial, so this throws rather than silently dropping the ref.
        throw new Error(
          `Allowed evidence ${evidence.evidenceId} has no source pointer ${evidence.sourcePointerId}`,
        );
      }

      const citation =
        evidence.citationId !== null
          ? await this.evidenceRepository.getCitation(evidence.citationId)
          : null;

      const ref: ContextEvidenceRef = {
        evidenceId: evidence.evidenceId,
        evidenceVersion: evidence.version,
        authorizationDecisionId: decision.decisionId,
        sourcePointerId: evidence.sourcePointerId,
        sourceHash: pointer.contentHash,
        citationId: evidence.citationId,
        citationVerification: citation?.verification ?? null,
        classification: evidence.classification,
        validFrom: evidence.validFrom,
        validTo: evidence.validTo,
        recordedAt: now,
      };

      allowedRefs.push(ref);
      authorizedEvidence.push(evidence);
    }

    // 5. Per-evidence DENYs — including ALL candidates denied — still yield kind "ok" (spec 003
    // §A1 amended semantics: candidate-count never selects the union member). An empty capsule
    // is a valid capsule.

    // 5.5. Conflict detection (P3-C1, INV-22) over the AUTHORIZED set only — a conflict among
    // evidence the agent cannot see anyway (DENY) must not block it; only ALLOWed evidence can
    // reach the rendered prompt, so only ALLOWed evidence can conflict in a way that matters.
    const conflicts = detectConflicts(authorizedEvidence);
    if (conflicts.length > 0) {
      const firstConflict = conflicts[0];
      if (firstConflict === undefined) {
        throw new Error("unreachable: conflicts.length > 0 but conflicts[0] is undefined");
      }

      const request: ClarificationRequest = {
        requestId: `clar_${randomUUID()}`,
        runId: input.run.id,
        agentId: input.agent.id,
        kind: "evidence_conflict",
        question: `Conflicting evidence for ${firstConflict.subjectKey} ${firstConflict.predicate}: which should be used?`,
        options: firstConflict.conflicting.map((evidence) => ({
          id: evidence.evidenceId,
          label: evidence.claim.slice(0, 120),
          evidenceIds: [evidence.evidenceId],
        })),
        allowNoneOfAbove: true,
        defaultOnTimeout: "REFUSE",
        createdAt: now,
        resolvedAt: null,
      };

      await this.clarifications.save(request);

      // No capsule is created or persisted on this path, and no capsuleId is ever written to a
      // capsule file. Note this is honest, not a gap: every per-evidence AuthorizationDecision
      // above (step 4) was already persisted carrying the capsuleId minted in step 2 — those
      // rows record what evidence was evaluated against which minted capsule id, not that a
      // capsule was ever assembled or written to disk. The capsule simply never came to exist.
      //
      // v1 has no resolution flow wired to the broker (ClarificationStoreImpl.resolve() exists
      // for Phase-3 UI/API use, called from a future route). The broker does not remember that a
      // clarification was raised: the SAME candidates will re-trigger the SAME conflict on the
      // very next build() call for a new Run. That is correct v1 behaviour, not a bug — the only
      // way to actually resolve a conflict is to supersede one of the conflicting evidence
      // records (an append-only correction, spec 003 §B2). After a supersede, the two
      // claimHashes still differ, but the superseded record's status is no longer ACTIVE, so
      // detectConflicts() no longer groups it and the conflict is gone.
      return { kind: "clarification_required", request };
    }

    const governanceHead = await this.getGovernanceHead();

    // 6. Build the capsule; capsuleHash is the canonical hash over everything EXCEPT itself.
    const capsuleWithoutHash: Omit<ContextCapsule, "capsuleHash"> = {
      schemaVersion: 1,
      capsuleId,
      runId: input.run.id,
      agentId: input.agent.id,
      agentVersionId: input.agentVersionId,
      agentPrincipalId: `agent:${input.agent.id}`,
      onBehalfOfPrincipalId: input.onBehalfOfPrincipalId,
      policyRevision: this.policy.revision,
      policyHash: policyHash(this.policy),
      evidence: allowedRefs,
      deniedEvidenceDecisionIds: deniedDecisions.map((decision) => decision.decisionId),
      createdAt: now,
      transactionCut: `ledger:${governanceHead}`,
    };

    const capsuleHash = `sha256:${createHash("sha256")
      .update(canonicalJson(capsuleWithoutHash), "utf8")
      .digest("hex")}`;

    // 7. Freeze the capsule, its evidence array, and each ref (INV-7) before persisting.
    for (const ref of allowedRefs) {
      Object.freeze(ref);
    }
    Object.freeze(allowedRefs);
    const capsule: ContextCapsule = Object.freeze({ ...capsuleWithoutHash, capsuleHash });

    await this.capsuleStore.save(capsule);

    return { kind: "ok", capsule, deniedDecisions };
  }

  async renderPrompt(userPrompt: string, capsule: ContextCapsule): Promise<string> {
    const resolved: ResolvedCapsuleRef[] = [];

    for (const ref of capsule.evidence) {
      const evidence = await this.evidenceRepository.getEvidence(
        ref.evidenceId,
        ref.evidenceVersion,
      );
      if (evidence === null) {
        throw new Error(
          `Capsule ${capsule.capsuleId} references missing evidence ${ref.evidenceId}`,
        );
      }

      const pointer = await this.evidenceRepository.getSourcePointer(ref.sourcePointerId);
      if (pointer === null) {
        throw new Error(
          `Capsule ${capsule.capsuleId} references missing source pointer ${ref.sourcePointerId}`,
        );
      }

      resolved.push({ ref, evidence, pointer });
    }

    const block = renderCapsuleBlock(capsule, resolved);
    return `${block}\n\n${userPrompt}`;
  }
}
