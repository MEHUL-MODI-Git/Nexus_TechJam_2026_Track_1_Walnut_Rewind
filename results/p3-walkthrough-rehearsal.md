# X1 walkthrough rehearsal — Launch Control Incident driven live end-to-end

**Date:** 2026-08-28 (~11:42–11:56 UTC) · **Path:** HTTP API against `npm run poc` (Colima
container runtime) · **Build:** post-X6 (`59567ba`+) — verified live by probing
`/api/runs/:id/events` before starting. **No browser was used; no UI claim is made here.**

State was reset per the committed pre-flight (walnut store + workspace `.walnut` dirs moved
aside as `*.bak-x1-rehearsal`, not deleted), then `scripts/walnut-demo-seed.sh` +
`walnut-demo-fixtures.mjs` seeded the deterministic fixtures.

## Cast (this rehearsal's real ids)

| | |
|---|---|
| Research Agent | `58509d3b-0218-41f4-8387-ace83e20b441` |
| Strategy Agent | `80170bd4-1348-47c9-862f-0b35d0eef0dd` |
| Comms Agent | `6563aaa4-a716-44b7-97a8-6258210dfe1d` |
| launch Oct-1 evidence | `ev_4e782a3b-5d78-42d3-86a0-8352973186f7` (VERIFIED → **REVOKED v2**) |
| payroll evidence (canary) | `ev_ec8fa60a-cec4-44f6-8fec-920c0b897e84` (ACTIVE, stored ≠ rendered) |
| launch Oct-15 evidence | `ev_f8ad6da3-778f-4c87-b305-844965e9c37c` (ACTIVE → **COMPROMISED v2**) |
| pricing original → replacement | `ev_59728fb1…` SUPERSEDED → `ev_34e65fbc…` ACTIVE |

## Beats and measured results

1. **B1 Research run** `3ae47595` — completed in 13 s, 94,356 in / 879 out tokens. Flight
   recorder (`GET /api/runs/:id/events`, X6): 20-event chain `ok:true`; seq 16
   `evidence.created` (launch, byte-VERIFIED); seq 17 `evidence.created` with the canary
   **redacted in the ledger copy** (`"[REDACTED] — payroll adjustment pool…"`,
   `redactionApplied: true`); seq 18 **`evidence.proposal_rejected`**
   `{reason: citation_mismatch, detail: "MISMATCH: quote did not exact-match content[28:61]…"}`;
   seq 19 `evidence.outbox_processed {acceptedCount: 2, rejectedCount: 1}` — exactly the seed's
   prediction.
2. **Pre-slip Strategy run** `617a182d` (an addition to the frozen beat list) — completed, 48,094 in / 916 out; capsule `cap_fc965d5b` 1 in / 1 denied.
   Narrative value: a decision taken on the then-trusted Oct-1 date, later precisely flagged.
3. **B2 date slip** — `stage-sidecars` then **server restart** (required: a running server
   holds evidence state in memory and does not see the fixture's direct disk writes — X2
   finding F-A below). Strategy run `40a47206` **failed pre-model** (usage `null`, zero model
   tokens), `run.error` = the typed question; `GET /api/walnut/clarifications` returned the full
   `ClarificationRequest` (`clar_65eae8de`, kind `evidence_conflict`, both options,
   `defaultOnTimeout: REFUSE`, `resolvedAt: null`). Remediation: revoke Oct-1 → REVOKED v2;
   the revoke's blast radius named exactly `cap_fc965d5b` + run `617a182d` + Strategy — nothing
   else.
4. **B3 Strategy run** `1f229e3d` — 57,537 in / 1,221 out; output opens *"Launch Date: October
   15"* citing the evidence id. Capsule `cap_473d3b6f`: **2 in** (Oct-15 + pricing
   replacement), **3 denied** — payroll `AGENT_SCOPE_MISSING` (decision `auth_4b0bf3f6`, policy
   revision 1 + hash pinned), Oct-1 (revoked), pricing original (superseded). **INV-2 live:**
   canary occurrences — run chain: 0; capsule file: 0; evidence store: present
   (stored ≠ rendered).
5. **F3 delegation kicker** — payroll share to Comms **as `user:mehul`** → `DENY /
   PRINCIPAL_SCOPE_MISSING` (sender decision recorded, no recipient check, no grants). Control
   without a principal → `ALLOW` — which **issued a real payroll consume grant to Comms**
   (foot-gun, X2 finding F-B); revoked live via
   `POST /api/agents/:id/grants/:grantId/revoke` → `txClosedAt` set, record preserved.
6. **B4 share + Comms run** — launch Oct-15 share → `ALLOW / AUTHORIZED` with sender decision,
   recipient pre-check decision, and issued grant id. Comms run `439519be` — 31,109 in / 543
   out; wrote `announcement.md` (Oct 15, SGD 69). Attestation: 2 consumed / 3 denied /
   6 commands / `changedArtifacts: ["announcement.md"]` / chain verified, 18 events.
   `walnut-demo-assert.mjs` exit 0 — the Comms capsule (`cap_0efdfd67`) provably contains the
   shared evidence id (an earlier suspicion that `/api/runs/:id/capsule` doesn't exist was
   **wrong** — withdrawn).
7. **B5 incident** — compromise Oct-15 → COMPROMISED v2. Blast radius: capsules
   `cap_0efdfd67` + `cap_473d3b6f`, runs `1f229e3d` + `439519be`, both agents, artifact
   `art_78d5350e` — and **not** the pre-slip run (already flagged by its own trigger; precision,
   not blanket).
8. **B6 rewind** — reconcile `1f229e3d` → `rec_b84e67cd`, replacement run `bd323c53`
   (completed): new capsule `cap_ee16e1db` **1 in / 4 denied** (compromised claim now
   status-denied). Old run: `RECOVERED`, capsule hash unchanged, 8-event chain still `ok:true`;
   `stateHistory` = TAINTED (`triggerEvidenceId` recorded) → RECOVERED (`byRunId: bd323c53…`).
   Comms run left TAINTED — selective by design.
9. **B7 audit** — `history?knownAt=11:54Z` (pre-incident): launch claim **ACTIVE v1**; without
   `knownAt`: **COMPROMISED v2**. Tamper: `{corruptSequence: 5}` → original `ok:true`,
   corrupted copy `ok:false, brokenAtSequence: 5, hash_mismatch`; plain verify afterwards
   `ok:true`. Clarification `clar_65eae8de` still OPEN (`resolvedAt: null`) — no resolve route
   in v1, narrated as such.

## Model budget actually spent

Research 94.4k/879 · pre-slip Strategy 48.1k/916 · B3 Strategy 57.5k/1,221 · Comms 31.1k/543 ·
reconcile replacement run (completed; tokens not separately captured here — visible on run
`bd323c53`). Conflict-blocked run: **zero** model tokens.

## Findings recorded for follow-up

- **F-A** `stage-sidecars` writes are invisible to an already-running server (in-memory
  json-file-state); the seed/fixture docs must require a server restart after staging (what
  this rehearsal did), or the fixture should write through the API.
- **F-B** A payroll share without a principal succeeds and issues a live consume grant to the
  recipient — correct behaviour, but a demo foot-gun; the walkthrough orders the beats so the
  positive control uses the launch evidence, and documents grant revocation as the recovery.
