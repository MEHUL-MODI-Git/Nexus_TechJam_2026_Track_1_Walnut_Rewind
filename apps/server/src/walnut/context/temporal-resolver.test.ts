import { describe, expect, it } from "vitest";
import type { Evidence } from "../types.js";
import { evidenceKnownAt, isValidAt, versionKnownAt } from "./temporal-resolver.js";

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

describe("versionKnownAt", () => {
  // doc 05 §11 worked example: E17 recordedAt 14:00, txClosedAt 16:00; E31 recordedAt 16:00,
  // open. At known-at 15:00 E17 is current; at known-at 17:00 E31 is current.
  const e17 = makeEvidence({
    evidenceId: "ev-launch",
    version: 1,
    claim: "launch date Sep 14",
    recordedAt: "2026-08-27T14:00:00.000Z",
    txClosedAt: "2026-08-27T16:00:00.000Z",
  });
  const e31 = makeEvidence({
    evidenceId: "ev-launch",
    version: 2,
    claim: "launch date Oct 7",
    recordedAt: "2026-08-27T16:00:00.000Z",
    txClosedAt: null,
    supersedesEvidenceId: "ev-launch",
  });
  const versions = [e17, e31];

  it("selects E17 at known-at 15:00 (between recordedAt and txClosedAt)", () => {
    expect(versionKnownAt(versions, "2026-08-27T15:00:00.000Z")).toEqual(e17);
  });

  it("selects E31 at known-at 17:00 (after E31's recordedAt)", () => {
    expect(versionKnownAt(versions, "2026-08-27T17:00:00.000Z")).toEqual(e31);
  });

  it("boundary: knownAt === recordedAt is inclusive (selects the version born exactly then)", () => {
    expect(versionKnownAt(versions, "2026-08-27T14:00:00.000Z")).toEqual(e17);
    expect(versionKnownAt(versions, "2026-08-27T16:00:00.000Z")).toEqual(e31);
  });

  it("boundary: knownAt === txClosedAt is exclusive (the closing version is no longer current)", () => {
    // At exactly 16:00, E17 is closed (txClosedAt 16:00 is not > knownAt), and E31 (recordedAt
    // 16:00) has already opened — so E31, not E17, is current at exactly 16:00.
    const result = versionKnownAt(versions, "2026-08-27T16:00:00.000Z");
    expect(result?.evidenceId).toBe("ev-launch");
    expect(result?.version).toBe(2);
  });

  it("pre-history knownAt (before any version's recordedAt) returns null", () => {
    expect(versionKnownAt(versions, "2026-08-27T00:00:00.000Z")).toBeNull();
  });

  it("empty versions array returns null", () => {
    expect(versionKnownAt([], "2026-08-27T15:00:00.000Z")).toBeNull();
  });

  it("a still-open version (txClosedAt null) remains current arbitrarily far in the future", () => {
    expect(versionKnownAt([e31], "2099-01-01T00:00:00.000Z")).toEqual(e31);
  });
});

describe("evidenceKnownAt", () => {
  const launchV1 = makeEvidence({
    evidenceId: "ev-launch",
    version: 1,
    recordedAt: "2026-08-27T14:00:00.000Z",
    txClosedAt: "2026-08-27T16:00:00.000Z",
  });
  const launchV2 = makeEvidence({
    evidenceId: "ev-launch",
    version: 2,
    recordedAt: "2026-08-27T16:00:00.000Z",
    txClosedAt: null,
  });
  const payrollV1 = makeEvidence({
    evidenceId: "ev-payroll",
    version: 1,
    recordedAt: "2026-08-27T10:00:00.000Z",
    txClosedAt: null,
  });

  it("groups by evidenceId, resolves each group's current version, drops nulls", () => {
    // At 12:00, ev-payroll exists (recorded 10:00) but ev-launch does not yet (recorded 14:00).
    const result = evidenceKnownAt([launchV1, launchV2, payrollV1], "2026-08-27T12:00:00.000Z");
    expect(result.map((evidence) => evidence.evidenceId)).toEqual(["ev-payroll"]);
  });

  it("at a later known-at, resolves one version per evidenceId, ordinal-sorted by evidenceId", () => {
    const result = evidenceKnownAt([launchV1, launchV2, payrollV1], "2026-08-27T17:00:00.000Z");
    expect(result.map((evidence) => evidence.evidenceId)).toEqual(["ev-launch", "ev-payroll"]);
    const launch = result.find((evidence) => evidence.evidenceId === "ev-launch");
    expect(launch?.version).toBe(2);
  });

  it("determinism under input shuffle", () => {
    const shuffled = [payrollV1, launchV2, launchV1];
    const result = evidenceKnownAt(shuffled, "2026-08-27T17:00:00.000Z");
    expect(result.map((evidence) => evidence.evidenceId)).toEqual(["ev-launch", "ev-payroll"]);
  });

  it("empty input returns empty array", () => {
    expect(evidenceKnownAt([], "2026-08-27T17:00:00.000Z")).toEqual([]);
  });
});

describe("isValidAt", () => {
  it("open interval on both ends is always valid", () => {
    const evidence = makeEvidence({ validFrom: null, validTo: null });
    expect(isValidAt(evidence, "2000-01-01T00:00:00.000Z")).toBe(true);
    expect(isValidAt(evidence, "2099-01-01T00:00:00.000Z")).toBe(true);
  });

  it("validFrom is inclusive", () => {
    const evidence = makeEvidence({ validFrom: "2026-08-27T00:00:00.000Z", validTo: null });
    expect(isValidAt(evidence, "2026-08-27T00:00:00.000Z")).toBe(true);
    expect(isValidAt(evidence, "2026-08-26T23:59:59.000Z")).toBe(false);
  });

  it("validTo is exclusive", () => {
    const evidence = makeEvidence({ validFrom: null, validTo: "2026-08-27T00:00:00.000Z" });
    expect(isValidAt(evidence, "2026-08-26T23:59:59.999Z")).toBe(true);
    expect(isValidAt(evidence, "2026-08-27T00:00:00.000Z")).toBe(false);
  });

  it("closed interval: valid strictly inside, invalid at/after the end and before the start", () => {
    const evidence = makeEvidence({
      validFrom: "2026-08-27T00:00:00.000Z",
      validTo: "2026-08-28T00:00:00.000Z",
    });
    expect(isValidAt(evidence, "2026-08-27T12:00:00.000Z")).toBe(true);
    expect(isValidAt(evidence, "2026-08-26T00:00:00.000Z")).toBe(false);
    expect(isValidAt(evidence, "2026-08-28T00:00:00.000Z")).toBe(false);
  });
});
