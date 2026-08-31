import { describe, expect, it } from "vitest";
import type { Evidence } from "../types.js";
import { detectConflicts } from "./conflict-detector.js";

function hex64(fill: string): string {
  return fill.repeat(64).slice(0, 64);
}

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    evidenceId: "ev-1",
    version: 1,
    subjectKey: null,
    predicate: null,
    claim: "some claim",
    producerAgentId: "agent-1",
    producerRunId: "run-1",
    sourcePointerId: "ptr-1",
    citationId: null,
    classification: "INTERNAL",
    requiredScopes: [],
    status: "ACTIVE",
    validFrom: null,
    validTo: null,
    recordedAt: "2026-08-27T14:00:00.000Z",
    txClosedAt: null,
    supersedesEvidenceId: null,
    derivedFromEvidenceIds: [],
    claimHash: `sha256:${hex64("a")}`,
    ...overrides,
  };
}

describe("detectConflicts", () => {
  it("two ACTIVE records, same subjectKey+predicate, different claimHash -> one conflict group of 2", () => {
    const a = makeEvidence({
      evidenceId: "ev-a",
      subjectKey: "launch_date",
      predicate: "confirmed_on",
      claimHash: `sha256:${hex64("1")}`,
    });
    const b = makeEvidence({
      evidenceId: "ev-b",
      subjectKey: "launch_date",
      predicate: "confirmed_on",
      claimHash: `sha256:${hex64("2")}`,
    });

    const conflicts = detectConflicts([a, b]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({
      subjectKey: "launch_date",
      predicate: "confirmed_on",
      conflicting: [a, b],
    });
  });

  it("same subjectKey+predicate but same claimHash -> no conflict", () => {
    const a = makeEvidence({
      evidenceId: "ev-a",
      subjectKey: "launch_date",
      predicate: "confirmed_on",
      claimHash: `sha256:${hex64("1")}`,
    });
    const b = makeEvidence({
      evidenceId: "ev-b",
      subjectKey: "launch_date",
      predicate: "confirmed_on",
      claimHash: `sha256:${hex64("1")}`,
    });

    expect(detectConflicts([a, b])).toEqual([]);
  });

  it("one of the two records is SUPERSEDED -> no conflict", () => {
    const a = makeEvidence({
      evidenceId: "ev-a",
      subjectKey: "launch_date",
      predicate: "confirmed_on",
      claimHash: `sha256:${hex64("1")}`,
      status: "ACTIVE",
    });
    const b = makeEvidence({
      evidenceId: "ev-b",
      subjectKey: "launch_date",
      predicate: "confirmed_on",
      claimHash: `sha256:${hex64("2")}`,
      status: "SUPERSEDED",
    });

    expect(detectConflicts([a, b])).toEqual([]);
  });

  it("REVOKED and COMPROMISED are likewise excluded from conflict grouping", () => {
    const a = makeEvidence({
      evidenceId: "ev-a",
      subjectKey: "k",
      predicate: "p",
      claimHash: `sha256:${hex64("1")}`,
      status: "REVOKED",
    });
    const b = makeEvidence({
      evidenceId: "ev-b",
      subjectKey: "k",
      predicate: "p",
      claimHash: `sha256:${hex64("2")}`,
      status: "COMPROMISED",
    });

    expect(detectConflicts([a, b])).toEqual([]);
  });

  it("null subjectKey never conflicts, even with matching predicate and differing claimHash", () => {
    const a = makeEvidence({
      evidenceId: "ev-a",
      subjectKey: null,
      predicate: "confirmed_on",
      claimHash: `sha256:${hex64("1")}`,
    });
    const b = makeEvidence({
      evidenceId: "ev-b",
      subjectKey: null,
      predicate: "confirmed_on",
      claimHash: `sha256:${hex64("2")}`,
    });

    expect(detectConflicts([a, b])).toEqual([]);
  });

  it("null predicate never conflicts", () => {
    const a = makeEvidence({
      evidenceId: "ev-a",
      subjectKey: "launch_date",
      predicate: null,
      claimHash: `sha256:${hex64("1")}`,
    });
    const b = makeEvidence({
      evidenceId: "ev-b",
      subjectKey: "launch_date",
      predicate: null,
      claimHash: `sha256:${hex64("2")}`,
    });

    expect(detectConflicts([a, b])).toEqual([]);
  });

  it("three-way conflict -> one group containing all 3, sorted by evidenceId", () => {
    const c = makeEvidence({
      evidenceId: "ev-c",
      subjectKey: "k",
      predicate: "p",
      claimHash: `sha256:${hex64("3")}`,
    });
    const a = makeEvidence({
      evidenceId: "ev-a",
      subjectKey: "k",
      predicate: "p",
      claimHash: `sha256:${hex64("1")}`,
    });
    const b = makeEvidence({
      evidenceId: "ev-b",
      subjectKey: "k",
      predicate: "p",
      claimHash: `sha256:${hex64("2")}`,
    });

    const conflicts = detectConflicts([c, a, b]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.conflicting.map((evidence) => evidence.evidenceId)).toEqual([
      "ev-a",
      "ev-b",
      "ev-c",
    ]);
  });

  it("determinism under input shuffle: same groups, same order, regardless of candidate order", () => {
    const a = makeEvidence({
      evidenceId: "ev-a",
      subjectKey: "launch_date",
      predicate: "confirmed_on",
      claimHash: `sha256:${hex64("1")}`,
    });
    const b = makeEvidence({
      evidenceId: "ev-b",
      subjectKey: "launch_date",
      predicate: "confirmed_on",
      claimHash: `sha256:${hex64("2")}`,
    });
    const d = makeEvidence({
      evidenceId: "ev-d",
      subjectKey: "payroll_total",
      predicate: "amount",
      claimHash: `sha256:${hex64("4")}`,
    });
    const e = makeEvidence({
      evidenceId: "ev-e",
      subjectKey: "payroll_total",
      predicate: "amount",
      claimHash: `sha256:${hex64("5")}`,
    });

    const forward = detectConflicts([a, b, d, e]);
    const shuffled = detectConflicts([e, d, b, a]);

    expect(shuffled).toEqual(forward);
    expect(forward.map((group) => `${group.subjectKey}:${group.predicate}`)).toEqual([
      "launch_date:confirmed_on",
      "payroll_total:amount",
    ]);
  });

  it("no candidates -> no conflicts", () => {
    expect(detectConflicts([])).toEqual([]);
  });

  it("distinct subjectKey/predicate pairs never group together even with matching one field", () => {
    const a = makeEvidence({
      evidenceId: "ev-a",
      subjectKey: "launch_date",
      predicate: "confirmed_on",
      claimHash: `sha256:${hex64("1")}`,
    });
    const b = makeEvidence({
      evidenceId: "ev-b",
      subjectKey: "launch_date",
      predicate: "announced_on",
      claimHash: `sha256:${hex64("2")}`,
    });

    expect(detectConflicts([a, b])).toEqual([]);
  });
});
