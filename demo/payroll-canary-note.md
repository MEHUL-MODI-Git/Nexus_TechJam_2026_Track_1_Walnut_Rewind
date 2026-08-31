# INV-2 canary: the denied payroll claim

Walnut's own tests plant this literal so the "unauthorized evidence never reaches the model"
claim (HC-5, INV-2) is checked mechanically rather than asserted:

    WALNUT_CANARY_DENIED_PAYROLL_93c1e7

Origin: chosen to be unique,
greppable, and carrying no secret semantics of its own (it exercises the *authorization*
boundary, not the redactor's secret-detection heuristics; those have their own four literals,
tracked separately in the evidence-runtime workstream's redactor tests).

## How the live demo seeds it

The demo (`demo/DEMO-SCRIPT.md`) needs one real Run to genuinely PRODUCE a payroll Evidence
record that later gets DENIED to a different Agent. That happens through the Research Agent's
workspace outbox (`docs/walnut/03-STARTER-KIT-INTEGRATION.md` §14) — the model never writes to
the evidence store directly (INV-4); it proposes through `.walnut/outbox.json`, and
`processOutbox` (`apps/server/src/walnut/evidence/outbox.ts`) is the only path that turns a
proposal into a real, citation-verified Evidence record.

**Ask the Research Agent, in its prompt, to write two files and one outbox entry per file** —
spelled out here rather than left to model improvisation, because the outbox schema is strict
(zod, `outbox.ts`) and a malformed entry is silently rejected (recorded in
`evidence.outbox_processed`'s `rejectedCount`), never retried.

### File 1 — `launch-plan.txt`

```
The launch date is October 1.
```

### File 2 — `payroll-note.txt`

```
Payroll run for October references WALNUT_CANARY_DENIED_PAYROLL_93c1e7 as the internal batch tag.
```

### `.walnut/outbox.json` the Research Agent's run must write

```json
{
  "evidence": [
    {
      "claim": "The launch date is October 1.",
      "classification": "INTERNAL",
      "requiredScopes": ["project:launch:read"],
      "source": {
        "path": "launch-plan.txt",
        "quote": "The launch date is October 1.",
        "charStart": 0,
        "charEnd": 29
      },
      "derivedFromEvidenceIds": []
    },
    {
      "claim": "Payroll run for October references WALNUT_CANARY_DENIED_PAYROLL_93c1e7 as the internal batch tag.",
      "classification": "RESTRICTED",
      "requiredScopes": ["project:payroll:read"],
      "source": {
        "path": "payroll-note.txt",
        "quote": "Payroll run for October references WALNUT_CANARY_DENIED_PAYROLL_93c1e7 as the internal batch tag.",
        "charStart": 0,
        "charEnd": 97
      },
      "derivedFromEvidenceIds": []
    }
  ]
}
```

`charStart`/`charEnd` must be the EXACT character offsets of `quote` inside the written file
(HC-6, byte-exact citation verification) — if the model's file has a different quote length or a
trailing-newline shift, count characters, don't guess; a mismatch is rejected outright
(`CitationVerifier`, no fuzzy fallback, INV-5). The two lengths above (29 and 97) were measured
with `node -e`, not eyeballed.

## How the canary demonstrates the denial

1. The **Strategy Agent** is only ever granted `project:launch:*` (`action: "consume"`) — never
   `project:payroll:*`. See `scripts/walnut-demo-seed.sh` step 2 of its printed follow-up.
2. When the Strategy Agent runs, `ContextBrokerImpl.build` authorizes the launch evidence
   (ALLOW) and denies the payroll evidence (`AGENT_SCOPE_MISSING`) — the DENY decision is
   recorded, but no capsule ref is created for it (spec 003 §A1: candidate count never selects
   the `ok`/`denied` union member; this is still an `ok` capsule, just with one denied decision).
3. INV-2 assertions (already covered by `apps/server/src/walnut/context/capsule.test.ts`, and
   demonstrable live in the demo): the literal `WALNUT_CANARY_DENIED_PAYROLL_93c1e7` is present
   in the evidence store and in the DENY decision's *evidenceId* reference, but **absent** from:
   - the rendered `<WALNUT_CONTEXT>` prompt block (`ContextBrokerImpl.renderPrompt` never
     resolves a denied ref — only `capsule.evidence` entries are rendered, and denied candidates
     never enter that array),
   - the persisted `ContextCapsule` JSON (`deniedEvidenceDecisionIds` holds only the decision id,
     never the claim text),
   - every record on the Strategy run's ledger chain.

   Stored ≠ rendered — that is the point being demonstrated.
