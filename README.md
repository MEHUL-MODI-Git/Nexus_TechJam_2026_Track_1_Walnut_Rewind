# Walnut Rewind

**Evidence-and-authorization middleware for AI agent platforms.**
TikTok TechJam 2026 · Track 1 — Agent Launchpad: Design and Build Lightweight Agent Middleware.

Built on the pristine [Volc Agent Launchpad starter kit](docs/UPSTREAM-README.md) (tag
`starter-kit-baseline`); everything Walnut adds is visible as `git diff starter-kit-baseline`.

---

## 1. Problem

Agent platforms can tell you *what an agent did* — the commands it ran, the files it changed.
They cannot tell you **what the agent was allowed to know, why it believed what it believed, who
inherited that belief, or what must be rebuilt when the belief turns out to be wrong.** When an
agent's output is questioned — a wrong date shipped to production, confidential data echoed to
the wrong team — there is no record connecting the output back to the exact knowledge state that
produced it, and no mechanical way to find and repair everything downstream.

## 2. Why agent context needs governance

Prompt-level rules ("please don't use the payroll data") are not a control: the model has already
seen the text. The only enforcement point that works is **before context construction** — an
authorization layer that decides, per piece of evidence, whether it may enter the prompt at all,
and records that decision durably. The same applies to what agents *produce*: a claim with no
verifiable source is an assertion, not evidence, and letting agents write directly into a shared
knowledge store is how one agent's hallucination becomes every agent's ground truth.

## 3. Thesis

> Observability tells you what an agent did. **Walnut Rewind tells you what it was allowed to
> know, why it believed it, who inherited that belief, and what must be rebuilt when the belief
> becomes wrong.**

## 4. Architecture

```
React UI ──► Fastify control plane ──► AgentService ──────────► Codex runner (container)
                 │                        │      ▲                    │ JSONL stdout
   /api/walnut/* │                1  resolve AgentVersion             ▼
                 │                2  ContextBroker.build      consume-codex-jsonl
                 ▼                   │ authorize BEFORE               │ per-line
        walnut/routes                │ assembly (HC-5)                ▼
                 │                   ▼                        RuntimeEventSink
     ┌───────────┴─────────┐   ContextCapsule                 parse → classify →
     ▼           ▼         ▼   (immutable, hashed)            redact → chain
 dependency   context   evidence      │                               │
 projector    plane     plane         ▼                               ▼
 blast radius grants    outbox   rendered <WALNUT_CONTEXT>   hash-chained NDJSON
 run state    evaluator citation  prompt → runner              ledger (per-Run +
 reconcile    capsules  verifier                               governance chains)
```

### 4.1 Trust boundary, enforcement, instrumentation, recovery (the one-page diagram)

The Track-1 deliverable asks the diagram to mark the **trust boundary** and the
enforcement/instrumentation/recovery points explicitly. The boundary is a *data* trust
boundary: everything the model or its workspace produces is untrusted **input** until the
middleware verifies it — we do not claim the container is a hardened sandbox (§15).

```
════════ TRUSTED: control plane + Walnut middleware ══════╦═══ UNTRUSTED: model-influenced ════
                                                          ║
React UI ──► Fastify ──► AgentService ──────────────────────► Codex runner (container)
                │            │                            ║      │ workspace files
  /api/walnut/* │   1 resolve AgentVersion                ║      │ JSONL stdout
                │   2 ContextBroker.build                 ║      │ .walnut/outbox.json
                ▼      │                                  ║      ▼
       walnut/routes   │ E1 AUTHORIZE BEFORE ASSEMBLY     ║  everything on this side is a
                       │    two-leg agent ∩ principal;    ║  PROPOSAL, never a fact:
                       │    conflict → typed              ║    JSONL events, evidence
                       │    clarification, no silent      ║    proposals, citations,
                       │    pick                          ║    artifacts
                       ▼                                  ║      │
                 ContextCapsule (immutable, hashed —      ║      │ cross back ONLY through
                 the run's lockfile)                      ║      ▼
                       │                                  ║  E2 CITATION BYTE-MATCH
                       ▼                                  ║     source[start:end] === quote —
                 rendered <WALNUT_CONTEXT> prompt ──────────► reject on mismatch regardless
                                                          ║     of model confidence
   R RECOVERY: compromise → blast radius → TAINTED        ║  E3 REDACT-BEFORE-PERSIST
     → reconcile mints a NEW run (RECOVERED_BY);          ║     canary-tested; pointers +
     old run, capsule, chain never rewritten              ║     hashes, never raw payloads
                                                          ║
   I INSTRUMENTATION: per-run hash-chained append-only    ║
     NDJSON ledger (events, decisions, rejections) +      ║
     queryable attestation; tamper verification           ║
     recomputes the chain on demand                       ║
══════════════════════════════════════════════════════════╩═══════════════════════════════════
```

Four planes, all lightweight native TypeScript (no Neo4j, no SpiceDB, no Temporal, no policy
engine — HC-10):

- **context/** — grant store, deterministic authorization evaluator, Context Capsule builder,
  citation verifier, conflict detector, A2A share, temporal resolver.
- **evidence/** — redactor, canonical JSON, hash-chained append-only ledger, workspace source
  resolver, evidence store + write service, outbox ingestion, runtime event sink.
- **dependency/** — pure rebuild-from-source graph projector, blast radius, run state,
  reconciliation.
- **routes/ + web panels** — the REST surface (doc-04 §19 shapes) and the Walnut drawer
  (Overview / Evidence / Dependencies / History).

## 5. Context Capsule (real example, from the live smoke)

Every Run executes against a finalized, hashed, immutable capsule — "the exact knowledge state
this agent executed against":

```json
{
  "schemaVersion": 1,
  "capsuleId": "cap_fd6e3a95-b839-4a53-a844-d62a6e8ec9e0",
  "runId": "105197f3-974f-4993-b343-1dfdd9b8e0cd",
  "agentId": "6936db12-ef35-4791-acad-e1388f3794c7",
  "agentVersionId": "av_378472be-8be6-48b8-b052-2bffaf71c5a9",
  "agentPrincipalId": "agent:6936db12-...",
  "onBehalfOfPrincipalId": null,
  "policyRevision": 1,
  "policyHash": "sha256:ee118718…",
  "evidence": [],
  "deniedEvidenceDecisionIds": [],
  "createdAt": "2026-08-27T10:02:52.199Z",
  "transactionCut": "ledger:0",
  "capsuleHash": "sha256:ee21564d…"
}
```

(Captured from a real container run — `results/p1-exit-smoke.md`. An empty capsule is honest:
no evidence existed yet to authorize.)

## 6. Authorization model

Effective access = **agent grants ∩ delegating-principal grants ∩ evidence requirements ∩
policy** — no component can widen authority. A deterministic evaluator produces an immutable
`AuthorizationDecision` (ALLOW or DENY, never a throw) with a pinned reason-code ladder:
`POLICY_DENIED → EVIDENCE_REVOKED/COMPROMISED/SUPERSEDED → CLASSIFICATION_DENIED →
AGENT_SCOPE_MISSING/GRANT_EXPIRED → PRINCIPAL_SCOPE_MISSING → AUTHORIZED`. Every decision pins
the policy revision and hash (INV-20). Denials are recorded, not just enforced: a denied
candidate leaves its decision id in the capsule's `deniedEvidenceDecisionIds`.

**Honest mechanism (HC-5):** the shapes are plain TypeScript — the type system does not make
unauthorized references inexpressible. Enforcement is builder encapsulation (refs are constructed
in exactly one place, after an ALLOW decision) plus the executable evidence: INV-1 (every capsule
ref is ALLOW) and INV-2 (a canary planted in denied evidence never appears in the rendered
prompt, the persisted capsule, or the run's ledger chain).

**A2A sharing (INV-3):** a sender's ALLOW to *share* never implies the recipient's ALLOW to
*consume*. Sharing runs two independent decisions; transfer only ever bridges a missing-scope
gap — classification ceilings, deny-lists, and revoked/compromised status survive it.

## 7. Evidence and provenance model

Agents propose reusable claims through a workspace outbox (`.walnut/outbox.json`) — **the model
never mutates the evidence store**. The write service verifies before anything becomes ACTIVE:

- safe path resolution (no absolute paths, no `..`, no symlink escapes, no secret-shaped files),
- **exact byte-match citation** — `source.slice(charStart, charEnd) === quote`, never fuzzy,
  never normalized, rejected regardless of model confidence (INV-5 / HC-6),
- classification monotonicity — derived evidence is never weaker than a contributor (INV-6),
- source content hash pinned at observation time; re-resolution detects drift (INV-19).

History is append-only (HC-7): corrections are supersede / revoke / compromise, each appending a
new version and closing the prior one's `txClosedAt` — the only permitted write to a stored
record. Old versions stay queryable forever (INV-9).

## 8. Runtime event evidence

Both runners stream every Codex JSONL line through a shared consumer into the
`RuntimeEventSink`: parse → classify (unknown event types become `runtime.unknown`, never a
crash — INV-17) → **redact before persist** (INV-16) → append to the Run's hash-chained NDJSON
ledger, in observed order, awaited before `run()` returns (INV-14). Malformed lines persist as
hash-only `runtime.parse_failure` records — the raw line never touches disk (INV-18). A redactor
failure persists hash-only `redaction_failure`, never the payload. Tampering with a chain —
modify, delete, insert, reorder — is detected with the exact broken sequence (INV-15).

This caught a real leak in development: the Codex CLI prints a diagnostic embedding the
configured model-endpoint identifier; the running redactor replaced it at persist time
(`categories: ["env_value"]`) during the live Phase-1 smoke (`results/p1-exit-smoke.md`).

## 9. Invalidation and reconciliation

When evidence is compromised or revoked, the blast radius is computed over the dependency graph
(a pure projection, rebuildable from source records at any time — INV-11): every downstream
capsule, run, derived evidence, and agent, each exactly once (INV-12). Affected runs are marked
TAINTED in parallel metadata — the starter-kit Run record is never mutated. **Recovery is a new
Run** built from a fresh capsule through the same AgentService path, linked `RECOVERED_BY`; the
old run, its capsule, and its chain are preserved untouched (INV-10). Conflicting evidence never
resolves silently: capsule construction refuses with a typed `ClarificationRequest`
(`defaultOnTimeout: "REFUSE"` is a literal type, not a config — INV-22).

## 10. Setup

```bash
npm install
cp .env.example .env    # if absent, create .env with the two vars below
# .env: ARK_API_KEY=<Ark model API key>   ARK_MODEL=ep-<endpoint id>
#       ARK_BASE_URL=<regional override if your key is not cn-beijing>
colima start            # or Docker Desktop / rootless Podman
set -a; . ./.env; set +a
npm run poc             # one command: builds runtime image + web + server → http://localhost:3000
```

Requirements: Node ≥ 22, npm ≥ 10, a container engine. Local execution is the judging path; no
cloud resource is required (HC-9).

## 11. Demo

**Demo video:** `<YOUTUBE_URL — inserted at submission>` (3 minutes, public).

The demo scenario is **"Launch Control Incident"**: an AI launch team acts on a trusted launch
date while payroll data stays restricted; the date's source is later compromised, and Walnut
identifies exactly which decisions must be rebuilt — without rewriting history.
`demo/DEMO-SCRIPT.md` is the 3-minute stage cut; `demo/FULL-WALKTHROUGH.md` is the judge-runnable
long form; `scripts/walnut-demo-seed.sh` seeds the demo agents; `demo/slides/index.html` is an
optional self-contained slide deck (metrics and limitations, every number sourced to a tracked
artifact). Rehearsal evidence: the **backend path passed end-to-end on 2026-08-28**
(`results/p3-demo-rehearsal.md`, HTTP API), the full scenario passed on 2026-08-28
(`results/p3-walkthrough-rehearsal.md`), the **live UI passed a real-Chrome visual pass on
2026-08-31** — baseline CRUD, a live Playground run, all four Walnut tabs, 24 screenshots,
0 console errors (`results/p2-visual-pass.md`) — and the demo was rehearsed and recorded
beat-by-beat on 2026-09-01 (`results/p3-timed-rehearsal.md`).

Short version: a Research Agent publishes a byte-verified claim through the outbox; a Strategy
Agent's capsule receives it under a grant while the payroll claim (carrying a planted canary)
is denied — *the downstream model never received the payroll data*; compromise
the source, watch the blast radius taint the Strategy run, press RECONCILE, and see the new run
linked `RECOVERED_BY` with all history preserved.

## 12. Tests

```bash
npm run check                        # typecheck (server + web) + all server tests + both builds
npm run test -w @launchpad/server    # server tests only
```

The suite includes per-invariant tests (INV-1…INV-22 mapped in
`docs/walnut/06-IMPLEMENTATION-TEST-DEMO-PLAN.md` §6), the ledger tamper matrix, the redactor
canary battery, and `walnut/e2e.test.ts` — the single end-to-end test that walks the full
thesis: fake runtime → capsule with authorized + denied-canary evidence → ordered redacted
chain → compromise → blast radius → TAINTED → reconcile → RECOVERED_BY. Current counts are in
the CI gate output; at submission time: see `results/p3-final-check.md`.

## 13. Failure cases (by design)

- Citation off by one byte, or differing by whitespace or case → `citation_mismatch`, evidence
  never activates.
- Unauthorized evidence → DENY decision recorded; capsule built without it; run proceeds.
- Deny-listed agent → run-level refusal; the runner is never invoked.
- Conflicting authorized evidence → typed clarification, no capsule, no silent pick.
- Malformed runtime line → hash-only typed failure; unknown event type → `runtime.unknown`.
- Chain tampering → `verifyChain` pinpoints the first broken sequence.
- Reconciling a CLEAN run → 409; recovery is a response to invalidation, not a rerun button.

## 14. Security and privacy design

Redact-before-persist with planted-canary tests (Ark key, bearer token, PEM block, env values);
prompts are chained as hashes, never text; run outputs are chained as lengths, never text; ledger
payloads are redacted copies; `.env` is gitignored; workspace evidence cannot quote secret-shaped
files; untrusted strings render as inert text nodes in the UI. Authorization happens before
context construction, in the backend — never in the UI (HC-2).

## 15. Honest limitations

- The grant/identity model is hackathon-scale mock authorization — no production OAuth, no
  SpiceDB/ReBAC service. Claiming otherwise would be false.
- The JSONL stream is **Codex-emitted events, not complete OS or provider telemetry**. We do
  not claim every physical ModelArk request/retry is observed, and JSONL is not a pre-command
  enforcement boundary.
- The disposable Docker container is an isolation convenience, **not a hardened multi-tenant
  sandbox**; the Linux runtime falls back to `danger-full-access` inside that boundary.
- Redaction is defense-in-depth, **not anonymization**; hash chaining proves recorded history is
  intact, **not that an unobserved action never happened**.
- Pointer-not-copy provenance means a historical source can drift; that is surfaced (DRIFTED),
  not prevented.
- Ledger integrity is **per-chain**: tampering *within* a chain (modify/delete/insert/reorder)
  is detected with the exact broken sequence, but the deletion of an entire chain file is
  detectable only through cross-references (capsule and evidence records pointing at it) — the
  chain cannot prove its own absence.
- The bitemporal layer is deliberately lightweight (valid time vs recorded time), not a
  SQL:2011 temporal database.
- The dependency graph knows only relationships Walnut captured; reconciliation reruns modeled
  agent work — it cannot undo external side effects outside the modeled boundary.
- Workspace artifact manifests capture safe before/after content hashes only — never file
  contents; binary, oversized, and excluded-directory files are skipped and the skips are not
  themselves itemized.
- `knownAt` filtering applies to the history view; capsule candidate listing is present-time in
  v1.

## 16. Future extensions

MCP/A2A transport of evidence packets, real delegated tokens, SpiceDB/ReBAC, durable workflows,
source-native ACL rechecks, connector plane, hardened sandbox, signed evidence-pack export,
richer temporal storage. None are dependencies of this POC.

## 17. No-secrets statement

The `ARK_API_KEY` credential has never existed in this repository, its git history, its test
fixtures, its ledger records, or its demo output — verified by `git grep -F` over the tracked
tree and `git log -S` over the full history against the configured value. Credentials live only
in the gitignored `.env`. One caveat, stated plainly rather than averaged away: an `ARK_MODEL`
**endpoint identifier** (not a usable credential on its own — it authenticates nothing without
the API key) briefly existed in two historical commits; it was redacted from the tracked tree
the day it was found, and on **2026-09-01, before this repository went public, the identifier
was scrubbed from the entire git history** (`git filter-repo` string replacement to
`ep-REDACTED-HISTORICAL`; verified zero occurrences across all refs — the endpoint itself is
also retired). The pre-submission sweep additionally verified the API key never appeared in any
commit and greps tree and history for credential-shaped strings.

## 18. Feature-relevance map (reproducibility appendix)

The demo scenario is **"Launch Control Incident"** (beats B0–B7 — the stage cut in
`demo/DEMO-SCRIPT.md` and the judge-runnable long form in `demo/FULL-WALKTHROUGH.md`). This
table answers *"why is each capability useful, and where is it proven?"* —
it is a reproducibility index, not a scorecard; depth and coherence carry this submission, not
feature count. Feature numbers follow `docs/walnut/00-START-HERE.md`; invariant numbers follow
`docs/walnut/06-IMPLEMENTATION-TEST-DEMO-PLAN.md` §6.

| # | Capability | Failure it prevents | Where seen live (scenario beat) | Proof |
|---|---|---|---|---|
| F1 | Context Capsules | "we can't reconstruct what the model actually knew" | Overview capsule card + attestation (B3) | `context/capsule.test.ts` (INV-1, INV-7), `e2e.test.ts` |
| F2 | Per-agent authorization | one agent's access silently becomes every agent's access | Evidence tab ALLOW/DENY decisions (B3) | `auth/authorization.test.ts` (INV-1) |
| F3 | Delegated authority | an agent exceeds the human it acts for | payroll share attempt as `user:mehul` → `PRINCIPAL_SCOPE_MISSING` (B3 kicker) | `auth/authorization.test.ts` two-leg cases, `context/share-service.test.ts` |
| F4 | A2A re-authorization | access laundering through agent-to-agent handoff | `POST /api/evidence/:id/share/:target` — recipient re-checked (B4) | `context/share-service.test.ts` (INV-3) |
| F5 | Proof-carrying evidence | naked-prose knowledge reuse with no provenance | Evidence card: producer, source pointer, hash, citation (B1) | `evidence/evidence-store.test.ts`, `evidence-write-service.test.ts` (INV-4) |
| F6 | Mechanical citation verification | confident-but-wrong grounding | VERIFIED badge; bad-anchor proposal → `evidence.proposal_rejected` event (B1) | `context/citation-verifier.test.ts` (INV-5) |
| F7 | Runtime flight recorder | unobserved agent actions | `GET /api/runs/:id/events` + Evidence tab event sequence (B1) | `evidence/runtime-event-sink.test.ts`, `codex-event-adapter.test.ts` (INV-13, INV-14, INV-18) |
| F8 | Redact-before-persist | secrets fossilized in logs and ledgers | `redactionApplied` on every event; planted canaries absent (B1) | `evidence/redactor.test.ts` canary battery (INV-16) |
| F9 | Append-only hash-chained ledger | silent history edits | chain verify (B7) | `evidence/ledger.test.ts` tamper matrix (INV-15) |
| F10 | Pointer-not-copy privacy | observability becomes a sensitive-data lake | source pointer: locator/hash/offsets, never payload (B1) | `evidence/workspace-source` coverage in write-service tests |
| F11 | Dependency / proof graph | no map from a belief to its consequences | Dependencies tab (B4, B5) | `dependency/projector.test.ts` rebuild-from-source (INV-11) |
| F12 | Evidence lifecycle | corrections that overwrite the record | revoke (B2), supersede (B2), compromise (B5); all versions queryable | `evidence/evidence-write-service.test.ts` (INV-9) |
| F13 | Blast-radius analysis | unknown contamination scope after an incident | `/blast-radius` + TAINTED runs (B5) | `dependency/blast-radius.test.ts` (INV-12) |
| F14 | Selective reconciliation / Rewind | "recovery" that rewrites the past | RECONCILE → new run, `RECOVERED_BY`, old run intact; Comms deliberately left TAINTED (B6) | `dependency/reconciliation.test.ts` (INV-10) |
| F15 | Bi-temporal history | conflating "was true" with "we believed" | valid-time vs belief-time on the date claims (B2) | `context/temporal-resolver.test.ts` |
| F16 | Authorization history | unexplainable access decisions | decision nodes via `AUTHORIZED_BY` edges in Dependencies (B7) | capsule decision persistence in `capsule.test.ts` + `projector.test.ts` |
| F17 | Time-travel / known-at | hindsight bias in audits | History tab `knownAt` input (B7) | `routes/walnut-routes.test.ts` known-at cases |
| F18 | Deterministic derived verification | model prose certifying facts | attestation `changedArtifacts` before/after hashes; drift status (B4) | `evidence/workspace-artifacts.test.ts` (INV-19 drift visibility) |
| F19 | Evidence/Timeline/Dependencies/History UI | invisible middleware | the Walnut drawer + scenario proof rail, all tabs (throughout) | HC-2: every behaviour shown has a server-side test; UI renders live state only |
| F20 | Tamper verification | undetected record manipulation | `verify-tamper` on a corrupted **copy** — real chain untouched (B7) | `evidence/ledger.test.ts` + `e2e.test.ts` (INV-15) |
| F21 | Context lockfile / capsule export | irreproducible run context | `GET /api/runs/:id/attestation` (B3) | `routes/walnut-routes.test.ts` attestation cases |
| F22 | Clarification-first conflict handling | silently picking between contradictions | conflict-blocked run: typed question in `run.error`, open request at `/api/walnut/clarifications` — the request stays OPEN (no resolve route in v1, stated plainly) (B2) | `context/conflict-detector.test.ts`, `capsule.test.ts` (INV-22) |
| F23 | Evidence pack / offline verification | — | **absent** — cut per priority ladder; not stubbed | none claimed |

### Optional-evidence checklist (Track-1 brief §1.10)

- ✅ **Delegated permission scoped/revocable, enforced outside the UI** — the B3 share kicker:
  a scoped permission enforced in the real two-leg evaluator with no browser involved.
- ✅ **End-to-end Run produces a correlated trace** — per-run hash-chained ledger + capsule +
  attestation, all correlated by run id.
- ✅ **A defined threat blocked/contained, protected asset unchanged, recovery demonstrated** —
  compromised launch evidence is contained by tainting; the append-only historical record stays
  unchanged; recovery is a new Strategy run linked `RECOVERED_BY` (B5→B6).
- ✅ **Team-defined lifecycle capability works as described** — the evidence lifecycle
  (ACTIVE → REVOKED / SUPERSEDED / COMPROMISED) driving selective reconciliation.
