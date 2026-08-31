# Walnut Rewind — Implementation, Tests, Demo, and Rubric Plan

# 1. Implementation objective

Build the **full integrated version** in layered form.

The eventual presentation may choose fewer headline features, but the implementation should preserve the full feature surface.

---

# 2. Build phases

## Phase 0 — Baseline

Before Walnut code:
1. clone repo
2. start local POC
3. create Agent
4. send task
5. verify Codex Run completes
6. send follow-up and confirm same session
7. stop/start Agent
8. confirm workspace persistence
9. run `npm run check`

Do not debug middleware and baseline at the same time.

---

# 3. Day 1 — Evidence substrate + Context Capsule foundation

## Build

### Runtime event ingestion
- `runId` in RunnerRequest
- RuntimeEventSink
- shared Codex JSONL consumer
- local + container integration

### Redaction
- deterministic redactor
- canary tests

### Ledger
- canonical JSON
- per-Run append queue
- NDJSON append
- hash chain
- verification

### Context types
- AgentVersion
- Grant
- Evidence
- AuthorizationDecision
- ContextCapsule

### Basic grant store + authorization evaluator
- simple deterministic resource/scope matching

### Capsule builder v1
- empty / explicit evidence set
- authorization before inclusion
- capsule hash

## Day 1 exit evidence

A real Codex Run:
- executes normally
- has a Context Capsule
- produces a hash-chained redacted Runtime ledger
- chain verifies
- baseline Playground behavior remains intact

---

# 4. Day 2 — Provenance, cross-Agent evidence, dependency graph

## Build

### Workspace source pointers
- safe path validation
- hashing
- before/after manifest

### Evidence outbox
- `.walnut/outbox.json`
- schema validation
- source/citation verification
- Evidence creation

### Citation verifier
- exact match
- mismatch rejection
- source drift

### Agent-to-Agent sharing
- share API
- recipient reauthorization
- DENY / ALLOW evidence

### Dependency projection
- nodes
- edges
- Run → Capsule → Evidence → Source
- Run → Artifact
- Run → produced Evidence
- Evidence → downstream Capsules

### UI
- Evidence chip
- drawer
- Overview
- Timeline
- initial Dependencies

## Day 2 exit evidence

Research Agent:
- produces verified Evidence

Strategy Agent:
- receives allowed Evidence
- denied payroll/private Evidence never enters capsule

UI:
- shows capsule
- shows authorization decision
- shows source/citation
- shows Runtime timeline
- shows dependency links

---

# 5. Day 3 — Rewind, temporal history, robustness

## Build

### Evidence lifecycle
- supersede
- revoke
- compromise

### Blast radius
- graph traversal

### WalnutRunState
- CLEAN / STALE / TAINTED / RECOVERED

### Reconcile
- new capsule
- new Run
- RECOVERED_BY

### History
- valid/recorded times
- known-at resolver
- evidence version view

### Authorization history
- policy revision in capsule
- historical decision inspection
- optional grant blast radius

### Tamper verification UI

### Clarification-first
If enough time after core recovery works.

### Evidence export/offline verifier
If enough time after tests.

### Polish
- README
- architecture diagram
- demo fixtures
- exact commands
- limitations
- `npm run check`

---

# 6. Automated invariants

These should be treated as high-value tests.

## INV-1 — No capsule evidence without authorization
For every ContextEvidenceRef:
`authorizationDecision.result === ALLOW`

## INV-2 — Unauthorized evidence never reaches rendered context
Given denied evidence containing a planted canary:
- canary absent from rendered prompt/context

## INV-3 — Recipient reauthorization
Sender's ALLOW does not imply recipient ALLOW.

## INV-4 — No reusable Evidence without provenance
Every Evidence has SourcePointer.
If citation is required, must be VERIFIED before ACTIVE.

## INV-5 — Exact citation verification
Mismatch is rejected regardless of model claim.

## INV-6 — Classification monotonicity
Derived classification >= max contributor classification.

## INV-7 — Completed capsules immutable
Mutation attempt fails / new capsule required.

## INV-8 — Revoked/compromised evidence excluded from new capsules
No override through UI.

## INV-9 — Supersession does not delete history
Old Evidence remains queryable.

## INV-10 — Recovery creates new Run
No old output mutation.

## INV-11 — Dependency projection rebuildable
Rebuild from source records yields same nodes/edges.

## INV-12 — Blast radius complete for seeded DAG
All reachable downstream Runs found exactly once.

## INV-13 — Runtime events safe-or-explicit-failure
Every accepted Codex JSONL record is safely recorded or represented by explicit failure.

## INV-14 — Event ordering
Same-Run ledger sequence preserves observed order.

## INV-15 — Tamper detection
Mutation/deletion/insertion/reorder detected.

## INV-16 — Redact-before-persist
Planted Ark key / bearer / private key / env canary absent from persisted payload.

## INV-17 — Unknown event compatibility
New Codex event type does not crash Run.

## INV-18 — Malformed JSONL typed failure
Raw malformed line is not persisted.

## INV-19 — Source drift visible
Hash change causes DRIFTED state.

## INV-20 — Policy revision pinned
Every capsule carries policy revision/hash.

## INV-21 — Historical auth explainability
Every allowed evidence in old capsule resolves to historical AuthDecision.

## INV-22 — Conflict does not silently pick
If conflict detector fires and no answer, capsule construction refuses/clarifies.

---

# 7. Test files

Suggested:

```text
walnut/evidence/ledger.test.ts
walnut/evidence/redactor.test.ts
walnut/evidence/codex-event-adapter.test.ts
walnut/evidence/workspace-evidence.test.ts
walnut/context/authorization.test.ts
walnut/context/citation-verifier.test.ts
walnut/context/capsule.test.ts
walnut/context/temporal-resolver.test.ts
walnut/context/conflict-detector.test.ts
walnut/dependency/projector.test.ts
walnut/dependency/blast-radius.test.ts
walnut/dependency/reconciliation.test.ts
walnut/e2e.test.ts
```

Extend existing:
- `codex-runner.test.ts`
- `container-codex-runner.test.ts`
- `agent-service.test.ts`
- `app.test.ts`
- `store.test.ts`

---

# 8. High-value end-to-end test

Fake Runtime emits:
1. command
2. file change
3. failed test
4. final message

Setup:
- capsule contains one authorized evidence
- one denied evidence with secret canary

Assertions:
- authorized evidence present
- denied evidence absent from rendered context
- Runtime events appended in order
- secret canary absent
- file change visible
- failed test assertion visible
- chain verifies
- dependencies include source/evidence/capsule/run/artifact

Then:
- mark evidence compromised
- blast radius includes Run/artifact
- Run becomes TAINTED
- reconcile
- replacement Run exists
- old Run `RECOVERED_BY` new Run

This single test demonstrates most of the thesis.

---

# 9. 3-minute demo candidate

Implementation is full. Presentation can later select the cleanest subset.

Recommended strongest version:

## 0:00–0:20 — Baseline platform
Show existing Agent UI working.

Create/select:
- Research Agent
- Strategy Agent

## 0:20–0:45 — Verified Evidence
Research Agent reads `launch-plan.txt`.

Produces:
`Launch date = September 14`

Walnut:
- exact citation verified
- source hash recorded
- Evidence ACTIVE

## 0:45–1:10 — Authorization
Strategy Agent asks to use Research finding.

Walnut:
- `project:launch:read` → ALLOW
- evidence included

Attempt payroll evidence:
- required `payroll:read`
- Strategy lacks grant
- DENY
- say: **"The downstream model never received the payroll data."**

## 1:10–1:30 — Context Capsule
Open Run Context.

Show:
- Agent version
- principal
- policy revision
- evidence version
- auth decision
- source hash
- capsule hash

Say:
> "This is the exact knowledge state this Agent executed against."

## 1:30–2:00 — Invalidation / blast radius
Correct source to:
`Launch date = October 7`

Or mark old evidence compromised.

Walnut:
- E17 superseded/compromised
- Strategy Run TAINTED
- launch artifact stale
- downstream blast radius visible

## 2:00–2:30 — Rewind
Press `RECONCILE`.

Walnut:
- creates E31 / current evidence
- creates new capsule
- creates new Run
- links `RECOVERED_BY`
- old history preserved

## 2:30–2:50 — History
Known-at before correction:
- Sep 14

Known-at after correction:
- Oct 7

## 2:50–3:00 — Close
> "Observability tells you what an Agent did. Walnut Rewind tells you what it was allowed to know, why it believed it, who inherited that belief, and what must be rebuilt when the belief becomes wrong."

Backup wow:
- verify hash chain
- corrupt event fixture
- verification fails

---

# 10. Rubric mapping

## 40% End-to-end middleware behavior

Real path:

```text
React
→ Fastify
→ AgentService
→ Context Broker
→ Authorization
→ Context Capsule
→ Codex Runner
→ JSONL Runtime evidence
→ Evidence ledger
→ Dependency graph
→ Invalidation
→ Reconcile
```

This is not static UI.

## 25% Technical design/integration

Clear boundaries:
- Context Plane
- Evidence Plane
- Authorization Plane
- Dependency/Recovery Plane

Uses intended extension seams.

Does not replace baseline.

## 20% Verification/robustness

Strong invariants:
- no unauthorized prompt context
- citation exact-match
- redaction
- append-only chain
- source drift
- dependency traversal
- recovery immutability
- unknown/malformed Runtime events

## 15% Demo/reproducibility

- normal case
- authorization denial
- source/evidence failure
- recovery
- known-at replay
- one-command startup
- `npm run check`
- documented limitations

---

# 11. Priority ladder if implementation slips

The user has explicitly chosen the **full integrated build**.

If time becomes constrained, do not change the architecture; reduce polish/secondary features first.

Cut/polish later:
1. evidence-pack export
2. fancy graph layout
3. animated time slider
4. clarification UI polish
5. authorization blast-radius UI
6. detailed attestation panel

Do not cut:
- Context Capsule
- authorization
- recipient reauthorization
- verified provenance
- ledger
- dependency graph
- evidence invalidation
- blast radius
- reconcile
- core tests

---

# 12. README requirements

Project README should include:

1. Problem
2. Why Agent context needs governance
3. One-line Walnut Rewind thesis
4. Architecture diagram
5. Context Capsule example
6. Authorization model
7. Evidence/provenance model
8. Runtime event evidence
9. Invalidation/reconciliation
10. Setup
11. Demo instructions
12. Test commands
13. Failure cases
14. Security/privacy design
15. Honest limitations
16. Future extensions
17. No-secrets statement

---

# 13. Honest limitations

Document clearly:

- mock identity / grants are hackathon scale
- no production OAuth
- no SpiceDB/ReBAC service
- JSONL is Codex-emitted events, not complete OS/provider telemetry
- no claim of per-physical-model-call audit
- Docker is not a hardened multi-tenant security boundary
- redaction is defense-in-depth, not anonymization
- pointer-not-copy means historical source may drift
- bitemporal implementation is lightweight, not full SQL:2011 temporal DB
- dependency graph only knows relationships captured by Walnut
- reconciliation reruns modeled Agent work; it cannot undo external side effects outside modeled boundaries

---

# 14. Future extensions

After hackathon:
- MCP/A2A transport of Walnut Evidence Packets
- real delegated tokens
- SpiceDB/ReBAC
- durable workflows
- source-native ACL rechecks
- connector plane
- stronger sandbox
- external evidence pack signatures
- richer temporal database
- enterprise PII/tokenization
- cross-runtime adapters
- graph storage at scale

But these must remain future work, not required dependencies for the TechJam POC.
