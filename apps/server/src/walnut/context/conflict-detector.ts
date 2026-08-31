// Pure conflict detection (P3-C1, INV-22 "no silent pick, ever"). Consumed by
// ContextBrokerImpl.build to decide whether a Run's authorized evidence set contains an
// unresolved disagreement that must be surfaced as a ClarificationRequest rather than silently
// included in a capsule.
//
// A conflict is two or more ACTIVE evidence records among `candidates` that share the same
// non-null subjectKey AND the same non-null predicate but carry DIFFERENT claimHash values.
// Evidence with a null subjectKey or null predicate has no key to conflict on and is never
// grouped. Output is deterministic regardless of input order: groups are ordinal-sorted by the
// (subjectKey, predicate) pair, and each group's `conflicting` array is ordinal-sorted by
// evidenceId.

import type { Evidence } from "../types.js";

export interface ConflictGroup {
  subjectKey: string;
  predicate: string;
  conflicting: Evidence[];
}

interface Bucket {
  subjectKey: string;
  predicate: string;
  items: Evidence[];
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// JSON.stringify of the pair as a Map key sidesteps any delimiter-collision concern from
// joining the two strings by hand.
function bucketKey(subjectKey: string, predicate: string): string {
  return JSON.stringify([subjectKey, predicate]);
}

export function detectConflicts(candidates: Evidence[]): ConflictGroup[] {
  const buckets = new Map<string, Bucket>();

  for (const evidence of candidates) {
    if (evidence.status !== "ACTIVE") continue;
    const { subjectKey, predicate } = evidence;
    if (subjectKey === null || predicate === null) continue;

    const key = bucketKey(subjectKey, predicate);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.items.push(evidence);
    } else {
      buckets.set(key, { subjectKey, predicate, items: [evidence] });
    }
  }

  const conflicts: ConflictGroup[] = [];
  for (const bucket of buckets.values()) {
    const distinctClaimHashes = new Set(bucket.items.map((item) => item.claimHash));
    if (distinctClaimHashes.size < 2) continue;

    conflicts.push({
      subjectKey: bucket.subjectKey,
      predicate: bucket.predicate,
      conflicting: [...bucket.items].sort((a, b) => compareStrings(a.evidenceId, b.evidenceId)),
    });
  }

  return conflicts.sort((a, b) =>
    compareStrings(bucketKey(a.subjectKey, a.predicate), bucketKey(b.subjectKey, b.predicate)),
  );
}
