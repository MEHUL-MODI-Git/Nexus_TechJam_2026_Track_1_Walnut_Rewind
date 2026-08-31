# P3 demo rehearsal — first end-to-end execution of `demo/DEMO-SCRIPT.md`

**Date:** 2026-08-28 · **Path:** live local container (Colima/Docker 29.5.2),
production build, real Ark model runs.

**Scope of this rehearsal — read this before citing it.** Every beat was driven through the
**HTTP API against the running server**. This proves the backend/Runtime path (HC-2). It does
**not** prove the browser UI: no page was rendered, no tab clicked, no visual state observed.
**The live visual pass was performed separately** (`results/p2-visual-pass.md`).

## Setup

Server restarted on the current build before starting. The previously running process (PID 88219,
started 27 Aug 20:52) predated the R-02 fix (commit `3290e79`, 21:57) and was still serving the
configured endpoint id from `/api/system`. After restart: `"arkModel": null` — **R-02 confirmed
fixed on the live path**, and the stale process was the only reason it appeared exposed.

## Runs executed (3 real model runs)

| Run | Agent | Id | Result | Usage |
|---|---|---|---|---|
| Research | Research Agent | `3bd4967b` | completed | 47,702 in / 648 out |
| Strategy | Strategy Agent | `985d996b` | completed | 30,699 in / 576 out |
| Replacement (reconcile) | Strategy Agent | `62800947` | completed | — |

## Beat-by-beat result

| Demo beat | Result | Evidence |
|---|---|---|
| Evidence produced through outbox, citation byte-verified | ✅ | 2 records ACTIVE; `citationVerification: "VERIFIED"` |
| Model never writes evidence directly (INV-4) | ✅ | both minted by `processOutbox` from `.walnut/outbox.json` |
| Authorization before context; payroll DENIED | ✅ | capsule `cap_3006d4d6`: allowed 2, denied 1 |
| **INV-2 canary absent from what the model saw** | ✅ | see below |
| Capsule sealed with hash | ✅ | `sha256:8acb10a4…95afd6`, `transactionCut: ledger:3` |
| Compromise → append-only v2 | ✅ | v1 retained, v2 `COMPROMISED` |
| Blast radius | ✅ | capsule + run + agent identified |
| Run tainted | ✅ | `walnutRunState: TAINTED` |
| Reconcile → new run, compromised evidence denied | ✅ | replacement capsule: allowed **1**, denied **2** |
| Old run RECOVERED and untouched | ✅ | still 17 events, same capsule hash, `RECOVERED_BY` recorded |
| Chain verification | ✅ | run 17/8/18 events + governance 6, all `ok: true` |
| Tamper detection | ✅ | corrupted copy `ok:false`, `brokenAtSequence: 9`, `reason: "hash_mismatch"`; real chain still `ok:true` |

### INV-2 verified live (HC-5)

The canary `WALNUT_CANARY_DENIED_PAYROLL_93c1e7` was found **only** where it must be:
the source file, the Research run's own outbox/session/prompt record, and the evidence store
(stored ≠ rendered). It was found **zero times** in:

- the Strategy capsule `cap_3006d4d6…json` (1905 bytes, exists, holds 2 evidence refs and the
  denied decision id) — it does not even reference the payroll `evidenceId`, only
  `deniedEvidenceDecisionIds: ["auth_dea02118…"]`;
- the Strategy run's 17-record ledger chain (zero canary hits, zero `"Payroll run for October"` hits);
- the Strategy run record in `launchpad.json` — prompt, output, everything.

Absence is meaningful here because the files exist and demonstrably contain this run's data.

## Blocking findings (must fix before the demo is performed)

### F-1 — Accumulated state breaks the script's numbers AND its narration

The Strategy capsule consumed **two** launch claims, not one:

- `ev_7408df89` — *"Launch date is September 14."* — leftover from a 2026-08-27 session
- `ev_e961aa72` — *"The launch date is October 1."* — produced by this rehearsal

The script says *"1 evidence in, 1 denied"*. Live it was **2 in, 1 denied**. Worse, the model's
answer opens:

> "The file doesn't exist in the workspace. Looking at the evidence in the Walnut context, I can
> see there are conflicting claims about the launch date from two different sources…"

That is *correct behaviour* — and it is a bad opening line for the demo's money moment. The
`failedStepCount: 1` on this run is the same cause: the Strategy Agent tried to read
`launch-plan.txt` in its own workspace, where it does not exist.

**Fix:** the demo needs a documented state reset before the run, or a scripted expectation of
the accumulated counts. There is currently **no reset procedure in the repo**.

### F-2 — `verify-tamper` silently no-ops without a parameter

`POST /api/runs/:id/verify-tamper` with `{}` returns a plain `{ok, eventCount}` — it looks like
the tamper demo ran and found nothing. The corrupt-copy behaviour requires
`{"corruptSequence": N}`. The script says "with a corrupt sequence" but never gives the body.

**Fix:** put the literal request in the script.

### F-3 — A stale server serves pre-fix behaviour

Demoing from an already-running server can show pre-remediation output (as it did here with
`arkModel`). The script must instruct a restart on the current build.

## Not covered

- **Browser/visual pass** — not performed; still open.
- The 3-minute timing was not measured (API driving is not stage pacing).
