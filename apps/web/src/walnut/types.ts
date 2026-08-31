// hand-mirrored from the frozen server contract (spec 001) — update only when the spec version
// bumps. Source: apps/server/src/walnut/types.ts (shape definitions) and
// apps/server/src/walnut/routes/walnut-routes.ts (the five response shapes the Phase-2 UI
// consumes). This module imports nothing from the server — it is a plain, type-only leaf.

// -- 1. Classification --

export type Classification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

// -- 7. Evidence status --

export type EvidenceStatus = "ACTIVE" | "SUPERSEDED" | "REVOKED" | "COMPROMISED";

// -- 6. Citation verification --

export type CitationVerification = "VERIFIED" | "MISMATCH" | "DRIFTED" | "UNAVAILABLE";

export interface Evidence {
  evidenceId: string;
  version: number;

  subjectKey: string | null;
  predicate: string | null;

  claim: string;

  producerAgentId: string;
  producerRunId: string;

  sourcePointerId: string;
  citationId: string | null;

  classification: Classification;
  requiredScopes: string[];

  status: EvidenceStatus;

  validFrom: string | null;
  validTo: string | null;

  recordedAt: string;
  txClosedAt: string | null;

  supersedesEvidenceId: string | null;

  derivedFromEvidenceIds: string[];

  claimHash: string;
}

export interface ContextEvidenceRef {
  evidenceId: string;
  evidenceVersion: number;

  authorizationDecisionId: string;

  sourcePointerId: string;
  sourceHash: string;

  citationId: string | null;
  citationVerification: CitationVerification | null;

  classification: Classification;

  validFrom: string | null;
  validTo: string | null;

  recordedAt: string;
}

export interface Citation {
  citationId: string;
  pointerId: string;

  quotePreview: string;
  quoteHash: string;

  charStart: number | null;
  charEnd: number | null;
  lineStart: number | null;
  lineEnd: number | null;

  verification: CitationVerification;
  verifiedAt: string | null;
}

export interface SourcePointer {
  pointerId: string;
  sourceId: string;

  kind: string;

  locator: Record<string, string | number>;

  contentHash: string;

  mediaType: string | null;

  charStart: number | null;
  charEnd: number | null;

  lineStart: number | null;
  lineEnd: number | null;

  observedAt: string;

  classification: Classification;
}

// -- 13. Dependency graph --

export type GraphNodeType =
  | "principal"
  | "agent"
  | "agent_version"
  | "run"
  | "context_capsule"
  | "evidence"
  | "source"
  | "authorization_decision"
  | "runtime_event"
  | "artifact";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  status: string | null;
  metadata: Record<string, unknown>;
}

export type GraphEdgeType =
  | "OWNS"
  | "ACTS_ON_BEHALF_OF"
  | "EXECUTED"
  | "USED_CAPSULE"
  | "CONTAINS_EVIDENCE"
  | "CONSUMED"
  | "PRODUCED"
  | "DERIVED_FROM"
  | "CITES"
  | "AUTHORIZED_BY"
  | "SUPERSEDES"
  | "TAINTS"
  | "RECOVERED_BY"
  | "CHANGED_ARTIFACT";

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: GraphEdgeType;
  metadata: Record<string, unknown>;
}

// Ledger hash-chain verification result (evidence/ledger.ts ChainVerification).
export interface ChainVerification {
  ok: boolean;
  eventCount: number;
  brokenAtSequence?: number;
  reason?: "hash_mismatch" | "prev_hash_mismatch" | "sequence_gap" | "parse_failure";
}

// -- Response shapes, one per endpoint the Phase-2 drawer calls --

// GET /api/runs/:id/walnut
export interface RunWalnutOverview {
  run: { id: string; status: string };
  capsule: {
    capsuleId: string;
    capsuleHash: string;
    policyRevision: number;
    evidenceCount: number;
    deniedCount: number;
    transactionCut: string;
  } | null;
  chain: ChainVerification;
  decisions: { allowed: number; denied: number };
  walnutRunState: WalnutRunState;
  attestation: RunAttestation | null;
  evidenceSummary: { consumed: number; denied: number; produced: number };
  dependencySummary: { directEdges: number; upstream: number; downstream: number };
  recoverySummary: { count: number; latest: ReconciliationRecord | null };
  note: string;
}

// GET /api/runs/:id/evidence
export interface RunEvidenceResponse {
  consumed: Array<{ ref: ContextEvidenceRef; evidence: Evidence }>;
  produced: Evidence[];
  deniedDecisionIds: string[];
  deniedDecisions: Array<{
    decision: {
      decisionId: string;
      evidenceId: string;
      evidenceVersion: number;
      requiredScopes: string[];
      policyRevision: number;
      result: "DENY";
      reasonCode:
        | "AGENT_SCOPE_MISSING"
        | "PRINCIPAL_SCOPE_MISSING"
        | "EVIDENCE_REVOKED"
        | "EVIDENCE_COMPROMISED"
        | "EVIDENCE_SUPERSEDED"
        | "CLASSIFICATION_DENIED"
        | "GRANT_EXPIRED"
        | "POLICY_DENIED";
    };
    evidence: Evidence | null;
  }>;
  knownAt: string | null;
}

// GET /api/runs/:id/evidence/verify
export interface VerifyResponse {
  run: ChainVerification;
  governance: ChainVerification;
}

// GET /api/runs/:id/events
export interface RunEventsResponse {
  chain: ChainVerification;
  events: Array<{
    eventId: string;
    sequence: number;
    kind: string;
    actor: "user" | "agent" | "middleware" | "runtime" | "human";
    occurredAt: string;
    safePayload: unknown;
    payloadHash: string;
    eventHash: string;
    redactionApplied: boolean;
  }>;
}

// GET /api/runs/:id/dependencies
export interface DependenciesResponse {
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    skippedDanglingRefs: number;
  };
  focus: string;
}

// GET /api/evidence/:id
export interface EvidenceDetailResponse {
  current: Evidence;
  versions: Evidence[];
  citation: Citation | null;
  pointer: SourcePointer | null;
}

// -- 14. WalnutRunState --

export type WalnutRunState = "CLEAN" | "STALE" | "TAINTED" | "RECOVERED";

export interface RunStateHistoryEntry {
  state: WalnutRunState;
  reason: string;
  at: string;
  byRunId: string | null;
  triggerEvidenceId: string | null;
}

// -- 15. BlastRadius --

export interface BlastRadius {
  trigger: { kind: "evidence" | "source" | "authorization_grant"; id: string };
  evidenceIds: string[];
  capsuleIds: string[];
  runIds: string[];
  agentIds: string[];
  artifactIds: string[];
  derivedEvidenceIds: string[];
  computedAt: string;
}

// -- 16. ReconciliationRecord --

export interface ReconciliationRecord {
  reconciliationId: string;
  triggerEvidenceIds: string[];
  staleRunId: string;
  replacementRunId: string;
  oldCapsuleId: string;
  newCapsuleId: string;
  createdAt: string;
  result: "STARTED" | "COMPLETED" | "FAILED";
}

// -- 18. RunAttestation --

export interface RunAttestation {
  runId: string;
  capsuleId: string;
  capsuleHash: string;
  chainHead: string;
  chainVerified: boolean;
  eventCount: number;
  runtimeEventCount: number;
  evidenceConsumed: number;
  evidenceDenied: number;
  commandCount: number;
  failedStepCount: number;
  changedArtifacts: string[];
  redactionCount: number;
  walnutRunState: WalnutRunState;
  routeReceipt: {
    arkModel: string | null;
    codexVersion: string;
    runtimeProvider: "local-process" | "container";
    runtimeImage: string | null;
    sandboxMode: string;
  };
  generatedAt: string;
}

// GET /api/evidence/:id/blast-radius
export interface BlastRadiusResponse {
  blastRadius: BlastRadius;
}

// POST /api/evidence/:id/revoke, POST /api/evidence/:id/compromise
export interface RevokeCompromiseResponse {
  evidence: Evidence;
  blastRadius: BlastRadius;
}

// POST /api/runs/:id/reconcile
export interface ReconcileResponse {
  reconciliation: ReconciliationRecord;
}

// GET /api/runs/:id/history?knownAt=<ISO>
export interface HistoryResponse {
  knownAt: string;
  evidence: Evidence[];
  runState: WalnutRunState;
  stateHistory: RunStateHistoryEntry[];
}

// GET /api/runs/:id/attestation
export interface AttestationResponse {
  attestation: RunAttestation | null;
  note: string;
}

// GET /api/walnut/clarifications
export interface ClarificationsResponse {
  open: Array<{
    requestId: string;
    runId: string;
    agentId: string;
    kind: "evidence_conflict" | "temporal_frame" | "scope" | "permission";
    question: string;
    options: Array<{ id: string; label: string; evidenceIds: string[] }>;
    createdAt: string;
    resolvedAt: string | null;
  }>;
}
