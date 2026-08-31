# Demo rehearsal + recording record — 2026-09-01 (00:20–01:40 SGT)

**What actually happened, stated plainly — the rehearsal record behind the recorded demo.**

The demo was **not** performed as one continuous timed pass. It was rehearsed and recorded by
the presenter as **moment-by-moment segments** (following `demo/DEMO-SCRIPT.md`),
with the live state rebuilt between takes (documented move-aside backups
`~/.volc-agent-launchpad/data/walnut.bak-*`). The ≤3:00 total duration is enforced at the
CapCut edit, where the segments are spliced and dead waits trimmed; the exported video's
runtime is the timing evidence. The narration was parser-word-counted during scripting
(final core ≈ 350 words ≈ 2:25 at 145 wpm) to guarantee the cap is reachable.

## Every scripted beat passed live during the takes

| Beat | Live result |
|---|---|
| B1 Research run | completed; launch claim ACTIVE, payroll RESTRICTED/ACTIVE, REJECTED PROPOSAL 3 `citation_mismatch` with byte range; CHAIN VERIFIED |
| B3 Strategy run | completed; capsule 1 allowed · 1 denied; answer cites October 1 |
| B5 Compromise (in-UI button) | evidence → COMPROMISED v2; blast radius = exactly 1 run; Strategy run → TAINTED |
| B6 Reconcile (in-UI button) | replacement run completed; old run → RECOVERED; REWIND cell "1 replacement"; replacement answer refuses to repeat the compromised date |
| Tamper (terminal) | `corrupted.ok:false / brokenAtSequence:9 / hash_mismatch`; `original.ok:true` |

## Real findings surfaced by the rehearsal takes (and their outcomes)

1. **Ark free-tier quota exhaustion mid-take** (`SetLimitExceeded`, DeepSeek-V3.2) — resolved by
   activating fresh models (V4-Flash, then V4-Pro for headroom) and switching `ARK_MODEL`
   endpoints; a backup endpoint is documented in `.env` (gitignored).
2. **Double-click on Reconcile returns 409 "Conflict"** — correct designed behavior (recovery is
   not a rerun button; README §13), but surprising live; the cheat sheet now says "click once."
3. **Reconcile's replacement answer required a manual page refresh to appear** — fixed the same
   night: WalnutDrawer bubbles `onReconciled`, App watches the replacement
   run without hijacking the drawer, chat refreshes on completion. `npm run check` 233/233.
4. **Script/UI mismatches caught by the presenter** (VERIFIED chip location, "REJECTED PROPOSAL 3"
   linkage, flight-recorder meaning) — narration and cheat sheet corrected against the live
   screen; two optional UI clarity captions were queued as follow-ups.

## What this record does NOT claim

No single uninterrupted ≤3:00 stage performance was executed. If a live on-stage demo is later
required (vs the recorded video), one full continuous pass should be timed first.
