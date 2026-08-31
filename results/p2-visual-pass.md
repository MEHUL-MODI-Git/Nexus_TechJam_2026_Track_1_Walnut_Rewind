# P2/P3 live visual pass — four Walnut tabs + baseline, real browser render

**Date:** 2026-08-31
**Method:** real Chromium render — Google Chrome 152.0.7977.64 (installed desktop Chrome, launched
headless via `playwright-core` `channel: "chrome"` from a scratch dir **outside** the repo; no new
repo dependency, HC-11 intact). Viewport 1440×900. Driver script preserved at
`/tmp/walnut-visual/drive.mjs` (not tracked; disposable).
**Build under test:** commit `bb20c02`, production build via `npm run poc` (Colima docker context,
server `http://localhost:3000`, `/api/health` 200). Data = the persisted Launch Control Incident
state from the 2026-08-28 X1 rehearsal (`results/p3-walkthrough-rehearsal.md`) — live stores, not
mocks. **Model spend: one deliberate probe run** (Phase C below); everything else zero quota.

## Verdict

**PASS — every gate item that a browser can verify, verified. Zero console errors, zero failed
HTTP requests (no 4xx/5xx) across the entire pass.** What this does NOT cover: the **timed ≤3-min
rehearsal through the UI by a human** — performed later the same night
(`results/p3-timed-rehearsal.md`).

## What was driven and seen (24 screenshots, `results/visual-pass-2026-08-31/`)

### Phase A — baseline + four tabs × three scenario agents (shots 01–16)
- **01** Agents list renders; sidebar 6 agents; runtime card says "Ark endpoint configured ·
  docker" — **endpoint id not shown** (HC-4).
- **Research Agent (02–06):** Playground history renders (real rehearsal messages). Walnut drawer:
  **Overview** — capsule id/hash, policy revision, `chain verified (20 events)`, attestation grid
  (20 events / 13 runtime / 8 commands / 5 redactions), route line reads **"Ark endpoint hidden"**,
  Verify chain + Reconcile buttons. **Evidence** — produced records with lifecycle chips
  (REVOKED / RESTRICTED+ACTIVE), the payroll canary visible in *store* view by design
  (stored ≠ rendered, per walkthrough), **REJECTED PROPOSAL 3 · citation_mismatch** with byte-range
  detail `content[28:61]`, flight recorder CHAIN VERIFIED. **Dependencies** — full projected graph:
  15 runs with status chips, 5 capsules, evidence in all lifecycle states (ACTIVE / REVOKED /
  SUPERSEDED / COMPROMISED), sources, ~40 authorization decisions with reason codes
  (AGENT_SCOPE_MISSING, GRANT_EXPIRED, PRINCIPAL_SCOPE_MISSING, EVIDENCE_REVOKED/SUPERSEDED/
  COMPROMISED), agents, versions, principals, artifacts, edge-type chips; honest note
  "3 dangling reference(s) skipped while building this graph". **History** — known-at datetime
  picker, effective known-at echo, run state CLEAN, evidence-known-at-this-instant list.
- **Strategy Agent (07–11):** latest run = the post-rewind recovery run `bd323c53…` — proof line
  shows **1 replacement**, 1 allowed · 4 denied, `chain verified (8 events)`. **Evidence** —
  consumed record carries **VERIFIED** byte-match chip + content hash; "This run published no
  evidence"; "4 candidate(s) denied — decision ids recorded in the capsule".
- **Comms Agent (12–16):** **Overview shows RUN STATE TAINTED** with the blast-radius proof cell
  red ("TAINTED"), 2 consumed · 3 denied, changed artifact `announcement.md`, chain verified
  (18 events).
- **X7 ScenarioRail** ("LIVE CASE 01 · The Aurora Launch" proof line) is mounted and fully live on
  every drawer — all six proof cells derive from the selected run (values differ per agent:
  Research CLEAN/20 events, Strategy 1 replacement, Comms TAINTED, probe 0 evidence). Not a
  static mock. **X5 clarification callout** not exercised (no OPEN clarification attached to the
  latest runs; the rehearsal's request predates them) — no claim made.

### Phase B — Agent CRUD (17, 18, 24) — HC-1
- Create modal opens, form fills, **"Visual Pass Probe" created** and appears in sidebar (7
  agents) with container session connected (18).
- Delete (native confirm accepted) — probe **gone from sidebar**, back to 6 agents (24).

### Phase C — live Playground run through the browser (19–23) — HC-1 + HC-2 path
- Prompt sent through the composer; the run executed **for real** (container runtime + Ark);
  reply rendered in the Playground: **"visual pass ok."** (20).
- The drawer on this *fresh live run* assembled from live state, not fixtures: 0 allowed ·
  5 denied, run state CLEAN, `chain verified (8 events)`, attestation with 5 runtime events /
  1 redaction, route "Ark endpoint hidden" (21–23). This is the middleware executing in the
  backend path with the UI merely rendering it (HC-2).

## Secret sweep of the frames (HC-4)
No Ark key, no `ep-` endpoint id, no bearer token in any frame. The only sensitive-looking string
is the **planted canary label** `WALNUT_CANARY_DENIED_PAYROLL_93c1e7` in the evidence-store view —
deliberate and documented (the INV-2 claim is *rendered context*, and the Strategy capsule/chain
contained zero occurrences in the backend rehearsal).

## Findings
- **No blocking defect.** 0 console errors, 0 failed requests, no blank frame, no broken layout at
  1440×900.
- **Note (demo hygiene, not a defect):** the sidebar also shows `Website builder`,
  `Walnut P1 Exit Smoke`, `Walnut Phase 0 Acceptance` from earlier phases. For the stage demo,
  deleting them (or narrating past them) would tighten the frame.
- **Note:** the Dependencies "3 dangling reference(s) skipped" line is the honest-signal
  path working; worth citing rather than letting a reviewer discover it.
