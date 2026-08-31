// ShareServiceImpl (P2-C3, doc 03 §15 "Agent-to-Agent sharing UX", doc 04 §21 denied-transfer
// example) — an Agent (or, in the demo, an operator acting through the route) marks Evidence
// available to another Agent.
//
// INV-3 (pinned semantics): the sender's ALLOW to `share` an Evidence never implies the
// recipient's ALLOW to `consume` it. Sharing is two independent authorization decisions, not one
// decision propagated. A share attempt that transfers access still leaves the recipient subject
// to every other authorization rule (classification ceiling, deny-list, evidence status) —
// transfer only ever narrows a `SCOPE_MISSING`/`GRANT_EXPIRED` gap, it never overrides a
// substantive denial.
//
// Pipeline (spec pin, first match wins per step):
//   1. Look up the current Evidence version. Missing evidence is a caller error (throws); the
//      route layer maps that to 404.
//   2. SENDER check: evaluator.authorize({ agentId: fromAgentId, action: "share", ... }). A DENY
//      here ends the share immediately — no state change, no grants, no recipient decision.
//   3. RECIPIENT pre-check: evaluator.authorize({ agentId: toAgentId, principalId: null,
//      action: "consume", ... }).
//        - ALLOW: no grant needed; this decision is final.
//        - DENY with reasonCode AGENT_SCOPE_MISSING or GRANT_EXPIRED: the share transfers
//          access — issue one narrow `consume` grant per entry of evidence.requiredScopes (exact
//          scope string as resourcePattern, never a glob), then re-authorize the recipient with
//          the same input. That re-authorization is final and can still DENY (e.g. a
//          classification ceiling is orthogonal to scope and survives the grant — INV-3).
//        - DENY for any other reason (POLICY_DENIED, CLASSIFICATION_DENIED,
//          EVIDENCE_REVOKED/COMPROMISED/SUPERSEDED, PRINCIPAL_SCOPE_MISSING): the share is denied
//          outright; no grants are issued.
//   4. Exactly one `evidence.shared` event is appended to the governance chain (runId: null) —
//      on every outcome that reaches step 3 (sender ALLOW) and also on a sender-DENY outcome, so
//      every share attempt is audit-visible. safePayload is redacted before it is chained (HC-4).
//      If grant issuance succeeded but the re-authorization still DENYs, the issued grants stay
//      in place (append-only philosophy — they are narrow, and the deny reason is orthogonal to
//      them) and are still reported in `issuedGrantIds` so the route/UI can surface them.
//   5. `result` is "ALLOW" iff the final recipient decision is ALLOW. `reasonCode` is the final
//      recipient decision's reasonCode whenever a recipient decision exists, otherwise the
//      sender's (only possible when the sender itself DENYd).

import type { AuthorizationEvaluator, AuthorizeInput } from "../auth/evaluator.js";
import type { GrantStore } from "../auth/grant-store.js";
import type { Redactor } from "../evidence/redactor.js";
import type { EvidenceLedger } from "../evidence/ledger.js";
import type { EvidenceRepository } from "../ports.js";
import { appendRedactedEvent } from "../shared/ledger-events.js";
import type { AuthorizationDecision } from "../types.js";

export interface ShareInput {
  evidenceId: string;
  fromAgentId: string;
  toAgentId: string;
  principalId: string | null;
}

export interface ShareResult {
  result: "ALLOW" | "DENY";
  senderDecision: AuthorizationDecision;
  recipientDecision: AuthorizationDecision | null;
  issuedGrantIds: string[];
  reasonCode: AuthorizationDecision["reasonCode"];
}

export interface ShareService {
  share(input: ShareInput): Promise<ShareResult>;
}

export interface ShareServiceDeps {
  evidenceRepository: EvidenceRepository;
  evaluator: AuthorizationEvaluator;
  grantStore: GrantStore;
  ledger: EvidenceLedger;
  redactor: Redactor;
}

// Only these two sender-side-irrelevant recipient reasons mean "the recipient simply lacks a
// grant that covers this scope" — every other DENY reason is substantive and is never bridged by
// a share (spec pin, step 3).
const TRANSFERABLE_REASON_CODES: ReadonlySet<AuthorizationDecision["reasonCode"]> = new Set([
  "AGENT_SCOPE_MISSING",
  "GRANT_EXPIRED",
]);

export class ShareServiceImpl implements ShareService {
  constructor(private readonly deps: ShareServiceDeps) {}

  async share(input: ShareInput): Promise<ShareResult> {
    const evidence = await this.deps.evidenceRepository.getEvidence(input.evidenceId);
    if (evidence === null) {
      throw new Error(`Unknown evidence: ${input.evidenceId}`);
    }

    // 2. SENDER check.
    const senderDecision = await this.deps.evaluator.authorize({
      agentId: input.fromAgentId,
      principalId: input.principalId,
      evidence,
      action: "share",
      runId: null,
      capsuleId: null,
    });

    if (senderDecision.result === "DENY") {
      await this.appendShareEvent({
        evidenceId: input.evidenceId,
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
        result: "DENY",
        senderDecisionId: senderDecision.decisionId,
        recipientDecisionId: null,
        issuedGrantIds: [],
      });
      return {
        result: "DENY",
        senderDecision,
        recipientDecision: null,
        issuedGrantIds: [],
        reasonCode: senderDecision.reasonCode,
      };
    }

    // 3. RECIPIENT pre-check (and, if transferable, re-check after issuing grants).
    const recipientInput: AuthorizeInput = {
      agentId: input.toAgentId,
      principalId: null,
      evidence,
      action: "consume",
      runId: null,
      capsuleId: null,
    };

    let recipientDecision = await this.deps.evaluator.authorize(recipientInput);
    const issuedGrantIds: string[] = [];

    if (
      recipientDecision.result === "DENY" &&
      TRANSFERABLE_REASON_CODES.has(recipientDecision.reasonCode)
    ) {
      const now = new Date().toISOString();
      for (const scope of evidence.requiredScopes) {
        const grant = await this.deps.grantStore.issue({
          agentId: input.toAgentId,
          principalId: null,
          resourcePattern: scope,
          action: "consume",
          validFrom: now,
          validTo: null,
          issuedBy: `share:${input.fromAgentId}`,
          supersedesGrantId: null,
        });
        issuedGrantIds.push(grant.grantId);
      }
      // Re-authorize with the identical input — final, and can still DENY (INV-3).
      recipientDecision = await this.deps.evaluator.authorize(recipientInput);
    }

    const result: ShareResult["result"] = recipientDecision.result === "ALLOW" ? "ALLOW" : "DENY";

    await this.appendShareEvent({
      evidenceId: input.evidenceId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      result,
      senderDecisionId: senderDecision.decisionId,
      recipientDecisionId: recipientDecision.decisionId,
      issuedGrantIds,
    });

    return {
      result,
      senderDecision,
      recipientDecision,
      issuedGrantIds,
      reasonCode: recipientDecision.reasonCode,
    };
  }

  // Governance-chain event (runId: null) — same redact-then-append shape as
  // evidence-write-service.ts's appendGovernanceEvent, applied to every share outcome (HC-4).
  private async appendShareEvent(payload: {
    evidenceId: string;
    fromAgentId: string;
    toAgentId: string;
    result: "ALLOW" | "DENY";
    senderDecisionId: string;
    recipientDecisionId: string | null;
    issuedGrantIds: string[];
  }): Promise<void> {
    await appendRedactedEvent(
      { ledger: this.deps.ledger, redactor: this.deps.redactor },
      {
        runId: null,
        agentId: payload.fromAgentId,
        capsuleId: null,
        kind: "evidence.shared",
        actor: "middleware",
        occurredAt: new Date().toISOString(),
        payload,
        supersedesEventId: null,
      },
    );
  }
}
