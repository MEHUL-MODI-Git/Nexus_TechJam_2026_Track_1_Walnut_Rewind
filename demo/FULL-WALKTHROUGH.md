# Walnut Rewind — full judge-runnable walkthrough (Launch Control Incident)

Runs the "Launch Control Incident" demo scenario end-to-end and shows **capabilities F1–F22 live
or by cited test** (README §18 map) in story order — **F23 (evidence-pack export) is cut and
absent**, stated honestly in §10. Every expected output below was captured from a real
end-to-end rehearsal on 2026-08-28 — evidence with real ids and token counts:
`results/p3-walkthrough-rehearsal.md`. Time: ~15 minutes; model cost: 4–5 real runs
(~230–290k Ark input tokens measured); the conflict-blocked run costs **zero** model tokens.

Conventions: `$BASE` = `http://localhost:3000`. Ids differ per seed — capture them as you go
(each step says which). Steps are API-driven and self-verifying; **UI pointers name where the
same state is visible in the drawer, but no browser output is asserted here** (the drawer
rendering was verified separately in the 2026-08-31 real-Chrome visual pass,
`results/p2-visual-pass.md`). F-numbers = feature map, README §18.

## 0. Pre-flight (once)

```bash
# 1. Clean slate — move aside, don't delete (recoverable, same procedure as the stage script)
TS=$(date +%Y%m%d-%H%M)
mv "$HOME/.volc-agent-launchpad/data/walnut" "$HOME/.volc-agent-launchpad/data/walnut.bak-$TS" 2>/dev/null
for d in "$HOME/.volc-agent-launchpad/workspaces"/*/.walnut; do mv "$d" "$d.bak-$TS" 2>/dev/null; done
# 2. Start the platform (one command; needs ARK_API_KEY / ARK_MODEL, e.g. via .env)
npm run poc          # wait for /api/health = 200; /api/system must show "arkModel": null
# 3. Seed agents, deterministic fixtures, grants (idempotent; spends no model quota)
./scripts/walnut-demo-seed.sh    # prints the three agent ids — export them:
#   RESEARCH=… STRATEGY=… COMMS=…
```

## 1. B0 — baseline intact (HC-1)

`GET $BASE/api/agents` lists the seeded agents; the Playground chats normally. Walnut is
additive middleware — `git diff starter-kit-baseline --stat` is the receipt.

## 2. B1 — Research run: truth intake (F5, F6±, F7, F8, F10)

```bash
R1=$(curl -sS -X POST $BASE/api/agents/$RESEARCH/messages -H 'Content-Type: application/json' \
  -d '{"content":"Inspect the staged Aurora source files and report that the evidence outbox is ready. Do not modify .walnut/outbox.json."}' \
  | jq -r '.run.id')
# poll until completed (rehearsed: 13 s):
until [ "$(curl -sS $BASE/api/runs/$R1 | jq -r '.run.status')" = "completed" ]; do sleep 2; done
curl -sS $BASE/api/runs/$R1/events
```

**Expect** (rehearsed values): `chain.ok: true`; an `evidence.created` for the launch claim
(byte-VERIFIED, F6); an `evidence.created` for the payroll claim whose ledger copy reads
`"[REDACTED] — payroll adjustment pool…"` with `redactionApplied: true` (F8 — the canary is in
the evidence *store*, deliberately: stored ≠ rendered); an **`evidence.proposal_rejected`**
with `reason: "citation_mismatch"` and a byte-range detail like
`content[28:61]` (F6 negative — the model claimed grounding, the middleware refused); and
`evidence.outbox_processed {"acceptedCount": 2, "rejectedCount": 1}`. The full event list is
the flight recorder (F7). `GET /api/runs/$R1/evidence` → capture the two evidence ids:
`EV_OCT1` (launch), `EV_PAYROLL`. Each carries producer, source pointer
(locator/hash/offsets — pointer, not payload, F10), citation, scopes (F5).
*UI pointer: drawer → Evidence tab on this run.*

## 3. Optional enrichment — act on the trusted date

Run Strategy once **before** the slip (`"Summarize the approved Aurora launch plan."`) →
capsule 1 in / 1 denied. This run will later be flagged by the *revocation's* blast radius and
nothing else — precision worth showing. Skip to save one model run.

## 4. B2 — the date slips: conflict → typed clarification (F22, F12, F15)

```bash
node scripts/walnut-demo-fixtures.mjs stage-sidecars \
  --research-agent-id $RESEARCH \
  --research-workspace "$HOME/.volc-agent-launchpad/workspaces/$RESEARCH"
# capture conflictEvidenceId → EV_OCT15, superseded/replacement pricing ids
# ⚠ REQUIRED: restart the server now (stop, `npm run poc` again). A running server holds
#   evidence state in memory and will NOT see these staged records (finding F-A).
R2=$(curl -sS -X POST $BASE/api/agents/$STRATEGY/messages -H 'Content-Type: application/json' \
  -d '{"content":"Summarize the approved Aurora launch plan."}' | jq -r '.run.id')
sleep 2 && curl -sS $BASE/api/runs/$R2 | jq '.run | {status, usage, error}'
```

**Expect:** R2 → `status: "failed"`, `usage: null` (**blocked before any model call — zero
tokens**), `error: "Conflicting evidence for project:aurora launch_date: which should be
used?"`. `GET /api/walnut/clarifications` → one OPEN typed request: both claims as options,
`allowNoneOfAbove: true`, `defaultOnTimeout: "REFUSE"`, `resolvedAt: null` (F22 — no silent
pick, ever). The staged pricing pair already shows **SUPERSEDED → ACTIVE** at
`GET /api/evidence/$EV_PRICING_OLD` (F12); the two date claims carry different `validFrom`
values — valid-time vs the belief-time you are watching change (F15).

**Remediation** (conflict, not the request — the request has no resolve route in v1 and stays
OPEN; say so):

```bash
curl -sS -X POST $BASE/api/evidence/$EV_OCT1/revoke -H 'Content-Type: application/json' \
  -d '{"reason":"Launch date moved to October 15 — the October 1 claim is stale"}'
```

**Expect:** `status: REVOKED, version: 2` (append-only — v1 still queryable), and a blast
radius naming **only** what actually consumed Oct-1 (in the rehearsal: exactly the optional
step-3 run and its capsule).

## 5. B3 — Strategy under least privilege + the delegation kicker (F1, F2, F3, F16, F21)

```bash
R3=$(curl -sS -X POST $BASE/api/agents/$STRATEGY/messages -H 'Content-Type: application/json' \
  -d '{"content":"Summarize the approved Aurora launch plan, including the launch date and price."}' | jq -r '.run.id')
until [ "$(curl -sS $BASE/api/runs/$R3 | jq -r '.run.status')" = "completed" ]; do sleep 2; done
curl -sS $BASE/api/runs/$R3/walnut        # capsule card (F1); capture CAP3
curl -sS $BASE/api/runs/$R3/attestation   # the run's lockfile (F21)
```

**Expect:** output cites October 15 **by evidence id**; capsule **2 in / 3 denied** — payroll
`AGENT_SCOPE_MISSING`, Oct-1 `EVIDENCE_REVOKED`, old pricing `EVIDENCE_SUPERSEDED` — every
decision recorded with `policyRevision` + `policyHash` (F2, F16). **INV-2 check** (rehearsed:
0/0/present):

```bash
grep -c WALNUT_CANARY_DENIED_PAYROLL_93c1e7 \
  "$HOME/.volc-agent-launchpad/data/walnut/evidence/$R3.ndjson" \
  "$HOME/.volc-agent-launchpad/data/walnut/capsules/$CAP3.json"          # both 0
grep -rl WALNUT_CANARY_DENIED_PAYROLL_93c1e7 \
  "$HOME/.volc-agent-launchpad/data/walnut/evidence/evidence-store.json" # present — stored ≠ rendered
```

**The kicker (F3):** Strategy holds a payroll **share** grant. Acting for `user:mehul` (who
holds nothing):

```bash
curl -sS -X POST $BASE/api/evidence/$EV_PAYROLL/share/$COMMS -H 'Content-Type: application/json' \
  -d "{\"fromAgentId\":\"$STRATEGY\",\"principalId\":\"user:mehul\"}"
```

**Expect:** `{"result":"DENY","reasonCode":"PRINCIPAL_SCOPE_MISSING", …}` — the agent's own
grant could not exceed its human's authority. ⚠ Do **not** run this without the principal as a
"control": it will ALLOW and issue Comms a live payroll grant (finding F-B); if you do, revoke
it: `POST /api/agents/$COMMS/grants/$GRANT_ID/revoke` — the grant closes bitemporally
(`txClosedAt` set, record preserved).

## 6. B4 — A2A share + the Comms run (F4, F18, F11)

```bash
curl -sS -X POST $BASE/api/evidence/$EV_OCT15/share/$COMMS -H 'Content-Type: application/json' \
  -d "{\"fromAgentId\":\"$STRATEGY\",\"principalId\":null}"
# Expect ALLOW/AUTHORIZED with senderDecisionId + recipientDecisionId + issuedGrantIds (F4)
R4=$(curl -sS -X POST $BASE/api/agents/$COMMS/messages -H 'Content-Type: application/json' \
  -d '{"content":"Read COMMS_TASK.md in your workspace and complete it exactly. Use only the launch evidence in your Walnut context capsule."}' | jq -r '.run.id')
until [ "$(curl -sS $BASE/api/runs/$R4 | jq -r '.run.status')" = "completed" ]; do sleep 2; done
node scripts/walnut-demo-assert.mjs --run-id $R4 --evidence-id $EV_OCT15   # exit 0 required
curl -sS $BASE/api/runs/$R4/attestation
```

**Expect:** the assert proves the Comms capsule contains the shared evidence id (this is the
precondition for narrating two-run taint). Attestation: `changedArtifacts:
["announcement.md"]` with before/after hashes — a derived fact from runtime evidence, not model
prose (F18). `GET /api/runs/$R4/dependencies` now spans agents → runs → capsules → evidence →
the artifact (F11). *UI pointer: Dependencies tab.*

## 7. B5 — the incident (F13, F12, F11)

```bash
curl -sS -X POST $BASE/api/evidence/$EV_OCT15/compromise -H 'Content-Type: application/json' \
  -d '{"reason":"source integrity incident: date-slip.txt found tampered at origin"}'
```

**Expect:** `COMPROMISED, version: 2`; blast radius listing **both capsules, both runs
(R3 + R4), both agents, and the announcement artifact** — reached via evidence → capsule → run;
the artifact via its derivation edge (never artifact → run back-propagation). The optional
step-3 run is *not* re-flagged: precision, not blanket. Run states: `GET /api/runs/$R3/walnut`
→ `TAINTED` (with `triggerEvidenceId` in its history), same for R4.

## 8. B6 — Rewind: selective recovery (F14)

```bash
curl -sS -X POST $BASE/api/runs/$R3/reconcile -H 'Content-Type: application/json' -d '{}'
# → reconciliationId, replacementRunId R5; poll R5 to completion (a real model run)
```

**Expect:** R5 capsule **1 in / 4 denied** — the compromised claim is now *status-denied*;
old run R3 → `RECOVERED`, its capsule hash and 8-event chain **byte-identical** (verify:
`POST /api/runs/$R3/verify-tamper {}` → `ok: true`); history shows
`TAINTED → RECOVERED, byRunId: R5` (F14, INV-10). **R4 stays TAINTED on purpose** — selective
reconciliation shows you what still needs rebuilding; reconcile it too only if you budget the
extra model run.

## 9. B7 — audit close (F17, F16, F9, F20, F19)

```bash
# what did the platform believe BEFORE the incident? (use a pre-compromise timestamp)
curl -sS "$BASE/api/runs/$R3/history?knownAt=<pre-incident-ISO>"   # launch claim: ACTIVE v1 (F17)
curl -sS "$BASE/api/runs/$R3/history"                              # now: COMPROMISED v2
# why was the evidence allowed in R3? — the recorded decision, policy revision + hash (F16)
curl -sS $BASE/api/runs/$R3/evidence      # each ref carries authorizationDecisionId
# tamper-evidence on a corrupted COPY — the real chain is never touched (F20, F9)
curl -sS -X POST -H 'Content-Type: application/json' -d '{"corruptSequence":5}' \
  $BASE/api/runs/$R3/verify-tamper
# → original ok:true; corrupted ok:false, brokenAtSequence:5, hash_mismatch
curl -sS $BASE/api/walnut/clarifications   # the request is still OPEN — v1 has no resolve route
```

*UI pointer (F19): the four drawer tabs + the scenario proof rail carry every state above live;
that rendering was verified in the 2026-08-31 real-Chrome visual pass
(`results/p2-visual-pass.md`), not asserted here.*

## 10. What is deliberately NOT shown live

- **Ceiling-survives-transfer** — the live default policy has no classification ceiling; the
  property is proven by its INV-3 test (`context/share-service.test.ts`), cited, not staged.
- **Grant revocation as a headline** — demonstrated only as the F-B recovery above;
  proof-map-only per the frozen scenario.
- **F23 evidence pack** — absent; cut per the priority ladder. Not stubbed.
