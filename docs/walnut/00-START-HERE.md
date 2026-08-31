# Walnut Rewind — Full Integrated Track 1 Handoff

## Purpose of this bundle

This bundle is the canonical handoff for implementing the **full integrated version of Walnut Rewind** for **TikTok TechJam 2026 Track 1 — Agent Launchpad: Design and Build Lightweight Agent Middleware**.

This is **not** the narrowed presentation-only version.

The implementation target is the broader integrated system combining the strongest parts of:

- Walnut/DataBridge's evidence architecture,
- the earlier **Walnut Relay** concept,
- the later **Walnut Rewind** concept,
- the attached **ProofGraph Middleware** blueprint,
- the attached **Glass Ledger** blueprint.

The implementation team may later choose a smaller subset to present in the 3-minute demo, but **the codebase should be structured to support the full integrated architecture**.

---

# Canonical one-line pitch

> **Walnut Rewind is proof-carrying, authorization-aware, reversible context middleware for AI Agents: every Agent Run executes against an immutable, permission-checked evidence snapshot, and if evidence or permissions later change, Walnut can prove exactly what downstream work was affected and selectively reconcile it without rewriting history.**

A second framing, useful for explaining the novelty:

> **Walnut Rewind is dependency management and version control for Agent cognition.**

Software has lockfiles, dependency graphs, provenance, version pinning, incremental invalidation, and rebuilds. AI Agents generally do not. Walnut Rewind introduces these concepts for **what an Agent is allowed to know and what downstream work depends on that knowledge**.

---

# The core runtime primitive: Context Capsule

Before every Agent Run, Walnut Rewind builds an immutable **Context Capsule** containing the exact evidence that this Run is allowed to consume.

A Context Capsule pins:

- Agent identity
- Agent version
- human/delegating principal
- policy revision/hash
- evidence IDs + evidence versions
- evidence source pointers
- source hashes
- verified citation anchors
- authorization decisions
- evidence classifications
- valid-time / belief-time metadata
- capsule creation time
- capsule hash

Conceptually, this is:

> **`package-lock.json` for Agent knowledge.**

The Agent Runtime should not receive arbitrary cross-Agent context directly. It should receive **Walnut-mediated context constructed from the capsule**.

---

# Full feature set to implement

The implementation should include all of the following, ideally in this order of structural importance:

## 1. Context Capsules
Immutable per-Run snapshots of authorized evidence and policy basis.

## 2. Per-Agent authorization
Every Agent is its own principal. Evidence must be authorized **before it enters the model context**.

## 3. Delegated authority
An Agent acting on behalf of a human/user cannot exceed that human's authority.

Effective authority is the intersection of:

- Agent grant
- delegating principal grant
- source/evidence requirements
- current policy revision

## 4. Agent-to-Agent re-authorization
If Agent A can access evidence, that does **not** mean Agent B can receive it.

Every transfer is re-checked for the recipient.

## 5. Proof-carrying evidence
Reusable knowledge between Agents is represented as typed Evidence rather than naked prose.

Each Evidence record carries:
- source pointer
- source hash
- producer Agent
- producer Run
- citation
- temporal metadata
- authorization requirements
- classification
- status
- derivation links

## 6. Mechanical citation verification
The model may propose a citation, but deterministic middleware verifies it.

For text:
`source[start:end] === quote`

No fuzzy matching. No "LLM says grounded."

## 7. Runtime flight recorder
Capture actual Codex JSONL Runtime events:
- thread/session
- turn
- commands
- file changes
- MCP/tool calls
- web search if emitted
- plan metadata
- errors
- final messages
- reasoning metadata only, not raw hidden reasoning

## 8. Redact-before-persist
Sensitive strings, keys, bearer tokens, private keys, env values, and planted secret canaries must be removed **before evidence persistence**.

## 9. Append-only hash-chained evidence ledger
Every persisted evidence/runtime record includes the previous record hash and its own canonical hash.

Tampering, insertion, deletion, and reordering should be detectable.

## 10. Pointer-not-copy privacy
Do not persist full sensitive payloads merely for observability.

Prefer:
- safe pointer
- content hash
- bounded redacted preview
- line/byte anchor
- classification
- source metadata

## 11. Dependency / proof graph
Project the ledger into a graph linking:
- human principals
- Agents
- Agent versions
- Runs
- Context Capsules
- Evidence
- sources
- authorization decisions
- runtime events
- artifacts
- recovery Runs

## 12. Evidence lifecycle
Evidence supports:
- ACTIVE
- SUPERSEDED
- REVOKED
- COMPROMISED

History is append-only. Never silently rewrite the old record.

## 13. Blast-radius analysis
If evidence becomes invalid, compromised, or superseded, traverse the dependency graph to identify affected:
- capsules
- Runs
- derived evidence
- downstream Agents
- generated artifacts

## 14. Selective reconciliation / Rewind
Affected Runs are marked stale/tainted.

Reconciliation:
- creates a new Context Capsule
- executes a new Run
- records `RECOVERED_BY`
- never overwrites the old Run

## 15. Lightweight bi-temporal history
At minimum distinguish:
- when something was true / effective (`valid time`)
- when the platform recorded or believed it (`transaction/belief time`)

For hackathon scope, exact four-timestamp SQL:2011 machinery is optional. The semantics are important.

## 16. Authorization history
Record the authorization decision and policy revision used to construct each capsule.

The platform should be able to explain:
> "Why was Agent X allowed to use Evidence Y during Run Z?"

## 17. Time-travel / as-known-at view
Allow an operator to inspect what the platform believed at an earlier time.

## 18. Deterministic derived verification
Where possible, derive narrow facts from Runtime evidence:
- test passed / failed
- file created / changed / deleted
- evidence source hash current / drifted
- ledger chain verified

Do not rely on the Agent's prose to certify these facts.

## 19. Evidence/timeline/dependency/history UI
Minimal but real UI integrated into the existing Playground.

Suggested tabs:
- Overview
- Timeline
- Dependencies
- History

## 20. Tamper verification
A verification action recomputes the ledger hash chain.

## 21. Context lockfile / capsule export
Expose a machine-readable snapshot of exactly what context the Run executed against.

## 22. Clarification-first conflict handling
If two simultaneously eligible evidence items conflict and deterministic code cannot resolve the ambiguity, return a typed clarification request rather than silently selecting one.

This is a stretch feature only in scheduling priority, **not** because it is outside the integrated architecture.

## 23. Evidence pack / offline verification
If feasible, export Run evidence with a standalone verifier script.

---

# Core product story

Everything above must feel like one system.

The organizing chain is:

```text
Candidate information
    ↓
Evidence normalization
    ↓
Authorization
    ↓
Citation/source verification
    ↓
Version resolution
    ↓
Context Capsule
    ↓
Agent Run
    ↓
Runtime evidence + outputs
    ↓
Dependency graph

Evidence/source/permission changes
    ↓
Blast-radius calculation
    ↓
Affected Runs become stale/tainted
    ↓
Selective reconciliation
    ↓
New clean Run + preserved history
```

This is the story.

---

# Track 1 fit

The Track 1 brief explicitly says the Starter Kit already provides:
- React UI
- Agent CRUD
- Playground
- Fastify control plane
- persistent workspaces
- Codex CLI Runtime
- BytePlus ModelArk integration
- local containers
- optional ECS deployment

The team should build **missing middleware**, not rebuild the platform.

The track explicitly allows or recommends:
- identity and authorization
- trace/audit/observability
- threat modeling and safety
- lifecycle reconciliation and recovery
- state/memory governance
- versioning/rollback
- multi-Agent coordination
- provider/tool routing
- credential exchange
- team-designed middleware

Evaluation:
- 40% end-to-end middleware behavior
- 25% technical design and integration
- 20% verification and robustness
- 15% demo and reproducibility

Depth and coherence matter more than feature count. The implementation can be broad internally, but the architecture must remain coherent around **governed, versioned, reversible Agent context**.

---

# Non-goals / heavy systems not required

Do not introduce these unless there is a very strong reason:
- Neo4j
- SpiceDB
- Temporal
- OpenBao
- Firecracker
- gVisor
- Wasmtime
- full production OAuth
- full DataBridge Company Brain
- general-purpose policy language
- enterprise connector plane
- production PII detection ensemble
- cloud ECS unless everything else is complete

Implement lightweight native TypeScript equivalents inside the Starter Kit.

---

# Important honesty constraints

Do not claim:
- every physical ModelArk request/retry is observed
- JSONL is a pre-command enforcement boundary
- Docker is a hardened multi-tenant sandbox
- redaction equals anonymization
- hash chaining proves unobserved actions did not occur

What we can honestly claim:
- we capture the Codex-emitted Runtime event stream
- we can enforce authorization before context enters the model
- we can mechanically verify evidence anchors against sources
- we can preserve an append-only tamper-evident record of observed events
- we can calculate dependency blast radius for modeled evidence/outputs
- we can reconcile affected Runs without rewriting history

---

# Source basis

This bundle was synthesized from:
- TikTok TechJam 2026 Track 1 problem statement in `TikTok_TechJam_2026_Tracks_and_Problem_Statements.pdf`
- `00-EXECUTIVE-OVERVIEW.md`
- `01-PROBLEM-AND-POSITIONING.md`
- `02-ARCHITECTURE-AND-SYSTEM-DESIGN.md`
- `03-BITEMPORAL-GRAPH.md`
- `04-EVIDENCE-CITATIONS-GROUNDING.md`
- `05-PRIVACY-SECURITY-AIRGAP.md`
- `06-HARNESS-GOVERNANCE-INVARIANTS.md`
- `07-USE-CASES-AND-COMPLIANCE.md`
- `track-1-walnut-starter-kit-blueprint.md`
- `TRACK1-SOLUTION-WALNUT-MIDDLEWARE.md`

The attached starter-kit blueprints inspected `RrankPyramid/CodeJam` at commit:
`8d0bd4f14ad1e453d984149aebcdd0bcb4f74178`

Re-verify exact line numbers if the repository changes.
