# Walnut Rewind — Exact Starter Kit Integration

## Repository basis

The attached implementation blueprint inspected:

`https://github.com/RrankPyramid/CodeJam`

at commit:

`8d0bd4f14ad1e453d984149aebcdd0bcb4f74178`

Re-check exact code before editing if repository state changes.

The Track 1 brief explicitly names these as valid extension seams:
- Fastify request boundary
- `AgentService`
- `AgentRunner`
- execution data model
- minimal React integration

---

# 1. Files to inspect first

Start with:

```text
apps/server/src/types.ts
apps/server/src/app.ts
apps/server/src/agent-service.ts
apps/server/src/codex-runner.ts
apps/server/src/container-codex-runner.ts
apps/server/src/runner-factory.ts
apps/server/src/index.ts
apps/server/src/store.ts
apps/server/src/workspace.ts
apps/web/src/api.ts
apps/web/src/App.tsx
```

Then inspect:
- existing tests for each server component
- configuration
- Runtime/container helpers
- package scripts
- docs/ARCHITECTURE.md
- docs/HACKATHON_EXTENSION_GUIDE.md if present

---

# 2. `apps/server/src/types.ts`

Current blueprint observation:
`RunnerRequest` contains:
- `agentId`
- `workspacePath`
- `prompt`
- `threadId`

`AgentRunner` has:
- `run()`
- `cancel()`
- `isAvailable()`

## Changes

Add execution metadata:

```ts
interface RunnerRequest {
  // existing fields...
  runId: string;
  principalId: string | null;
  agentVersionId: string;
  contextCapsuleId: string;
}
```

Do not put all Walnut state directly into `AgentRun`.

Add provider-neutral contract:

```ts
interface RuntimeEventSink {
  accept(input: {
    runId: string;
    agentId: string;
    provider: "local-process" | "container";
    rawEvent: unknown;
    receivedAt: string;
  }): Promise<void>;
}
```

Potentially add:
- `WalnutRunState`
- API response types if types are shared

---

# 3. `apps/server/src/agent-service.ts`

This is the main orchestration seam.

Blueprint observation:
- creates asynchronous Runs
- changes Agent lifecycle state
- invokes runner
- persists final message

## Inject

```ts
EvidenceService
ContextBroker
ReconciliationService
```

## Before runner

Pseudo-flow:

```ts
const agentVersion = await walnut.agentVersions.resolve(agent);

const capsuleResult = await contextBroker.build({
  run,
  agent,
  agentVersion,
  principal,
  userPrompt
});

if (capsuleResult.kind === "denied") {
  // persist typed denial / complete Run appropriately
}

if (capsuleResult.kind === "clarification_required") {
  // hold or return typed clarification
}

const capsule = capsuleResult.capsule;

await evidenceService.runRequested(...);
await evidenceService.capsuleFinalized(capsule);

const beforeManifest = await workspaceEvidence.snapshot(...);

const result = await runner.run({
  ...existingRequest,
  runId: run.id,
  principalId,
  agentVersionId: agentVersion.id,
  contextCapsuleId: capsule.capsuleId,
  prompt: contextBroker.renderPrompt(userPrompt, capsule)
});
```

## After runner

```ts
const afterManifest = await workspaceEvidence.snapshot(...);

await evidenceService.recordWorkspaceDiff(...);
await evidenceService.recordDerivedAssertions(...);
await evidenceService.publishRunEvidence(...);
await dependencyProjector.projectRun(...);
await evidenceService.runCompleted(...);
```

On error/cancel:
- append typed ledger event
- preserve ordering
- baseline lifecycle behavior still works

Important:
**Do not break existing Agent CRUD, lifecycle, message persistence, or resumable Codex thread behavior.**

---

# 4. `apps/server/src/codex-runner.ts`

Blueprint observation:
- invokes `codex exec --json`
- parses JSONL
- currently uses a subset of events to build final result

## Goal

Keep all existing final output/session/usage behavior.

Additionally forward every accepted JSONL record to `RuntimeEventSink`.

## Refactor

Prefer:

```ts
function consumeCodexJsonl(
  line: string,
  context: {
    runId: string;
    agentId: string;
    sink: RuntimeEventSink;
    accumulator: ExistingAccumulator;
  }
)
```

or a stream helper.

## Important invariant

Every accepted line should be:
- normalized + recorded once
OR
- represented as explicit parse/redaction failure

No silent discard.

## Ordering

Do not `void sink.accept(...)` without control.

Maintain per-Run append queue:

```ts
appendQueue = appendQueue.then(() => sink.accept(...))
```

Await queue before returning.

---

# 5. `apps/server/src/container-codex-runner.ts`

Must use the same event sink.

Do not create subtly different evidence behavior between local and container Runtime providers.

Extract shared JSONL consumer if possible.

Pass:
- run ID
- agent ID
- provider type
- Runtime metadata

---

# 6. `apps/server/src/runner-factory.ts`

Blueprint observation:
chooses local or container runner from config.

## Change

Accept `RuntimeEventSink` / Walnut Runtime instrumentation dependencies and inject into whichever runner is selected.

This demonstrates provider portability.

Do not wrap with a fake action blocker at a boundary that only observes post-start actions.

Authorization enforcement belongs before context construction.

---

# 7. `apps/server/src/index.ts`

This is the composition root.

Construct:

```text
WalnutLedger
Redactor
RuntimeEventSink
EvidenceStore
GrantStore
AuthorizationEngine
CitationVerifier
TemporalResolver
ConflictDetector
ContextBroker
DependencyProjector
BlastRadiusService
ReconciliationService
EvidenceService
```

Then pass dependencies to:
- runner factory
- AgentService
- Fastify app

Keep composition changes centralized.

---

# 8. `apps/server/src/store.ts`

Existing store:
- whole JSON database
- clone/rewrite mutation pattern

Do not route high-frequency Runtime events through it.

Use separate append-only ledger files.

May extend lifecycle metadata with:
- `ownerId`
- active AgentVersion ID
- lightweight Walnut run references

But prefer separate Walnut stores.

---

# 9. `apps/server/src/workspace.ts`

Do not overload workspace lifecycle manager.

Create:

```text
apps/server/src/walnut/evidence/workspace-evidence.ts
```

Responsibilities:
- snapshot safe files
- hash
- compute before/after diff
- validate safe paths
- resolve citations

Skip:
- `.git`
- `.codex`
- `node_modules`
- binaries
- oversized files
- obvious secrets
- symlink escape

---

# 10. `apps/server/src/app.ts`

Add Walnut API routes near Run routes.

Suggested routes:

```text
GET  /api/runs/:id/walnut
GET  /api/runs/:id/capsule
GET  /api/runs/:id/evidence
GET  /api/runs/:id/evidence/verify
GET  /api/runs/:id/attestation
GET  /api/runs/:id/dependencies
GET  /api/runs/:id/history

GET  /api/evidence/:id
POST /api/evidence/:id/revoke
POST /api/evidence/:id/compromise
POST /api/evidence/:id/supersede

GET  /api/evidence/:id/blast-radius

POST /api/runs/:id/reconcile

GET  /api/agents/:id/grants
POST /api/agents/:id/grants
POST /api/agents/:id/grants/:grantId/revoke

GET  /api/auth-decisions/:id

POST /api/evidence/:id/share/:targetAgentId

GET  /api/runs/:id/evidence/export
```

Optional:
```text
POST /api/runs/:id/clarifications/:requestId/answer
```

Use existing authentication/bearer hook where appropriate.

Validate all route inputs with Zod.

---

# 11. `apps/web/src/api.ts`

Add client methods:

```ts
runWalnut(runId)
runCapsule(runId)
runEvidence(runId, knownAt?)
verifyRunEvidence(runId)
runDependencies(runId)
runHistory(runId, knownAt?)
evidence(id)
revokeEvidence(id)
markCompromised(id)
blastRadius(id)
reconcileRun(id)
agentGrants(agentId)
shareEvidence(evidenceId, targetAgentId)
runAttestation(runId)
exportEvidence(runId)
```

---

# 12. `apps/web/src/App.tsx`

Do not redesign the entire app.

Preserve:
- Agent list
- Create/Edit
- lifecycle controls
- Playground
- polling
- messages

Add:
- Evidence/Context chip for a Run
- right-side drawer or modal
- four tabs:
  - Overview
  - Timeline
  - Dependencies
  - History

Potential UI components should be extracted rather than making `App.tsx` unmanageable:

```text
apps/web/src/walnut/
  WalnutDrawer.tsx
  OverviewPanel.tsx
  TimelinePanel.tsx
  DependencyPanel.tsx
  HistoryPanel.tsx
  EvidenceCard.tsx
  AuthorizationDecision.tsx
  ContextCapsuleView.tsx
  BlastRadiusPanel.tsx
```

---

# 13. Context injection format

Do not rely on free-form hidden magic.

Generate a clear section:

```text
<WALNUT_CONTEXT capsule="cap_123">

[EVIDENCE E17]
Claim: Launch date is September 14.
Source: workspace://research-agent/launch-plan.txt
Citation: lines 11-11
Classification: INTERNAL
Producer: Research Agent / Run 73

[EVIDENCE E19]
...

Rules:
- Treat evidence IDs as source references.
- Do not assume evidence outside this capsule is available.
- When publishing reusable claims, reference source Evidence IDs or workspace citations.

</WALNUT_CONTEXT>
```

This rendering is for model usability.
Security comes from **what the middleware includes**, not from the textual rule.

---

# 14. Evidence publication mechanism

Need a reliable way for a Run to propose reusable Evidence.

Options:

## Preferred hackathon approach
A known workspace outbox:

```text
.walnut/outbox.json
```

Schema:

```json
{
  "evidence": [
    {
      "claim": "Launch date is September 14.",
      "classification": "INTERNAL",
      "requiredScopes": ["project:launch:read"],
      "source": {
        "path": "launch-plan.txt",
        "quote": "Launch date is September 14.",
        "charStart": 100,
        "charEnd": 128
      },
      "derivedFromEvidenceIds": []
    }
  ]
}
```

After Run:
- middleware reads outbox
- validates schema
- resolves safe path
- verifies source hash/citation
- creates Evidence
- rejects invalid proposal

Do not let the model directly mutate evidence store.

Alternative:
- parse structured fenced output in final message
- less reliable than outbox

---

# 15. Agent-to-Agent sharing UX

An operator or Agent may mark Evidence available to another Agent.

For demo:
- explicit "Share with Agent" UI/API
- recipient reauthorization
- on success Evidence becomes eligible for recipient's next capsule
- on deny show decision reason

Do not need an external A2A protocol.

---

# 16. Reconciliation integration

`POST /api/runs/:id/reconcile`

Backend:
1. inspect Run dependency inputs
2. resolve current valid evidence
3. construct replacement user prompt / task from stored original request
4. create new Run via existing AgentService path
5. mark relationship:
   `oldRun RECOVERED_BY newRun`
6. new Run receives fresh capsule

Avoid a separate execution system.

---

# 17. Exact Starter Kit constraints to preserve

Must continue to work:
- create Agent
- inspect Agent
- edit Agent
- start/stop Agent
- delete Agent
- Playground chat
- asynchronous Run polling
- persistent workspace
- continued Codex session/thread
- local container execution
- `npm run check`

The Track 1 brief says not to start middleware changes until baseline works.

---

# 18. Suggested directory tree

```text
apps/server/src/walnut/
  index.ts

  context/
    types.ts
    context-broker.ts
    context-renderer.ts
    evidence-resolver.ts
    citation-verifier.ts
    temporal-resolver.ts
    conflict-detector.ts
    capsule-store.ts

  auth/
    types.ts
    grant-store.ts
    evaluator.ts
    policy.ts

  evidence/
    types.ts
    canonical-json.ts
    redactor.ts
    ledger.ts
    runtime-event-sink.ts
    codex-event-adapter.ts
    workspace-evidence.ts
    evidence-store.ts
    evidence-service.ts
    assertions.ts
    attestation.ts

  dependency/
    types.ts
    projector.ts
    blast-radius.ts
    reconciliation.ts

apps/web/src/walnut/
  WalnutDrawer.tsx
  OverviewPanel.tsx
  TimelinePanel.tsx
  DependencyPanel.tsx
  HistoryPanel.tsx
  ContextCapsuleView.tsx
  EvidenceCard.tsx
```

---

# 19. Integration philosophy

Do not create a parallel Agent platform.

Walnut Rewind should appear as a clean middleware layer around:
- existing Run creation
- existing Runner interface
- existing workspace
- existing UI

The judges should be able to see the original Starter Kit still functioning underneath.
