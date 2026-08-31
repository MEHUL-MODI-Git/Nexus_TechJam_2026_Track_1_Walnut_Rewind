# Walnut Rewind — Architecture

# 1. Design principles

## Principle 1 — Context is a governed runtime object
An Agent Run should not consume arbitrary cross-Agent prose. It consumes a finalized Context Capsule.

## Principle 2 — Models propose; middleware decides
Models may:
- propose evidence
- propose citations
- produce outputs

Deterministic middleware owns:
- authorization
- citation validation
- evidence status
- dependency edges
- invalidation
- reconciliation state
- hash verification

## Principle 3 — Ledger first, graph second
The append-only evidence ledger is the source of historical truth.
The graph/timeline is a rebuildable projection.

## Principle 4 — Never silently rewrite history
Correction = supersession/revocation/new version.
Recovery = new Run.
Old history remains queryable.

## Principle 5 — Unauthorized context never reaches the model
The enforcement boundary is pre-context-construction.

## Principle 6 — Redact before persistence
The privileged evidence store should never rely on UI-only hiding.

## Principle 7 — Pointer-not-copy
Persist minimum evidence needed for provenance and replay.

## Principle 8 — Fail visibly
Unknown Runtime event, malformed JSONL, citation mismatch, source drift, authorization denial, evidence conflict, chain failure → typed visible state.

---

# 2. High-level architecture

```text
┌────────────────────────────────────────────────────────────────────┐
│                         React Web UI                               │
│                                                                    │
│ Existing: Agent CRUD · lifecycle · Playground                      │
│ New: Evidence drawer · Dependencies · History · Reconcile          │
└──────────────────────────────┬─────────────────────────────────────┘
                               │
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│                         Fastify API                                │
│                                                                    │
│ Existing Agent/Run APIs                                            │
│ New Walnut APIs: evidence · capsule · auth · graph · replay        │
└──────────────────────────────┬─────────────────────────────────────┘
                               │
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│                         AgentService                               │
│                                                                    │
│ Existing lifecycle orchestration retained                          │
│                                                                    │
│ Before runner.run():                                               │
│   Walnut Context Broker → Context Capsule                           │
│                                                                    │
│ After / during runner:                                              │
│   Evidence Service → ledger + dependency projection                 │
└──────────────────────────────┬─────────────────────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              ▼                                 ▼
┌─────────────────────────────┐       ┌──────────────────────────────┐
│     WALNUT CONTEXT PLANE    │       │       WALNUT EVIDENCE PLANE │
│                             │       │                              │
│ Evidence resolver           │       │ RuntimeEventSink             │
│ Authorization engine        │       │ Codex adapter                │
│ Citation verifier           │       │ Redactor                     │
│ Temporal resolver           │       │ Hash-chained ledger          │
│ Conflict detector           │       │ Workspace evidence           │
│ Context Capsule builder     │       │ Deterministic assertions     │
└──────────────┬──────────────┘       └──────────────┬───────────────┘
               │                                     │
               └────────────────┬────────────────────┘
                                ▼
                    ┌─────────────────────────┐
                    │      AgentRunner        │
                    │                         │
                    │ CodexRunner             │
                    │ ContainerCodexRunner    │
                    └────────────┬────────────┘
                                 │
                                 ▼
                         codex exec --json
                                 │
                                 ▼
                      BytePlus ModelArk path
```

---

# 3. The Context Plane

Suggested modules:

```text
apps/server/src/walnut/context/
  types.ts
  context-broker.ts
  capsule-store.ts
  authorization.ts
  grant-store.ts
  evidence-resolver.ts
  citation-verifier.ts
  temporal-resolver.ts
  conflict-detector.ts
  context-renderer.ts
```

Responsibilities:

## ContextBroker
Main orchestration entrypoint.

Input:
- run
- Agent
- AgentVersion
- principal
- user request

Output:
- finalized ContextCapsule
- rendered safe context for Codex

## AuthorizationEngine
Determines `ALLOW` / `DENY` for every candidate Evidence item.

## EvidenceResolver
Loads candidate Evidence that may be relevant to target Agent/task.

For hackathon simplicity, evidence selection may initially be:
- explicitly selected/share-targeted evidence
- evidence produced by named upstream Agent
- project/topic-local evidence
- deterministic metadata matching

Do not over-invest in retrieval.

## CitationVerifier
Exact source checks.

## TemporalResolver
Resolves active evidence version at capsule construction time.

## ConflictDetector
Detects unresolved conflicts.

## ContextRenderer
Converts finalized capsule into model-readable context.

Important:
- only authorized evidence
- include stable evidence IDs
- include citations/source labels
- no unauthorized source content
- no secret values

---

# 4. The Evidence Plane

Suggested modules:

```text
apps/server/src/walnut/evidence/
  types.ts
  canonical-json.ts
  redactor.ts
  ledger.ts
  runtime-event-sink.ts
  codex-event-adapter.ts
  workspace-evidence.ts
  evidence-service.ts
  assertions.ts
  projector.ts
  attestation.ts
```

## RuntimeEventSink
Provider-neutral interface injected into local and container runners.

## CodexEventAdapter
Turns arbitrary Codex JSONL into normalized safe records.

Unknown item types are preserved as `runtime.unknown`.

## Redactor
Runs before ledger append.

## Ledger
Append-only NDJSON / JSONL.

Recommended path:
`APP_DATA_DIR/walnut/evidence/<runId>.ndjson`

Could use one chain per Run.

## WorkspaceEvidence
Take safe before/after manifests.

Skip:
- `.git`
- `.codex`
- `node_modules`
- binaries
- oversized files
- secret-named files
- symlinks escaping workspace

## Assertions
Deterministic derived claims:
- test command passed
- test command failed
- artifact created/modified/deleted
- source drift
- chain integrity verified

---

# 5. Governance / authorization plane

Suggested modules:

```text
apps/server/src/walnut/auth/
  types.ts
  grants.ts
  policy.ts
  evaluator.ts
  history.ts
```

No SpiceDB required.

Use simple pattern/scoped grants.

Possible resources:
- `project:*`
- `project:launch`
- `finance:quarterly`
- `payroll`
- `public`
- `workspace:<agentId>:*`

Possible actions:
- `read`
- `consume`
- `share`
- `write`
- `external_write`

Use deterministic matching.

---

# 6. Dependency / recovery plane

Suggested modules:

```text
apps/server/src/walnut/dependency/
  types.ts
  projector.ts
  blast-radius.ts
  reconciliation.ts
```

## Projector
Build nodes/edges from ledger + capsule + evidence records.

## BlastRadius
Graph traversal.

## Reconciliation
Creates and records recovery relationship.

Reconciliation should call existing Agent lifecycle / send-message functionality rather than inventing a second runtime.

---

# 7. Persistence strategy

The Starter Kit's existing JSON store rewrites the whole database on mutation.

Do not use it for high-frequency Runtime events.

Suggested split:

```text
APP_DATA_DIR/
  database.json                    existing Starter Kit lifecycle data

  walnut/
    evidence/
      <runId>.ndjson               high-frequency append-only ledger

    capsules.json                  low-frequency Context Capsules
    evidence-index.json            Evidence metadata
    grants.json                    grants/policy
    auth-decisions.json            authorization records
    dependency-index.json          optional cached graph projection
    reconciliations.json
```

Use atomic writes for low-frequency metadata.

The dependency index should be rebuildable from source records.

---

# 8. Run lifecycle integration

Existing conceptual flow:

```text
create Run
→ runner.run()
→ persist final response
→ complete Run
```

New flow:

```text
create Run

→ resolve AgentVersion

→ Walnut ContextBroker
    → gather candidate evidence
    → temporal version resolution
    → authorization decisions
    → citation verification
    → conflict detection
    → finalize Context Capsule

→ append run.requested
→ append capsule.finalized

→ workspace BEFORE manifest

→ runner.run(
     prompt + rendered capsule context,
     runId,
     capsuleId,
     principalId
   )

→ Codex JSONL events stream through RuntimeEventSink

→ workspace AFTER manifest

→ deterministic assertions

→ evidence publication from Run if applicable

→ dependency edges

→ append run.completed / failed / cancelled

→ finalize attestation

→ publish terminal Run state
```

If context construction fails:
- DENY → typed refusal
- conflict → ClarificationRequest
- invalid source → fail closed
- no eligible evidence → Run may continue if task does not require it; record empty capsule

---

# 9. Agent-to-Agent evidence flow

Do not create a general distributed message bus.

Use platform-local evidence sharing.

Flow:

```text
Agent A Run
  ↓
proposes reusable Evidence
  ↓
middleware verifies citation/source
  ↓
Evidence ACTIVE
  ↓
Evidence is eligible for Agent B
  ↓
B capsule construction re-authorizes
  ↓
ALLOW → include
DENY → exclude + record decision
```

This achieves multi-Agent context propagation without introducing unnecessary protocol scope.

---

# 10. Runtime event ingestion

Both `CodexRunner` and `ContainerCodexRunner` should use the same event sink.

Extract a shared helper if possible:

```ts
consumeCodexJsonl({
  stream,
  runId,
  eventSink,
  accumulator
})
```

Every line:
1. parse
2. if parse failure → explicit safe error record
3. normalize
4. redact
5. append in order
6. update existing final-result accumulator

Need a per-Run promise queue so async file appends preserve ordering.

Await queue drain before `run()` returns or throws.

---

# 11. Threat / trust boundaries

## Trusted
- Fastify/Node middleware process
- authorization evaluator
- citation verifier
- ledger hasher/verifier
- dependency projector
- capsule builder

## Untrusted observations
- Codex Runtime strings
- Agent-generated evidence proposal
- commands
- file content
- source claims
- Runtime-provided Markdown/HTML

## Browser
Display layer only.
No security decision should rely on the browser.

Evidence UI should render untrusted strings inertly.

---

# 12. Recovery state model

A Run may have additional Walnut state:

```ts
type WalnutRunState =
  | "CLEAN"
  | "STALE"
  | "TAINTED"
  | "RECOVERED";
```

- `STALE`: dependency changed/superseded
- `TAINTED`: source/evidence explicitly compromised
- `RECOVERED`: a clean replacement Run exists

Do not alter Starter Kit core Run status unnecessarily. Keep Walnut status as parallel middleware metadata.

---

# 13. Source drift

When resolving evidence pointer:
- re-hash current source
- compare with stored hash

If mismatch:
- mark pointer `DRIFTED`
- do not silently claim current source still supports historical Evidence
- depending on policy, supersede/revoke affected Evidence

This becomes a very strong demo trigger.

---

# 14. Evidence pack architecture

Optional but desirable.

Export:
- manifest
- Context Capsule
- authorization decisions
- Evidence metadata
- ledger
- chain head
- artifact hashes
- dependency edges
- recovery links

Standalone verifier:
- reads bundle
- verifies record hashes and chain continuity
- verifies capsule hash
- optionally verifies artifact hashes if files are provided

---

# 15. Presentation architecture vs implementation architecture

Implementation may contain all integrated features.

The eventual 3-minute demo should likely emphasize a subset:
- Context Capsule
- authorization denial
- verified evidence/citation
- invalidation/blast radius
- Reconcile

Runtime tracing/hash-chain/time-travel can support the story without all being equal headline features.

Do not delete integrated features merely because they are not selected for the presentation.
