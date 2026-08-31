// Pure temporal resolution (P3-D5). No I/O — callers (EvidenceRepository.listCandidateEvidence's
// knownAt param, the History tab's `?knownAt=` param) supply the version set; this module only
// picks among versions already in hand. See doc 05 §11 for the valid-time / transaction-time
// distinction this implements:
//   - valid time    = when the claim is true/effective  -> Evidence.validFrom / validTo
//   - transaction/belief time = when Walnut recorded/accepted that version
//                     -> Evidence.recordedAt / txClosedAt
// ISO-8601 timestamps in this codebase are fixed-width, zero-padded, UTC ("...Z"), so plain
// string `<=`/`<` comparisons are equivalent to chronological comparisons.

import type { Evidence, EvidenceId } from "../types.js";

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Among versions of ONE evidenceId, the version that was the current transaction-time belief at
// `knownAt`: recordedAt <= knownAt (inclusive — a version known exactly at its own recordedAt is
// visible) AND (txClosedAt === null OR knownAt < txClosedAt) (exclusive — a version is no longer
// current at the instant it closes; the doc 05 §11 example puts E17 current at 15:00, superseded
// by 17:00 when E31 (recordedAt 16:00) is current). Null when no version qualifies (the evidence
// was not yet known at that time, or `versions` is empty).
export function versionKnownAt(versions: Evidence[], knownAt: string): Evidence | null {
  return (
    versions.find(
      (version) =>
        version.recordedAt <= knownAt &&
        (version.txClosedAt === null || knownAt < version.txClosedAt),
    ) ?? null
  );
}

// Groups `allVersions` by evidenceId, applies versionKnownAt to each group, drops evidenceIds
// with no qualifying version, and returns the survivors ordinal-sorted by evidenceId
// (deterministic output for the History tab / any known-at listing).
export function evidenceKnownAt(allVersions: Evidence[], knownAt: string): Evidence[] {
  const byEvidenceId = new Map<EvidenceId, Evidence[]>();
  for (const version of allVersions) {
    const bucket = byEvidenceId.get(version.evidenceId);
    if (bucket) {
      bucket.push(version);
    } else {
      byEvidenceId.set(version.evidenceId, [version]);
    }
  }

  const result: Evidence[] = [];
  for (const [, versions] of byEvidenceId) {
    const match = versionKnownAt(versions, knownAt);
    if (match !== null) {
      result.push(match);
    }
  }

  return result.sort((a, b) => compareStrings(a.evidenceId, b.evidenceId));
}

// Valid-time check: is `evidence` in effect at instant `at`? validFrom === null means "always
// valid from the start of time"; validTo === null means "still valid, no end". The upper bound
// is exclusive, matching the transaction-time close semantics above.
export function isValidAt(evidence: Evidence, at: string): boolean {
  if (evidence.validFrom !== null && evidence.validFrom > at) return false;
  if (evidence.validTo !== null && at >= evidence.validTo) return false;
  return true;
}
