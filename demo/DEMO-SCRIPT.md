# Walnut Rewind — 3-minute demo script (X4, revised for the frozen scenario)

**This is the 3-minute stage cut of the "Launch Control Incident" demo scenario, spine
B0 → B1 → B3 → B5 → B6 → tamper → close.** It is written to be **recorded**: every beat says
what to SAY (plain words), what to DO (exact clicks/commands), and what to EXPECT on screen.

**Rehearsal status — read before citing.** The backend path passed end-to-end on 2026-08-28
(`results/p3-demo-rehearsal.md`); the full scenario passed end-to-end on 2026-08-28
(`results/p3-walkthrough-rehearsal.md`); the live UI passed a real-Chrome visual pass on
2026-08-31 — all four tabs, live Playground run, 24 screenshots, 0 console errors
(`results/p2-visual-pass.md`). **The timed ≤3-minute run-through has not been performed yet** —
pre-flight step 9 below *is* that rehearsal.
Values below marked **(m)** were measured in a cited rehearsal; values marked **(d)** are
derived for the clean-seed stage state and must be confirmed at the timed dry run.

**Budget:** one Research run + one Strategy run + one reconcile run per pass. Measured range
across the two rehearsals: **~85k–150k Ark input tokens per full pass**. Plan two passes
(dry run + recording) ≈ 170k–300k.

---

## Screen setup (before anything)

- **Browser** at `http://localhost:3000`, window ≈ 1440×900 (the visual-pass-verified
  viewport), 100% zoom, bookmarks bar hidden, no extra tabs, devtools closed.
- **Terminal** beside/below it, large font. It appears on camera **once** (the tamper beat) —
  deliberate: the middleware is not the UI. Compromise runs through the in-UI button, which
  calls the identical REST route (HC-2 enforced server-side either way).
- **No slides on camera.** The recording is demo-only: the rubric's biggest weight is live
  end-to-end behavior. All labels, feature names, and the end card are added **afterwards in
  CapCut** — see the Post-production section at the bottom. The deck
  (`demo/slides/index.html`) stays in the repo for judge Q&A only.
- Recording at 1080p or better so JSON in the terminal is legible. Record the **raw screen +
  your live narration in one take** exactly as scripted; leave the framing static (no zooms
  while recording — add any zoom/highlight in CapCut so a failed take costs nothing).

## Pre-flight — do all nine, in order (1–3 and 8 each come from a real rehearsal failure)

1. **Stop any running server** (F-3, `results/p3-demo-rehearsal.md`: a stale process serves
   pre-fix behaviour — in rehearsal it exposed the endpoint id from `/api/system`).
2. **Reset the Walnut state — move aside, don't delete** (F-1: accumulated state breaks the
   script's counts *and* its narration):
   ```bash
   TS=$(date +%Y%m%d-%H%M)
   mv "$HOME/.volc-agent-launchpad/data/walnut" "$HOME/.volc-agent-launchpad/data/walnut.bak-$TS" 2>/dev/null
   for d in "$HOME/.volc-agent-launchpad/workspaces"/*/.walnut; do mv "$d" "$d.bak-$TS" 2>/dev/null; done
   ```
3. **Start on the current build and verify it:** `npm run poc`, wait for
   `curl -s localhost:3000/api/health` → `{"ok":true,…}`, then confirm
   `curl -s localhost:3000/api/system` shows `"arkModel": null` (R-02 check).
4. **Tighten the frame:** in the sidebar, delete every non-scenario agent left over from
   earlier phases (in the visual pass these were `Website builder`, `Walnut P1 Exit Smoke`,
   `Walnut Phase 0 Acceptance`). Delete the three old demo agents too — the reseed recreates
   them with **empty chat histories**, which is what you want on camera.
5. **Seed:** `./scripts/walnut-demo-seed.sh` — idempotent, spends no model quota, prints the
   three agent ids and the grants it issued (Strategy gets `project:launch:*` consume — never a
   payroll consume grant).
6. **Prime the terminal** (one paste, off camera):
   ```bash
   BASE=http://localhost:3000
   RESEARCH=<id printed by the seed>       # only RESEARCH is needed on camera
   ```
7. **Browser sanity glance:** sidebar shows exactly the three scenario agents; Playground
   opens; no console errors.
8. **Do NOT run `stage-sidecars`.** The conflict/supersession sidecars are Tier-2
   (walkthrough) material; staging them changes every count below **and** requires a server
   restart to become visible (finding F-A, `results/p3-walkthrough-rehearsal.md`).
9. **TIMED DRY RUN — mandatory.** Run the whole script once against a stopwatch, confirm every
   **(d)** value, note where you stand at 1:30 and 2:30, then repeat pre-flight steps 1–7 and
   record. Record the measured time and any count corrections in
   `results/p3-timed-rehearsal.md`.

---

> **Narration budget:** the core SAY blocks
> total **~350 spoken words** (~2:25 at 145 wpm), leaving ~35 s of pure air inside the hard
> 3:00 cap — workable because most narration overlaps the model-run waits; the timed dry run
> is the check. Each feature line now states its purpose in plain words for a zero-context
> viewer (why citations stop made-up facts, why authorize-before-prompt stops leaks). The
> optional stretch beat adds 15 words; earlier drafts are in git history.
> Written for a viewer who has **never heard of this project** — every term is explained the
> first time it appears.

## 0:00–0:15 — B0 · Baseline + hook

**SAY:** *"This is TikTok's Agent Launchpad — AI agents running real tasks. We built the safety
layer it's missing: Walnut Rewind. It controls what an agent is allowed to know, proves it, and
repairs the damage when a fact turns out to be wrong. Here's one incident, end to end."*

**DO:** Show the agents list and the three scenario agents. Nothing to click yet.

## 0:15–0:55 — B1 · Research run: evidence you can trust

**SAY (while it runs):** *"You've seen AI confidently make facts up — hallucination. Here, that
can't happen: nothing is saved as a fact unless the agent shows exactly where in the source
file it read it — and the middleware checks that quote against the file, character by
character. The launch date checked out — verified. This third claim isn't in the file at all —
rejected, no matter how confident the model sounded."*

**DO:** Open **Research Agent → Playground**, send (seeded prompt):
`Inspect the staged Aurora source files and report that the evidence outbox is ready. Do not modify .walnut/outbox.json.`
Rehearsed completion: ~13 s **(m)**. When it completes, open the run's **Walnut drawer →
Evidence tab**.

**EXPECT / SHOW** (corrected 2026-09-01 from the live Evidence tab — the earlier "(m)" claim
that a VERIFIED chip appears here was wrong; the VERIFIED chip renders on the **consumed**
record in the *Strategy* drawer, and is pointed at there in B3):
- PRODUCED: the launch claim card ("Aurora is approved to launch on October 1.",
  INTERNAL/ACTIVE chips, with Revoke/Compromise action buttons) — *"the launch date checked
  out — it's now a fact"* **(m — live 09-01)**.
- The payroll claim card with the **RESTRICTED** chip — *"stored too, but marked restricted —
  remember it"* **(m)**.
- The red **REJECTED PROPOSAL · citation_mismatch** card with the byte-range detail
  (`…content[28:61]…`) — *"the model's third claim wasn't in the file at all — rejected, and
  it shows the exact position where the check failed. A hallucination, stopped."* **(m)**
- Same tab, flight-recorder section header: **CHAIN VERIFIED** + correlated-event count —
  *"everything the agent did is recorded in a tamper-evident flight recorder."* (no Overview
  flick needed; count varies per run/model)

No terminal here — the compromise beat (B5) uses the in-UI Compromise button.

## 0:55–1:30 — B3 · Strategy run: authorization before context

**SAY (while it runs):** *"Now a second agent plans the launch. Before its model is called —
before anything could leak into a prompt — the middleware checks permissions and seals a
capsule: the exact list of what this run may know. The launch date gets in; payroll is denied,
and the denial itself is recorded."*

**DO:** **Strategy Agent → Playground**, send: `Summarize the approved Aurora launch plan.`
Then open the run's **Walnut drawer → Overview / Evidence**.

**EXPECT / SHOW:**
- Answer cites October 1. Capsule: **1 in / 1 denied** **(m** — walkthrough rehearsal run
  `617a182d`, capsule `cap_fc965d5b`**)**.
- Evidence tab: launch claim consumed under the `project:launch:*` grant; payroll **DENIED —
  `AGENT_SCOPE_MISSING`**, decision id + policy revision recorded **(m)**.
- **SAY the line:** *"The model never received the payroll data — proven, not promised: a
  tracer planted in that claim appears zero times in anything this run saw."*
  **(m** — INV-2, `results/p3-demo-rehearsal.md`**)**

## 1:30–1:55 — B5 · The incident: blast radius

**SAY:** *"Two days later we learn the launch date's source was tampered with. Which decisions
used the bad fact? Normally, nobody can say. Here, you mark the evidence compromised —"*

**DO:** Research Agent → Walnut → Evidence tab → **Compromise** button under the launch claim →
reason prompt: type `source tampered at origin` → OK. (The button calls the same REST route a
curl would — `TimelinePanel.tsx` states this explicitly; HC-2 is enforced middleware-side.)

**EXPECT / SHOW:**
- Response: new version **COMPROMISED**, old version still queryable (append-only) **(m)**;
  blast radius naming the Strategy **capsule, run, and agent** — nothing unrelated **(d** —
  clean-seed shape; measured with extra state in both rehearsals**)**.
- Browser: Strategy run drawer → **Overview: RUN STATE TAINTED**, red proof cell in the
  scenario rail; **History** records the trigger evidence **(m** — visual pass, Comms run**)**.
- **SAY:** *"— and it answers precisely: this run used it, nothing else did. The run is now
  tainted."*

## 1:55–2:30 — B6 · Rewind: recovery without rewriting history

**SAY (while the new run executes):** *"Recovery is never an edit. Reconcile starts a brand-new
run — and this time the compromised fact is denied. The old run isn't deleted or patched: it's
marked recovered, linked to its replacement, its history untouched."*

**DO:** Strategy run drawer → **Overview → Reconcile** button. Wait for the replacement run
(a real model run — keep narrating). Then show:

**EXPECT / SHOW:**
- Reconcile result card with the **replacement run id** **(m)**.
- Old run: state **RECOVERED**, its capsule hash and event chain untouched **(m)**; scenario
  rail shows **1 replacement** **(m** — visual pass**)**.
- New run's capsule: **0 in / 2 denied** — payroll `AGENT_SCOPE_MISSING` + launch
  `EVIDENCE_COMPROMISED` **(d** — confirm at the dry run**)**.

## 2:30–2:50 — Tamper evidence (cut this beat first if the dry run overruns)

**DO:** click **Verify chain** on the current Overview → green verified result.
**SAY:** *"Remember that chained diary from the start? One click — the whole chain verifies,
every seal intact."*

**DO (terminal — the single terminal moment, fully self-contained, 4 lines pasted together):**
```bash
BASE=http://localhost:3000
RID=$(curl -s $BASE/api/agents | jq -r '.agents[] | select(.name=="Research Agent").id')
R1=$(curl -s $BASE/api/agents/$RID/runs | jq -r '.runs[0].id')
curl -sS -X POST $BASE/api/runs/$R1/verify-tamper -H 'Content-Type: application/json' -d '{"corruptSequence":9}' | jq
```
**SAY:** *"Now let's attack it. This corrupts a copy of the diary at entry nine and re-runs
verification."* → point at `corrupted.ok:false / brokenAtSequence:9 / hash_mismatch`, then
`original.ok:true` → *"Caught — the exact entry. And the real diary is untouched and still
verifies. History here cannot be silently changed."*
(F-2: the body **must** carry `corruptSequence`, or this silently returns a plain verify. The
route writes the corruption to a separate `demo-corrupt-<runId>` chain — the real chain file is
never touched, per HC-7.)

**EXPECT / SHOW:** original `ok:true`; corrupted copy `ok:false, brokenAtSequence:9,
hash_mismatch`; the real chain still verifies **(m)**. Optionally click **Verify chain** in the
drawer for the green in-UI confirmation.

## 2:50–3:00 — Close

> *"You just watched three bad facts meet this system. The made-up one never became a fact.
> The restricted one never reached the model. And the one that turned bad was traced to every
> decision it touched — and rolled back, without erasing a single line of history. That's
> Walnut Rewind. AI agents you can finally trust with real work."*
>
> (~30 s spoken; the "233 tests / one command" numbers moved to the end card so the close stays
> clean. CapCut: stack the four punch lines as text — "Hallucination, stopped." / "Leaks,
> stopped." / "History, sealed." / "Rewind what's wrong." — then cut to the end card.)

---

## Stretch beat (insert after B3 **only** if the dry run lands ≤2:35)

**Delegation ceiling (F3, ~15 s)** — the brief's first optional-evidence checkbox, live:

```bash
# Strategy holds a payroll SHARE grant; the human it acts for holds nothing.
curl -sS -X POST $BASE/api/evidence/<PAYROLL_EV_ID>/share/<COMMS_ID> \
  -H 'Content-Type: application/json' \
  -d '{"fromAgentId":"<STRATEGY_ID>","principalId":"user:mehul"}' | jq
```
**EXPECT:** `DENY / PRINCIPAL_SCOPE_MISSING` **(m)** — *"an agent's own grant can never exceed
the authority of the human it acts for."*
⚠ **Never run this without the `principalId`** — it will ALLOW and issue a live payroll grant
to Comms (finding F-B, `results/p3-walkthrough-rehearsal.md`); recovery is a grant revoke.

## Timing discipline

- Checkpoints: **1:30** = compromise fired; **2:30** = reconcile shown. Behind at 1:30 → skip
  the Overview attestation flick in B1. Behind at 2:30 → cut the tamper beat and fold its
  sentence into the close ("…and the whole record is hash-chained and tamper-evident — that's
  in the repo's tests and walkthrough").
- The three model-run waits are where the time goes; the narration above is written to fill
  them. Never wait silently.

## Post-production (CapCut) — the text layer

Your voice explains; the overlays **name the feature at the exact moment it's proven on
screen**. Rules: one overlay at a time · max ~8 words · lower third of the frame (never cover
the drawer or the terminal output) · white text on a dark backdrop chip · appears when the
thing appears, gone 2–3 s later. Every overlay below is honest against a tracked artifact —
don't improvise new claims in the edit (truthfulness rule applies to UI text and narration,
so it applies to CapCut text too).

| When (beat) | Overlay text (use verbatim) |
|---|---|
| 0:02 title-in | `WALNUT REWIND — controls what an agent is allowed to know` |
| 0:05 under it | `TikTok TechJam 2026 · Track 1 · agent middleware` |
| B1 · run sends | `Real model run — live, in a container` |
| B1 · produced launch claim | `Only byte-verified claims become facts` |
| B1 · rejected proposal visible | `Hallucination blocked — made-up quote can't become a fact` |
| B1 · CHAIN VERIFIED badge | `Tamper-evident log — edit history and the chain breaks` |
| B3 · run sends | `Authorization happens BEFORE the prompt is built` |
| B3 · consumed claim's VERIFIED chip | `VERIFIED = quote byte-matches the source file` |
| B3 · denied row visible | `DENIED — payroll never reaches the model` |
| B3 · capsule hash | `Context Capsule = a lockfile for what this run knew` |
| B5 · compromise clicked | `Marked COMPROMISED — blast radius computed instantly` |
| B5 · TAINTED on screen | `Blast radius: exactly what was built on the bad claim` |
| B6 · Reconcile clicked | `Recovery = a NEW run — history is never rewritten` |
| B6 · RECOVERED visible | `Old run: RECOVERED · chain byte-identical` |
| Tamper · ok:false in terminal | `Tampering pinpointed at the exact sequence` |
| Close · four punch lines spoken | stack: `Hallucination, stopped.` / `Leaks, stopped.` / `History, sealed.` / `Rewind what's wrong.` |
| Close (last 5 s) | end card: `demo/slides/end-card.png` (233 tests · 0 vulnerabilities · 1 command — every number sourced in the repo) |

**Export:** 1080p (or the recording's native res), 30 fps is fine, hard cap **3:00** — trim the
model-run waits in the edit if the take ran long (cutting dead waiting time is fine; never cut
so a result appears without its action). Upload to YouTube as **Public** (Devpost requires
public visibility), title it plainly (e.g. "Walnut Rewind — TechJam 2026 Track 1 demo"), and
put the link in the Devpost description.

## Fallback ladder (if something breaks live)

1. **Ark/quota failure during a model run** → the previous dry-run pass left a full set of
   evidence/capsules in the state you moved aside in pre-flight step 2 — restore that
   directory, restart, and present its drawers (all Walnut read surfaces work with zero model
   calls). Verify the backup exists before going on stage.
2. **UI hiccup** → the same story via curl (`demo/FULL-WALKTHROUGH.md` has every route with
   expected output; the UI rendering was separately proven in `results/p2-visual-pass.md`).
3. **Total loss** → `npx vitest run src/walnut/e2e.test.ts --root apps/server` on screen: the
   whole thesis — capsule, denial, compromise, taint, reconcile, RECOVERED_BY — as one test.
