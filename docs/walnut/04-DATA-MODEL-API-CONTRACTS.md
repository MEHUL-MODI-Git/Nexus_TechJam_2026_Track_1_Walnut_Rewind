# Walnut Rewind — Data Model and API Contracts

# 1. Classification

```ts
type Classification =
  | "PUBLIC"
  | "INTERNAL"
  | "CONFIDENTIAL"
  | "RESTRICTED";
```

Ordering:

```text
PUBLIC < INTERNAL < CONFIDENTIAL < RESTRICTED
```

Derived evidence classification must never be weaker than the most restrictive contributor.

---

# 2. AgentVersion

```ts
interface AgentVersion {
  versionId: string;
  agentId: string;
  version: number;

  name: string;
  description: string;
  workspaceInstructions: string;

  configHash: string;

  validFrom: string;
  validTo: string | null;

  recordedAt: string;
  txClosedAt: string | null;

  supersedesVersionId: string | null;
}
```

A Run pins one `versionId`.

---

# 3. AgentGrant

```ts
type GrantAction =
  | "read"
  | "consume"
  | "share"
  | "write"
  | "external_write";

interface AgentGrant {
  grantId: string;
  agentId: string;
  principalId: string | null;

  resourcePattern: string;
  action: GrantAction;

  validFrom: string;
  validTo: string | null;

  recordedAt: string;
  txClosedAt: string | null;

  issuedBy: string;
  supersedesGrantId: string | null;
}
```

---

# 4. AuthorizationDecision

```ts
type AuthResult = "ALLOW" | "DENY";

interface AuthorizationDecision {
  decisionId: string;

  runId: string | null;
  capsuleId: string | null;

  agentId: string;
  principalId: string | null;

  evidenceId: string;
  evidenceVersion: number;

  action: "consume" | "share";

  resource: string;
  requiredScopes: string[];

  matchedAgentGrantIds: string[];
  matchedPrincipalGrantIds: string[];

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
```

---

# 5. SourcePointer

```ts
type SourcePointerKind =
  | "workspace_file"
  | "workspace_lines"
  | "runtime_event"
  | "command_result"
  | "mock_resource";

interface SourcePointer {
  pointerId: string;
  sourceId: string;

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
```

---

# 6. Citation

```ts
type CitationVerification =
  | "VERIFIED"
  | "MISMATCH"
  | "DRIFTED"
  | "UNAVAILABLE";

interface Citation {
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
```

---

# 7. Evidence

```ts
type EvidenceStatus =
  | "ACTIVE"
  | "SUPERSEDED"
  | "REVOKED"
  | "COMPROMISED";

interface Evidence {
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
```

---

# 8. ContextCapsule

```ts
interface ContextEvidenceRef {
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

interface ContextCapsule {
  schemaVersion: 1;

  capsuleId: string;
  runId: string;

  agentId: string;
  agentVersionId: string;

  agentPrincipalId: string;
  onBehalfOfPrincipalId: string | null;

  policyRevision: number;
  policyHash: string;

  evidence: ContextEvidenceRef[];

  deniedEvidenceDecisionIds: string[];

  createdAt: string;
  transactionCut: string;

  capsuleHash: string;
}
```

Capsule hash is canonical hash over capsule content excluding the hash field itself.

---

# 9. RuntimeEvent

```ts
type RuntimeEventKind =
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

interface RuntimeEventRecord {
  runtimeEventId: string;
  runId: string;
  agentId: string;

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
```

---

# 10. RedactionReceipt

```ts
interface RedactionReceipt {
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
```

---

# 11. LedgerEvent

```ts
interface LedgerEvent {
  schemaVersion: 1;

  eventId: string;
  sequence: number;

  runId: string | null;
  agentId: string | null;
  capsuleId: string | null;

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

  supersedesEventId: string | null;

  previousHash: string;
  eventHash: string;
}
```

---

# 12. Artifact

```ts
interface ArtifactRecord {
  artifactId: string;
  runId: string;
  agentId: string;

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

  derivedFromEvidenceIds: string[];
}
```

---

# 13. Dependency graph

```ts
type GraphNodeType =
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

interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  status: string | null;
  metadata: Record<string, unknown>;
}

type GraphEdgeType =
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

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: GraphEdgeType;
  metadata: Record<string, unknown>;
}
```

---

# 14. WalnutRunState

```ts
type WalnutRunState =
  | "CLEAN"
  | "STALE"
  | "TAINTED"
  | "RECOVERED";
```

Store separately from Starter Kit Run status.

---

# 15. BlastRadius

```ts
interface BlastRadius {
  trigger: {
    kind: "evidence" | "source" | "authorization_grant";
    id: string;
  };

  evidenceIds: string[];
  capsuleIds: string[];
  runIds: string[];
  agentIds: string[];
  artifactIds: string[];
  derivedEvidenceIds: string[];

  computedAt: string;
}
```

---

# 16. ReconciliationRecord

```ts
interface ReconciliationRecord {
  reconciliationId: string;

  triggerEvidenceIds: string[];

  staleRunId: string;
  replacementRunId: string;

  oldCapsuleId: string;
  newCapsuleId: string;

  createdAt: string;

  result:
    | "STARTED"
    | "COMPLETED"
    | "FAILED";
}
```

---

# 17. ClarificationRequest

```ts
interface ClarificationRequest {
  requestId: string;

  runId: string;
  agentId: string;

  kind:
    | "evidence_conflict"
    | "temporal_frame"
    | "scope"
    | "permission";

  question: string;

  options: Array<{
    id: string;
    label: string;
    evidenceIds: string[];
  }>;

  allowNoneOfAbove: true;

  defaultOnTimeout: "REFUSE";

  createdAt: string;
  resolvedAt: string | null;
}
```

---

# 18. RunAttestation

```ts
interface RunAttestation {
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
```

---

# 19. Main APIs

## Run overview

```text
GET /api/runs/:id/walnut
```

Returns:
- capsule summary
- WalnutRunState
- attestation summary
- authorization summary
- evidence summary
- dependency summary
- recovery summary

## Capsule

```text
GET /api/runs/:id/capsule
```

## Evidence timeline

```text
GET /api/runs/:id/evidence?knownAt=<ISO>
```

## Verify

```text
GET /api/runs/:id/evidence/verify
```

## Attestation

```text
GET /api/runs/:id/attestation
```

## Dependencies

```text
GET /api/runs/:id/dependencies
```

## History

```text
GET /api/runs/:id/history?knownAt=<ISO>
```

## Evidence detail

```text
GET /api/evidence/:id
```

## Revoke

```text
POST /api/evidence/:id/revoke
{
  "reason": "..."
}
```

## Compromise

```text
POST /api/evidence/:id/compromise
{
  "reason": "source integrity incident"
}
```

## Supersede

```text
POST /api/evidence/:id/supersede
{
  "replacementEvidenceId": "..."
}
```

## Blast radius

```text
GET /api/evidence/:id/blast-radius
```

## Reconcile Run

```text
POST /api/runs/:id/reconcile
```

## Grants

```text
GET /api/agents/:id/grants

POST /api/agents/:id/grants
{
  "resourcePattern": "project:launch",
  "action": "consume",
  "validTo": null
}
```

## Revoke grant

```text
POST /api/agents/:id/grants/:grantId/revoke
```

## Share Evidence

```text
POST /api/evidence/:id/share/:targetAgentId
```

Response:
- ALLOW / DENY
- decision ID
- reason code

## Export

```text
GET /api/runs/:id/evidence/export
```

---

# 20. Example Context Capsule

```json
{
  "schemaVersion": 1,
  "capsuleId": "cap_24",
  "runId": "run_91",
  "agentId": "strategy-agent",
  "agentVersionId": "av_2",
  "agentPrincipalId": "agent:strategy-agent",
  "onBehalfOfPrincipalId": "user:alice",
  "policyRevision": 8,
  "policyHash": "sha256:policy...",
  "evidence": [
    {
      "evidenceId": "ev_17",
      "evidenceVersion": 1,
      "authorizationDecisionId": "auth_31",
      "sourcePointerId": "ptr_4",
      "sourceHash": "sha256:source...",
      "citationId": "cit_9",
      "citationVerification": "VERIFIED",
      "classification": "INTERNAL",
      "validFrom": "2026-09-14T00:00:00Z",
      "validTo": null,
      "recordedAt": "2026-08-27T02:31:00Z"
    }
  ],
  "deniedEvidenceDecisionIds": [
    "auth_32"
  ],
  "createdAt": "2026-08-27T02:32:00Z",
  "transactionCut": "ledger:438",
  "capsuleHash": "sha256:capsule..."
}
```

---

# 21. Example denied transfer

```json
{
  "decisionId": "auth_32",
  "agentId": "strategy-agent",
  "principalId": "user:alice",
  "evidenceId": "ev_salary_5",
  "evidenceVersion": 1,
  "action": "consume",
  "resource": "payroll",
  "requiredScopes": ["payroll:read"],
  "matchedAgentGrantIds": [],
  "matchedPrincipalGrantIds": ["human_payroll_1"],
  "policyRevision": 8,
  "policyHash": "sha256:policy...",
  "result": "DENY",
  "reasonCode": "AGENT_SCOPE_MISSING",
  "recordedAt": "2026-08-27T02:32:00Z"
}
```

Note the human may be authorized while the Agent is not. Effective authority remains narrowed.

---

# 22. Example supersession

Old:

```text
E17
Claim: Launch date = Sep 14
status: ACTIVE
```

Correction arrives:

```text
E31
Claim: Launch date = Oct 7
supersedes: E17
```

After commit:

```text
E17 status = SUPERSEDED
E31 status = ACTIVE
```

The historical Run that used E17 is preserved and may become `STALE`.

---

# 23. Example graph

```text
Alice
  └─ ACTS_ON_BEHALF_OF ← Strategy Agent
                            │
                            └─ EXECUTED → Run91
                                           │
                                           ├─ USED_CAPSULE → Cap24
                                           │                    │
                                           │                    └─ CONTAINS_EVIDENCE → E17
                                           │                                                │
                                           │                                                ├─ CITES → launch-plan.txt
                                           │                                                └─ AUTHORIZED_BY → Auth31
                                           │
                                           └─ CHANGED_ARTIFACT → launch-strategy.md
```

If E17 becomes compromised:
- mark E17
- traverse Cap24
- mark Run91 TAINTED
- mark artifact stale
- reconcile
- link Run91 `RECOVERED_BY` Run108
