# Walnut Rewind — Source Basis, Reused Ideas, and Locked Decisions

# 1. Track 1 requirements used

From the TechJam 2026 Track 1 brief:

Starter Kit already provides:
- browser UI
- Agent CRUD
- lifecycle controls
- Playground
- Fastify API/control plane
- async Runs
- AgentService
- JSON persistence
- Codex CLI
- persistent sessions
- per-Agent workspaces
- disposable local containers
- BytePlus ModelArk
- optional ECS

The challenge asks teams to design and demonstrate middleware that improves the Agent platform.

The brief emphasizes:
- preserve baseline
- implement real backend/Runtime/data behavior
- define the boundary
- demonstrate normal + failure/denial/recovery/abuse
- add automated verification
- keep secrets out
- local POC is enough
- breadth is not the goal

Weights:
- 40% end-to-end middleware behavior
- 25% technical design/integration
- 20% verification/robustness
- 15% demo/reproducibility

Recommended examples include:
- identity/authorization
- delegated authority
- policy enforcement
- trace/audit
- lifecycle/recovery
- memory/state governance
- versioning/rollback
- multi-Agent coordination
- credential exchange
- team-defined middleware

Walnut Rewind combines these only under one coherent theme:
**governed, versioned, reversible Agent context.**

---

# 2. Walnut/DataBridge ideas reused

## From `03-BITEMPORAL-GRAPH.md`

Reused:
- valid time vs transaction/belief time
- supersede rather than rewrite
- graph as rebuildable projection of ledger
- historical "what did we believe then?"
- authorization-history concept

Adapted:
- lightweight JSON/NDJSON rather than full Postgres SQL:2011
- no Neo4j

## From `04-EVIDENCE-CITATIONS-GROUNDING.md`

Reused:
- no value without provenance
- SourcePointer concept
- byte/exact-match anchor verification
- pointer-not-value/pointer-not-copy spirit
- deterministic verification rather than model self-grounding

Adapted:
- workspace/local sources first
- no full grounding wall / verifier ensemble

## From `05-PRIVACY-SECURITY-AIRGAP.md`

Reused:
- pointer-not-copy
- redaction before storage
- most-restrictive-wins classification
- delegated authority cannot widen
- security at architecture boundary rather than prompt

Not imported:
- OpenBao
- SpiceDB
- Firecracker
- gVisor
- airgap artifact typing
- full PII ensemble

## From `06-HARNESS-GOVERNANCE-INVARIANTS.md`

Reused:
- models propose, code decides
- deterministic policy gates
- clarification-first
- no silent assumption
- typed refusal/denial
- invariants as tests

Not imported:
- full H1–H10
- Temporal
- model routing stack
- full grammar TCB

## From `02-ARCHITECTURE-AND-SYSTEM-DESIGN.md`

Reused:
- ledger-first architecture
- graph as projection
- typed boundaries
- clean separation between control plane and evidence/governance
- pointer-not-copy
- evidence as a system property

## Build-status honesty (from the source corpus)

Important honesty:
Walnut/DataBridge's full enterprise architecture is mostly designed, not fully built.

Actually implemented in that separate project:
- Evidence Ledger core
- Model Harness core
- connector contract/reference adapter in progress/review

Therefore TechJam implementation should **port principles and data shapes**, not pretend the whole DataBridge stack already exists.

---

# 3. ProofGraph blueprint ideas reused

From `track-1-walnut-starter-kit-blueprint.md`:

Reused:
- Codex JSONL stream as real observed Runtime boundary
- per-Run append-only ledger
- redaction before persistence
- hash-chained events
- Runtime event normalization
- workspace before/after evidence
- deterministic derived assertions
- minimal Evidence UI
- no graph database
- same sink for local + container Runners
- explicit limitations on JSONL visibility
- robust tests for tamper, unknown events, malformed events, canary leakage

ProofGraph becomes the **evidence substrate** underneath Walnut Rewind.

---

# 4. Glass Ledger blueprint ideas reused

From `TRACK1-SOLUTION-WALNUT-MIDDLEWARE.md`:

Reused:
- hash-chain verification
- append-only history
- Agent version pinning
- evidence export/offline verifier
- mock identity is sufficient for hackathon
- typed visible failures
- compliance-grade evidence framing

Not made core:
- post-hoc risky-command gating at JSONL boundary

Reason:
JSONL is observational; authorization before context entry is a cleaner and more defensible enforcement boundary.

---

# 5. Earlier Relay concept ideas reused

Reused:
- Agents as principals
- Agent-to-Agent reauthorization
- proof-carrying information transfer
- per-evidence classification
- recipient may not inherit sender access
- dependency graph includes Agents/Runs/Evidence

---

# 6. Earlier Rewind concept ideas reused

Reused:
- Context lockfile / immutable knowledge snapshot
- software-build-system analogy
- dependency graph for cognition
- dirty/tainted Runs
- blast-radius propagation
- selective reconciliation
- `RECOVERED_BY`
- historical belief replay

This is the strongest differentiator and the final product identity.

---

# 7. Locked implementation decisions

## D1
Product name: **Walnut Rewind**

## D2
Core primitive: **Context Capsule**

## D3
Full integrated implementation, not narrowed build.

## D4
Presentation scope may later be reduced without deleting integrated capabilities.

## D5
Authorization is enforced before evidence enters model context.

## D6
Agent-to-Agent transfers always reauthorize recipient.

## D7
Models never directly write committed Evidence.

They propose via typed outbox/schema.

## D8
Reusable Evidence requires provenance.

## D9
Citation verification is deterministic exact match where applicable.

## D10
Runtime observability uses Codex JSONL.

## D11
Do not claim JSONL equals physical model-call accounting.

## D12
Evidence ledger is append-only and hash chained.

## D13
Redaction occurs before ledger append.

## D14
Raw hidden reasoning is not persisted.

## D15
Graph is a rebuildable projection.

## D16
No Neo4j required.

## D17
No SpiceDB required.

## D18
No Temporal required.

## D19
No OpenBao required.

## D20
No Firecracker required.

## D21
Evidence status:
ACTIVE / SUPERSEDED / REVOKED / COMPROMISED.

## D22
Old Runs are never overwritten.

## D23
Reconciliation creates a new Run and `RECOVERED_BY`.

## D24
Use lightweight bi-temporal semantics.

## D25
Capsules pin policy revision/hash and AuthDecision IDs.

## D26
Evidence classification uses most-restrictive-wins.

## D27
Source drift is explicit.

## D28
Unknown Runtime events are preserved safely.

## D29
Malformed Runtime lines create explicit safe errors.

## D30
Dependency/blast-radius logic must be deterministic and tested.

---

# 8. What not to accidentally build

Avoid scope drift into:
- generic RAG engine
- full knowledge graph platform
- full A2A protocol
- production IAM product
- full GRC/compliance suite
- workflow editor
- cloud control plane
- model router
- sandbox product
- enterprise connector system

Walnut Rewind is middleware for:
**what Agents know, why, under which authority, and how dependent work recovers when that knowledge changes.**

---

# 9. Suggested prompt for a coding agent

You can paste the following into Claude/Codex after providing this bundle:

> Implement Walnut Rewind in the TechJam 2026 Track 1 Starter Kit. Treat `00-START-HERE.md` as the canonical scope and the rest of this handoff bundle as the implementation specification. We are building the full integrated version, not the narrowed demo-only version. Preserve the existing Agent CRUD/lifecycle/Playground/Codex behavior. Build in layers: first Runtime evidence ledger and Context Capsule + authorization; then provenance/citations and Agent-to-Agent transfer; then dependency graph, evidence invalidation, blast radius, and reconciliation; then temporal/history UI, clarification, attestation/export if time permits. Do not silently drop features from the canonical scope—if something cannot be completed, leave a clearly marked interface/TODO and document the limitation. Prioritize correctness and automated invariants. Do not add heavy external services unless absolutely necessary.
