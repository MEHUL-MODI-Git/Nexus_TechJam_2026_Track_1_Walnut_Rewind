# Walnut Rewind — Security, Provenance, Privacy, Authorization, and Temporal Semantics

# 1. Security philosophy

Walnut Rewind should not depend on the Agent behaving correctly.

If a property must always hold, implement it in deterministic middleware.

Key rules:

- unauthorized evidence never enters the model context
- citation validity is checked outside the model
- evidence history is append-only
- redaction occurs before persistence
- dependencies are explicit
- recovery does not rewrite history

---

# 2. Authorization

## 2.1 Agent as principal

Every Agent has its own principal identity.

Do not reuse human authority wholesale.

## 2.2 Delegated authority

If Agent A acts on behalf of Human H:

```text
effective(A) ⊆ authority(H)
```

But also:

```text
effective(A) ⊆ explicitAgentGrant(A)
```

Therefore:

```text
effective(A) =
  human_authority
  ∩ agent_grants
  ∩ evidence requirements
  ∩ policy
```

## 2.3 Recipient reauthorization

Agent-to-Agent transfer:
- sender authorization is insufficient
- recipient must pass a new check

This prevents authority laundering through another Agent.

## 2.4 Revocation

Grant revocation must:
- block future capsule inclusion
- remain visible historically
- optionally support impact analysis over historical capsules that used the grant

---

# 3. Information classification

Use simple four-level classification:

```text
PUBLIC
INTERNAL
CONFIDENTIAL
RESTRICTED
```

Derived evidence uses **most restrictive wins**.

Example:

```text
PUBLIC + CONFIDENTIAL → CONFIDENTIAL
```

A derivation may become more restrictive, never less restrictive without explicit governed declassification.

For hackathon scope, do not build a full declassification workflow.

---

# 4. Pointer-not-copy privacy

Evidence store should not become a shadow copy of sensitive systems.

Prefer:
- pointer
- hash
- bounded preview
- citation location
- classification
- producer metadata

Avoid:
- raw prompts
- raw hidden reasoning
- full environment variables
- full command output when not needed
- full sensitive file contents
- API keys

---

# 5. Redaction

## 5.1 Boundary

`RuntimeEvent → redact → append`

Never:
`append raw → hide in UI`

## 5.2 Minimum detection

- `ARK_API_KEY=...`
- `Authorization: Bearer ...`
- PEM private key blocks
- common API key prefixes
- `.env` assignments
- env values known to the process
- planted test canaries
- high-entropy strings with conservative handling

## 5.3 Failure behavior

If redaction fails unexpectedly:
- do not append untrusted raw payload
- append a hash-only `redaction_failure` event
- keep trace visible but payload unavailable

---

# 6. Inert rendering

Evidence UI displays attacker-controlled Runtime/source strings.

Render as text.

Do not automatically render:
- HTML
- Markdown images
- remote links/images
- scriptable content

This is especially important in privileged evidence/operator surfaces.

---

# 7. Citation/provenance chain

Desired chain:

```text
Source
  ↓
SourcePointer
  ↓
Citation
  ↓
Evidence
  ↓
ContextCapsule
  ↓
Run
  ↓
Artifact / derived Evidence
```

Every reusable Evidence should be able to resolve backward to at least one SourcePointer.

---

# 8. Mechanical anchor verifier

For a text file:
1. ensure path is inside workspace/approved source
2. resolve current file bytes/text
3. compute content hash
4. validate anchor indices
5. compare exact anchored content
6. persist verification result

No fuzzy matching.

If file changed:
- historical pointer remains
- current resolution returns `DRIFTED`
- system does not pretend old citation matches new content

---

# 9. Hash-chain integrity

Hash chaining protects recorded order and post-recording integrity.

It does **not** prove:
- an unobserved OS action never happened
- every model provider retry was recorded
- source content was truthful

Be precise in README/pitch.

---

# 10. Runtime observation boundary

Codex JSONL is the observed execution event stream.

Capture:
- what Codex emits

Do not claim:
- one ledger event per physical ModelArk request
- guaranteed pre-command interception

This is why Agent authorization is enforced before context injection, a boundary we actually control.

---

# 11. Temporal semantics

Walnut's full architecture uses valid time and transaction time.

For TechJam:

## Valid time
When an Evidence claim is true/effective.

Fields:
- `validFrom`
- `validTo`

## Transaction/belief time
When Walnut recorded/accepted that version.

Fields:
- `recordedAt`
- `txClosedAt`

Example:

```text
E17:
  launch date Sep 14
  validFrom: Sep 14
  recordedAt: Aug 27 14:00
  txClosedAt: Aug 27 16:00

E31:
  launch date Oct 7
  recordedAt: Aug 27 16:00
  supersedes E17
```

At known-at 15:00:
- E17 is current belief

At known-at 17:00:
- E31 is current belief

---

# 12. Source correction vs compromise

## Supersede
Used when a newer/corrected version replaces earlier belief.

Old evidence remains historically valid as a past belief.

## Revoke
Used when evidence should no longer be treated as valid.

## Compromise
Used for source-integrity / poisoning incident.

Compromise should trigger strongest blast-radius UX.

---

# 13. Blast radius

The impact query is a core security/reliability capability.

Given Evidence E:

```text
E
→ capsules containing E
→ Runs using those capsules
→ artifacts produced by those Runs
→ evidence produced by those Runs
→ downstream capsules consuming derived evidence
→ downstream Runs...
```

Must prevent cycles / repeated traversal.

Return deterministic impact set.

---

# 14. Reconciliation

The point of provenance is not only audit.

It enables recovery.

When upstream evidence changes:
- old Run remains
- mark stale/tainted
- new capsule uses corrected evidence
- new Run executes
- relationship preserves lineage

This is analogous to incremental rebuilds in software dependency systems.

---

# 15. Authorization blast radius

If a grant is found to have been wrongly issued:

Query:
```text
grant
→ authorization decisions using grant
→ capsules
→ Runs
→ artifacts / downstream evidence
```

This can show:
> "Which historical Runs consumed information under this grant?"

Whether to automatically rerun for permission incidents is policy-dependent. At minimum surface impact.

---

# 16. Clarification-first

Conflict example:

```text
E17: Q3 revenue = 42.1M, basis=fiscal
E19: Q3 revenue = 39.8M, basis=calendar
```

Both may be valid.

Do not let LLM silently choose.

Emit:

```text
CLARIFICATION REQUIRED

Two evidence-supported interpretations exist:
A. Fiscal Q3 — E17
B. Calendar Q3 — E19
None of the above

Timeout → REFUSE
```

The trigger should come from deterministic conflict metadata when possible.

---

# 17. Secret handling

Never commit:
- Ark API key
- account AK/SK
- bearer tokens
- passwords
- private keys
- raw secrets in screenshots
- raw secrets in evidence pack

The Track 1 brief explicitly requires no secret in source, Git history, logs, traces, screenshots, browser storage, or demo output.

---

# 18. Evidence pack security

If exporting:
- export safe ledger records
- capsule
- authorization decisions
- chain head
- hashes
- dependency edges
- recovery records

Do not bundle sensitive source content by default.

Offline verifier should work without calling models.

---

# 19. Threat scenarios to test

## Unauthorized context
Target Agent lacks scope.

Expected:
- DENY
- evidence excluded
- no source preview leaked

## Authority laundering
Authorized Agent A shares to unauthorized Agent B.

Expected:
- recipient check DENY

## Citation fabrication
Agent proposes quote not present in source.

Expected:
- evidence rejected

## Source drift
File changes under pointer.

Expected:
- `DRIFTED`
- downstream impact visible

## Evidence poisoning/compromise
Mark evidence compromised.

Expected:
- blast radius
- Runs tainted
- Rewind possible

## Ledger tampering
Mutate persisted NDJSON.

Expected:
- verification failure

## Secret in Runtime output
Runtime emits canary token.

Expected:
- never appears in persisted safe payload

## Unknown Codex event
New event type.

Expected:
- `runtime.unknown`, no crash

## Malformed JSONL
Expected:
- hash-only parse failure event
- baseline Run aggregation continues when safe

## Conflicting evidence
Expected:
- clarification/refusal, not silent choice

---

# 20. Claims we should emphasize

- "Unauthorized data never enters the model context."
- "Every reusable claim is provenance-carrying."
- "A citation is a machine dependency, not just a footnote."
- "Corrections supersede; they do not rewrite history."
- "We can calculate the blast radius of bad knowledge."
- "Recovery creates a new Run from a fresh Context Capsule."
- "The graph is a projection of evidence, not a second source of truth."

---

# 21. Claims we should avoid

- "perfect privacy"
- "anonymized"
- "hardened sandbox"
- "complete provider trace"
- "every physical model call logged"
- "cryptographic proof the Agent did nothing else"
- "production-grade ReBAC"
- "full bitemporal database"

The hackathon prototype should be technically strong and honest.
