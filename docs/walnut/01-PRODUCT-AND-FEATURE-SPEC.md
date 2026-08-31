# Walnut Rewind — Product and Feature Specification

## 1. Product definition

Walnut Rewind is middleware inserted between the Agent control plane and Agent Runtime.

Its purpose is to govern and record **what evidence an Agent is allowed to know**, make downstream information dependencies explicit, and enable deterministic impact analysis and selective recovery when upstream knowledge becomes invalid.

The middleware should improve the existing Agent platform without replacing:
- Agent CRUD
- Agent lifecycle
- Playground
- persistent workspaces
- Codex CLI Runtime
- BytePlus ModelArk integration
- local container execution

---

# 2. Main user-facing promise

For any Agent Run, an operator should be able to answer:

1. **What was this Agent allowed to know?**
2. **Why was it allowed to know it?**
3. **Where did each important piece of information come from?**
4. **Which version did the Agent see?**
5. **What Runtime actions did the Agent perform?**
6. **Which outputs or downstream Runs depended on that information?**
7. **If that information later becomes wrong or unauthorized, what is affected?**
8. **Can the system recover without rewriting history?**

---

# 3. Canonical entities

## Principal
A human/user identity used for delegated authority.

Hackathon implementation may use mock principals.

## Agent
Existing Starter Kit Agent.

## AgentVersion
An immutable version of an Agent's configuration/instructions/policy-relevant state.

## Run
Existing Starter Kit asynchronous Run.

## ContextCapsule
Immutable knowledge and authorization snapshot for exactly one Run.

## Evidence
Reusable typed claim or fact that can enter an Agent's Context Capsule.

## Source
Underlying workspace file, Runtime event, local mock resource, or other approved source.

## AuthorizationDecision
Append-only decision explaining why Evidence was or was not permitted for a target Agent.

## RuntimeEvent
Normalized safe representation of a Codex JSONL event.

## Artifact
Workspace file or other output produced or changed by a Run.

## LedgerEvent
Append-only hash-chained record.

## ClarificationRequest
Typed request emitted when context ambiguity cannot be deterministically resolved.

## Reconciliation
Record linking stale/tainted Run(s) to new clean Run(s).

---

# 4. Context Capsule

## 4.1 Purpose

The Context Capsule is the central primitive.

It freezes the exact evidence/policy basis for a Run.

A completed capsule is immutable.

## 4.2 Required fields

At minimum:

```ts
interface ContextCapsule {
  schemaVersion: 1;
  capsuleId: string;
  runId: string;
  agentId: string;
  agentVersionId: string;

  principal: {
    agentPrincipalId: string;
    onBehalfOfPrincipalId: string | null;
  };

  policy: {
    revision: number;
    policyHash: string;
  };

  evidence: ContextEvidenceRef[];

  createdAt: string;
  transactionCut: number | string;
  capsuleHash: string;
}
```

Each `ContextEvidenceRef` should include:

```ts
interface ContextEvidenceRef {
  evidenceId: string;
  evidenceVersion: number;
  authorizationDecisionId: string;
  sourcePointerId: string;
  sourceHash: string;
  citationVerificationId: string | null;
  classification: Classification;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
}
```

## 4.3 Invariant

> A Run may only execute with a finalized Context Capsule.

---

# 5. Agent authorization

## 5.1 Rule

Unauthorized evidence must be removed **before prompt/context construction**.

This is not prompt-level safety.

## 5.2 Effective authority

Conceptually:

```text
effective access =
    agent grants
    ∩ delegating-human grants
    ∩ evidence/source requirements
    ∩ current policy
```

No component may widen authority.

## 5.3 Suggested simple data model

```ts
interface AgentGrant {
  grantId: string;
  agentId: string;
  action: "read" | "share" | "write" | "external_write";
  resourcePattern: string;
  validFrom: string;
  validTo: string | null;
  issuedBy: string;
  recordedAt: string;
  supersedesGrantId: string | null;
}
```

Optional human/principal grants use the same shape with `principalId`.

## 5.4 AuthorizationDecision

```ts
interface AuthorizationDecision {
  decisionId: string;
  runId: string | null;
  capsuleId: string | null;
  agentId: string;
  principalId: string | null;
  evidenceId: string;
  action: "consume" | "share";
  requiredScopes: string[];
  matchedGrants: string[];
  policyRevision: number;
  result: "ALLOW" | "DENY";
  reasonCode: string;
  recordedAt: string;
}
```

Every ALLOW in a capsule should reference one decision.

Every DENY should also be recorded when useful for audit/demo.

---

# 6. Agent-to-Agent transfer

## 6.1 Rule

Agent A's ability to access Evidence does not confer access on Agent B.

## 6.2 Transfer pipeline

```text
Agent A proposes Evidence transfer
    ↓
Validate Evidence status
    ↓
Check sender may share
    ↓
Check recipient may consume
    ↓
Check evidence classification / scopes
    ↓
ALLOW → eligible for B's next capsule
DENY  → never enters B's context
```

## 6.3 Demo case

HR Agent:
- `payroll:read`
- can access salary evidence

Strategy Agent:
- no `payroll:read`

HR Agent attempts to share salary evidence.

Expected:
`DENY`

Important demo phrase:
> **"The downstream Agent never received the sensitive data."**

---

# 7. Evidence

## 7.1 Core shape

```ts
type EvidenceStatus =
  | "ACTIVE"
  | "SUPERSEDED"
  | "REVOKED"
  | "COMPROMISED";

interface Evidence {
  evidenceId: string;
  version: number;

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
}
```

## 7.2 Evidence lifecycle

- `ACTIVE`: eligible for new capsules subject to authorization
- `SUPERSEDED`: a newer version replaces it
- `REVOKED`: explicitly invalidated
- `COMPROMISED`: source integrity or trust incident

No deletion is required for ordinary correction.

---

# 8. Source pointers and mechanical citations

## 8.1 Pointer-not-copy

Evidence should point back to source material.

Do not duplicate full raw source content unless needed and safe.

## 8.2 SourcePointer

```ts
interface SourcePointer {
  pointerId: string;
  kind:
    | "workspace_file"
    | "workspace_lines"
    | "runtime_event"
    | "command_result"
    | "mock_resource";

  locator: Record<string, string | number>;

  contentHash: string;
  mediaType: string | null;

  lineStart: number | null;
  lineEnd: number | null;

  observedAt: string;
  classification: Classification;
}
```

## 8.3 Citation

```ts
interface Citation {
  citationId: string;
  pointerId: string;
  quotePreview: string;
  quoteHash: string;
  charStart: number | null;
  charEnd: number | null;
  lineStart: number | null;
  lineEnd: number | null;
  verification:
    | "VERIFIED"
    | "MISMATCH"
    | "DRIFTED"
    | "UNAVAILABLE";
  verifiedAt: string | null;
}
```

## 8.4 Mechanical verification

For text sources:
- resolve source
- verify current content hash
- compare exact anchored bytes/chars
- reject on mismatch

The model does not decide whether the citation is valid.

---

# 9. Runtime evidence / ProofGraph substrate

The Starter Kit already runs `codex exec --json`.

Capture every accepted JSONL event at a shared event sink.

Normalize into safe event types:

```ts
type RuntimeEvidenceKind =
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
```

Rules:
- preserve event ordering
- unknown event types become explicit `runtime.unknown`
- malformed lines become explicit parse-failure evidence
- never silently discard accepted Runtime events
- no raw hidden reasoning persistence

---

# 10. Redaction

Redaction happens before ledger append.

At minimum detect and remove:
- `ARK_API_KEY`
- bearer tokens
- obvious API-key patterns
- private key blocks
- `.env` assignments
- known environment values
- high-entropy planted secret canaries
- optionally sensitive file/path names

Persist a receipt:

```ts
interface RedactionReceipt {
  applied: boolean;
  categories: string[];
  replacementCount: number;
  redactorVersion: string;
}
```

---

# 11. Hash-chained evidence ledger

## 11.1 Purpose

Tamper-evident, append-only observed history.

## 11.2 Event shape

```ts
interface LedgerEvent {
  schemaVersion: 1;
  eventId: string;
  sequence: number;

  runId: string | null;
  agentId: string | null;
  capsuleId: string | null;

  kind: string;
  actor: "human" | "agent" | "runtime" | "middleware";

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

## 11.3 Canonical hashing

Use stable/canonical JSON serialization.

Conceptually:

```text
eventHash = sha256(
  previousHash +
  canonicalJson(event_without_eventHash)
)
```

## 11.4 Verification

`verify(runId)` must detect:
- modified record
- deleted record
- inserted record
- reordered record

---

# 12. Dependency graph

## 12.1 Nodes

- Principal
- Agent
- AgentVersion
- Run
- ContextCapsule
- Evidence
- Source
- AuthorizationDecision
- RuntimeEvent
- Artifact

## 12.2 Edges

- `OWNS`
- `ACTS_ON_BEHALF_OF`
- `EXECUTED`
- `USED_CAPSULE`
- `CONTAINS_EVIDENCE`
- `CONSUMED`
- `PRODUCED`
- `DERIVED_FROM`
- `CITES`
- `AUTHORIZED_BY`
- `SUPERSEDES`
- `TAINTS`
- `RECOVERED_BY`
- `CHANGED_ARTIFACT`

## 12.3 Storage

Do not require Neo4j.

Store typed node/edge records in native app persistence or derive them from ledger + evidence metadata.

The graph is a rebuildable projection.

---

# 13. Blast-radius engine

Given an Evidence ID or Source Pointer:

1. locate evidence version(s)
2. mark target invalid/compromised/superseded
3. traverse:
   - evidence → capsules
   - capsules → runs
   - runs → produced artifacts
   - runs → produced evidence
   - produced evidence → downstream capsules
4. return impact set

Suggested result:

```ts
interface BlastRadius {
  sourceIds: string[];
  evidenceIds: string[];
  capsuleIds: string[];
  runIds: string[];
  agentIds: string[];
  artifactIds: string[];
  derivedEvidenceIds: string[];
}
```

Affected Runs should become:
- `STALE`
- `TAINTED`

Do not rewrite their original history.

---

# 14. Rewind / reconciliation

Reconciliation should:

1. create a fresh evidence resolution
2. build a new Context Capsule
3. execute a new Run
4. create `RECOVERED_BY(oldRun, newRun)`
5. preserve original Run
6. optionally compare old/new outputs

No silent overwrite.

---

# 15. Bi-temporal semantics

Use two conceptual clocks.

## Valid time
When the fact/evidence was true in the world.

## Transaction/belief time
When Walnut recorded/believed it.

Minimal hackathon fields:
- `validFrom`
- `validTo`
- `recordedAt`
- `txClosedAt`

A supersession closes the belief interval of the old record and creates a new version.

Time-travel view should answer:
> "What evidence/version would have been considered active as known at time T?"

---

# 16. Authorization history

Every Context Capsule pins:
- policy revision
- policy hash
- authorization decision IDs

This allows:
> "Why was this Agent allowed to use this Evidence during this Run?"

If a historical grant is later discovered to be erroneous, calculate affected historical capsules.

This is an **authorization blast-radius** feature.

---

# 17. Clarification-first conflicts

When building a capsule:

If multiple evidence items:
- are simultaneously ACTIVE
- pass authorization
- conflict on the same subject/predicate
- and deterministic precedence cannot safely resolve them

return a `ClarificationRequest`.

```ts
interface ClarificationRequest {
  requestId: string;
  runId: string;
  agentId: string;
  kind: "evidence_conflict" | "temporal_frame" | "scope" | "permission";
  question: string;
  options: {
    label: string;
    evidenceIds: string[];
  }[];
  escapeOption: true;
  timeoutBehavior: "REFUSE";
}
```

No silent guess.

---

# 18. UI product surfaces

Integrate into current Playground.

Recommended:

## Evidence chip
On latest assistant message / Run:
`Verified · 7 events · 2 evidence · 1 artifact`

## Drawer tabs

### Overview
- capsule hash
- agent/principal
- policy revision
- chain status
- evidence count
- denied evidence count
- stale/tainted status
- redaction count
- affected/recovery status

### Timeline
- run
- turn
- commands
- file changes
- errors
- final response
- verifier assertions

### Dependencies
- source/evidence/capsule/run/artifact graph
- affected nodes red when invalidated

### History
- evidence versions
- supersession
- known-at time
- authorization decision revision
- recovery lineage

## Actions
- verify chain
- mark evidence revoked/compromised
- reconcile
- inspect context capsule
- export evidence pack if implemented

---

# 19. Final product identity

Recommended product name:
**Walnut Rewind**

Recommended subtitle:
**Proof-Carrying, Authorization-Aware, Reversible Context Middleware for AI Agents**

Recommended pitch:
> "Observability tells you what an Agent did. Walnut Rewind tells you what it was allowed to know, why it believed it, who inherited that belief, and what must be rebuilt when the belief becomes wrong."
