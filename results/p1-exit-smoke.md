# P1 exit smoke — live container run with capsule + verified chain (2026-08-27)

Production POC (`npm run poc`), Docker on Colima,
real Ark credentials from the gitignored `.env`. All output below reproduced from the live system;
IDs are real, secrets redacted at source by the running redactor (not post-edited).

## System

`GET /api/system`: `arkConfigured: true`, `codexAvailable: true`, `runtimeProvider: "container"`,
`containerEngine: "docker"`, `codexSandboxMode: "danger-full-access"` (inside the disposable
container boundary — not claimed as hardened isolation, HC-8).

## Run

- Agent `6936db12-ef35-4791-acad-e1388f3794c7` ("Walnut P1 Exit Smoke") created via API.
- Run `105197f3-974f-4993-b343-1dfdd9b8e0cd`, prompt `Reply with exactly: P1_SMOKE_OK`
  → status `completed`, output exactly `P1_SMOKE_OK`.

## Capsule (spec 003 §A)

- `GET /api/runs/<runId>/capsule` → 200: `cap_fd6e3a95-b839-4a53-a844-d62a6e8ec9e0`,
  `schemaVersion: 1`, `policyRevision: 1` + `policyHash` (INV-20), `evidence: []`,
  `deniedEvidenceDecisionIds: []`, `transactionCut: "ledger:0"`, `capsuleHash` present.
  Empty capsule is honest: `EmptyEvidenceRepository` is the labelled Phase-1 stand-in — no
  evidence ingestion exists until P2-E1/E2.
- Unknown-but-valid run UUID → 404 `{"error":"No capsule for this run"}`. Non-UUID id → 500 via
  the same zod `runIdParams` schema upstream `GET /api/runs/:id` uses — baseline-consistent.

## Ledger (spec 002)

Chain `~/.volc-agent-launchpad/data/walnut/evidence/<runId>.ndjson`, 8 records:

```
1:run.requested  2:capsule.finalized  3:runtime.event(runtime.thread)
4:runtime.event(runtime.error)  5:runtime.event(runtime.turn started)
6:runtime.event(runtime.message)  7:runtime.event(runtime.turn completed)  8:run.completed
```

- `verifyChain(runId)` → `{"ok":true,"eventCount":8}`; `verifyChain("_governance")` →
  `{"ok":true,"eventCount":0}` (no governance events yet — grant wiring is a tracked gap).

## Redaction / secret absence (HC-4, INV-16) — live, not simulated

- Record 4 is the real Codex CLI metadata diagnostic that embeds the configured endpoint ID.
  Persisted form: `safeSummary: "Model metadata for \`[REDACTED]\` not found. ..."`, receipt
  `{applied: true, categories: ["env_value"], replacementCount: 1}` — the same leak vector that
  forced sanitization of the P0-6 fixture, this time caught at persist time by the running
  redactor.
- `grep -F` of the configured `ARK_API_KEY` and `ARK_MODEL` values over the chain file and all
  capsule files: zero matches.
- The user prompt text does not appear in the chain; `run.requested` carries `promptHash` only.

## Test-suite state at this smoke

`npm run check` exit 0; server tests 12 files / 93 tests green (commit `fbb2fb2`).

## Honesty notes

- The capsule is empty because no evidence exists to authorize — INV-1/INV-2 behaviour with real
  candidates is proven by `capsule.test.ts` (denied-canary fixtures) until Phase 2 ingestion.
- `/api/system` (upstream baseline) returns the raw `arkModel` endpoint ID to authenticated
  callers; demo screenshots must avoid it (P3 pre-submission sweep item).
- We do not claim every physical ModelArk request/retry is observed, nor that JSONL is a
  pre-command enforcement boundary (HC-8).
