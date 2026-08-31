// Transcription of frozen spec 001 (specs/001-walnut-core-types.md, FROZEN 2026-08-27).
// Source of truth for shapes: docs/walnut/04-DATA-MODEL-API-CONTRACTS.md §§1-18 (verbatim).
// Shared cross-module contract — change with care; every module depends on these shapes.
// Type-only leaf module: imports nothing. Upstream types (AgentRun, Agent, ...) are consumed
// directly from ../types.js by callers, never re-exported here.

// -- ID aliases (plain string, not branded — pinned overlay §4) --

export type AgentId = string;
export type RunId = string;
export type PrincipalId = string;
export type AgentVersionId = string;
export type GrantId = string;
export type AuthorizationDecisionId = string;
export type SourcePointerId = string;
export type SourceId = string;
export type CitationId = string;
export type EvidenceId = string;
export type CapsuleId = string;
export type RuntimeEventId = string;
export type LedgerEventId = string;
export type ArtifactId = string;
export type ReconciliationId = string;
export type ClarificationRequestId = string;

// -- 1. Classification --

export type Classification =
  | "PUBLIC"
  | "INTERNAL"
  | "CONFIDENTIAL"
  | "RESTRICTED";

// PUBLIC < INTERNAL < CONFIDENTIAL < RESTRICTED. Derived evidence classification must never be
// weaker than the most restrictive contributor (INV-6 monotonicity compares through this table).
export const CLASSIFICATION_ORDER: Record<Classification, number> = {
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
};

// -- 2. AgentVersion --

// A Run pins one versionId.
export interface AgentVersion {
  versionId: AgentVersionId;
  agentId: AgentId;
  version: number;

  name: string;
  description: string;
  workspaceInstructions: string;

  configHash: string;

  validFrom: string;
  validTo: string | null;

  recordedAt: string;
  txClosedAt: string | null;

  supersedesVersionId: AgentVersionId | null;
}

// -- 3. AgentGrant --

export type GrantAction =
  | "read"
  | "consume"
  | "share"
  | "write"
  | "external_write";

export interface AgentGrant {
  grantId: GrantId;
  agentId: AgentId;
  principalId: PrincipalId | null;

  resourcePattern: string;
  action: GrantAction;

  validFrom: string;
  validTo: string | null;

  recordedAt: string;
  txClosedAt: string | null;

  issuedBy: string;
  supersedesGrantId: GrantId | null;
}

// -- 4. AuthorizationDecision --

export type AuthResult = "ALLOW" | "DENY";

// Immutable once recorded — corrections are new decisions.
export interface AuthorizationDecision {
  decisionId: AuthorizationDecisionId;

  runId: RunId | null;
  capsuleId: CapsuleId | null;

  agentId: AgentId;
  principalId: PrincipalId | null;

  evidenceId: EvidenceId;
  evidenceVersion: number;

  action: "consume" | "share";

  resource: string;
  requiredScopes: string[];

  matchedAgentGrantIds: GrantId[];
  matchedPrincipalGrantIds: GrantId[];

  policyRevision: number;
  policyHash: string;

  result: AuthResult;
  reasonCode:
    | "AUTHORIZED"
    | "AGENT_SCOPE_MISSING"
    | "PRINCIPAL_SCOPE_MISSING"
    | "EVIDENCE_REVOKED"
    | "EVIDENCE_COMPROMISED"
    | "EVIDENCE_SUPERSEDED"
    | "CLASSIFICATION_DENIED"
    | "GRANT_EXPIRED"
    | "POLICY_DENIED";

  recordedAt: string;
}

// -- 5. SourcePointer --

export type SourcePointerKind =
  | "workspace_file"
  | "workspace_lines"
  | "runtime_event"
  | "command_result"
  | "mock_resource";

export interface SourcePointer {
  pointerId: SourcePointerId;
  sourceId: SourceId;

  kind: SourcePointerKind;

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

// -- 6. Citation --

export type CitationVerification =
  | "VERIFIED"
  | "MISMATCH"
  | "DRIFTED"
  | "UNAVAILABLE";

export interface Citation {
  citationId: CitationId;
  pointerId: SourcePointerId;

  quotePreview: string;
  quoteHash: string;

  charStart: number | null;
  charEnd: number | null;
  lineStart: number | null;
  lineEnd: number | null;

  verification: CitationVerification;
  verifiedAt: string | null;
}

// -- 7. Evidence --

export type EvidenceStatus =
  | "ACTIVE"
  | "SUPERSEDED"
  | "REVOKED"
  | "COMPROMISED";

// claimHash = sha256: over the UTF-8 bytes of claim exactly (no canonicalization).
export interface Evidence {
  evidenceId: EvidenceId;
  version: number;

  subjectKey: string | null;
  predicate: string | null;

  claim: string;

  producerAgentId: AgentId;
  producerRunId: RunId;

  sourcePointerId: SourcePointerId;
  citationId: CitationId | null;

  classification: Classification;
  requiredScopes: string[];

  status: EvidenceStatus;

  validFrom: string | null;
  validTo: string | null;

  recordedAt: string;
  txClosedAt: string | null;

  supersedesEvidenceId: EvidenceId | null;

  derivedFromEvidenceIds: EvidenceId[];

  claimHash: string;
}

// -- 8. ContextCapsule --

export interface ContextEvidenceRef {
  evidenceId: EvidenceId;
  evidenceVersion: number;

  authorizationDecisionId: AuthorizationDecisionId;

  sourcePointerId: SourcePointerId;
  sourceHash: string;

  citationId: CitationId | null;
  citationVerification: CitationVerification | null;

  classification: Classification;

  validFrom: string | null;
  validTo: string | null;

  recordedAt: string;
}

// Capsule hash is canonical hash over capsule content excluding the hash field itself.
// Immutable after finalization (INV-7).
export interface ContextCapsule {
  schemaVersion: 1;

  capsuleId: CapsuleId;
  runId: RunId;

  agentId: AgentId;
  agentVersionId: AgentVersionId;

  agentPrincipalId: PrincipalId;
  onBehalfOfPrincipalId: PrincipalId | null;

  policyRevision: number;
  policyHash: string;

  evidence: ContextEvidenceRef[];

  deniedEvidenceDecisionIds: AuthorizationDecisionId[];

  createdAt: string;
  transactionCut: string;

  capsuleHash: string;
}

// -- 9. RuntimeEvent --

export type RuntimeEventKind =
  | "runtime.thread"
  | "runtime.turn"
  | "runtime.command"
  | "runtime.file_change"
  | "runtime.mcp"
  | "runtime.web_search"
  | "runtime.plan"
  | "runtime.message"
  | "runtime.reasoning_metadata"
  | "runtime.error"
  | "runtime.unknown";

export interface RuntimeEventRecord {
  runtimeEventId: RuntimeEventId;
  runId: RunId;
  agentId: AgentId;

  provider: "local-process" | "container";

  kind: RuntimeEventKind;
  runtimeType: string | null;
  runtimeItemId: string | null;

  status:
    | "started"
    | "completed"
    | "failed"
    | "observed";

  occurredAt: string;
  recordedAt: string;

  safeSummary: string | null;

  payloadHash: string;

  metadata: Record<string, string | number | boolean | null>;

  redactionReceipt: RedactionReceipt;
}

// -- 10. RedactionReceipt --

export interface RedactionReceipt {
  applied: boolean;

  categories: Array<
    | "credential"
    | "bearer_token"
    | "private_key"
    | "env_value"
    | "high_entropy"
    | "secret_filename"
  >;

  replacementCount: number;

  redactorVersion: string;
}

// -- 11. LedgerEvent --

export interface LedgerEvent {
  schemaVersion: 1;

  eventId: LedgerEventId;
  sequence: number;

  runId: RunId | null;
  agentId: AgentId | null;
  capsuleId: CapsuleId | null;

  kind: string;

  actor:
    | "human"
    | "agent"
    | "runtime"
    | "middleware";

  occurredAt: string;
  recordedAt: string;

  safePayload: unknown;

  payloadHash: string;

  redactionReceipt: RedactionReceipt;

  supersedesEventId: LedgerEventId | null;

  previousHash: string;
  eventHash: string;
}

// -- 12. Artifact --

export interface ArtifactRecord {
  artifactId: ArtifactId;
  runId: RunId;
  agentId: AgentId;

  relativePath: string;

  state:
    | "CREATED"
    | "MODIFIED"
    | "DELETED"
    | "UNCHANGED";

  contentHashBefore: string | null;
  contentHashAfter: string | null;

  classification: Classification;

  recordedAt: string;

  derivedFromEvidenceIds: EvidenceId[];
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

// -- 14. WalnutRunState --

// Store separately from Starter Kit Run status.
export type WalnutRunState =
  | "CLEAN"
  | "STALE"
  | "TAINTED"
  | "RECOVERED";

// -- 15. BlastRadius --

export interface BlastRadius {
  trigger: {
    kind: "evidence" | "source" | "authorization_grant";
    id: string;
  };

  evidenceIds: EvidenceId[];
  capsuleIds: CapsuleId[];
  runIds: RunId[];
  agentIds: AgentId[];
  artifactIds: ArtifactId[];
  derivedEvidenceIds: EvidenceId[];

  computedAt: string;
}

// -- 16. ReconciliationRecord --

export interface ReconciliationRecord {
  reconciliationId: ReconciliationId;

  triggerEvidenceIds: EvidenceId[];

  staleRunId: RunId;
  replacementRunId: RunId;

  oldCapsuleId: CapsuleId;
  newCapsuleId: CapsuleId;

  createdAt: string;

  result:
    | "STARTED"
    | "COMPLETED"
    | "FAILED";
}

// -- 17. ClarificationRequest --

// allowNoneOfAbove / defaultOnTimeout are literal types — refusal-by-default is the contract,
// not a config.
export interface ClarificationRequest {
  requestId: ClarificationRequestId;

  runId: RunId;
  agentId: AgentId;

  kind:
    | "evidence_conflict"
    | "temporal_frame"
    | "scope"
    | "permission";

  question: string;

  options: Array<{
    id: string;
    label: string;
    evidenceIds: EvidenceId[];
  }>;

  allowNoneOfAbove: true;

  defaultOnTimeout: "REFUSE";

  createdAt: string;
  resolvedAt: string | null;
}

// -- 18. RunAttestation --

export interface RunAttestation {
  runId: RunId;

  capsuleId: CapsuleId;
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
