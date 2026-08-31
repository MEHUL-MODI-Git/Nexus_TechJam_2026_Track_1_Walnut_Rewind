import { describe, expect, it } from "vitest";
import type { GraphEdge } from "../types.js";
import { computeBlastRadius } from "./blast-radius.js";
import type { DependencyGraph } from "./projector.js";

// -- Hand-built DAG, blast radius known by construction (doc 06 §6 INV-12) --------------------
//
// Trigger E1 -> capsule C1 -> run R1 (agent AG1) -> PRODUCED E2 -> capsule C2 -> run R2
// (agent AG2). Plus derived evidence E3 (DERIVED_FROM -> E1), contained in capsule C3, used by
// run R3 (agent AG3). Plus a DERIVED_FROM cycle E3 <-> E4 hanging off E3, to prove cycle-safety.
// Plus an unrelated branch E9/C9/R9/AG9 that must never appear in any output.
// Plus E1 CITES SRC1, and E9 CITES SRC9, for the source-trigger test.

function edge(id: string, from: string, to: string, type: GraphEdge["type"]): GraphEdge {
  return { id, from, to, type, metadata: {} };
}

function buildGraph(): DependencyGraph {
  const edges: GraphEdge[] = [
    // Trigger's own capsule/run/agent.
    edge("CONTAINS_EVIDENCE:C1->E1", "C1", "E1", "CONTAINS_EVIDENCE"),
    edge("USED_CAPSULE:R1->C1", "R1", "C1", "USED_CAPSULE"),
    edge("EXECUTED:AG1->R1", "AG1", "R1", "EXECUTED"),

    // R1 produced E2, which lives in C2/R2/AG2.
    edge("PRODUCED:R1->E2", "R1", "E2", "PRODUCED"),
    edge("CONTAINS_EVIDENCE:C2->E2", "C2", "E2", "CONTAINS_EVIDENCE"),
    edge("USED_CAPSULE:R2->C2", "R2", "C2", "USED_CAPSULE"),
    edge("EXECUTED:AG2->R2", "AG2", "R2", "EXECUTED"),

    // E3 is derived from the trigger, and lives in C3/R3/AG3.
    edge("DERIVED_FROM:E3->E1", "E3", "E1", "DERIVED_FROM"),
    edge("CONTAINS_EVIDENCE:C3->E3", "C3", "E3", "CONTAINS_EVIDENCE"),
    edge("USED_CAPSULE:R3->C3", "R3", "C3", "USED_CAPSULE"),
    edge("EXECUTED:AG3->R3", "AG3", "R3", "EXECUTED"),

    // DERIVED_FROM cycle hanging off E3: E4 derived from E3, E3 (also) derived from E4.
    edge("DERIVED_FROM:E4->E3", "E4", "E3", "DERIVED_FROM"),
    edge("DERIVED_FROM:E3->E4", "E3", "E4", "DERIVED_FROM"),

    // Trigger cites a source, for the source-trigger test.
    edge("CITES:E1->SRC1", "E1", "SRC1", "CITES"),

    // Unrelated, unreachable branch.
    edge("CONTAINS_EVIDENCE:C9->E9", "C9", "E9", "CONTAINS_EVIDENCE"),
    edge("USED_CAPSULE:R9->C9", "R9", "C9", "USED_CAPSULE"),
    edge("EXECUTED:AG9->R9", "AG9", "R9", "EXECUTED"),
    edge("PRODUCED:R9->E9", "R9", "E9", "PRODUCED"),
    edge("CITES:E9->SRC9", "E9", "SRC9", "CITES"),
  ];

  return { nodes: [], edges, skippedDanglingRefs: 0 };
}

describe("computeBlastRadius", () => {
  it("evidence trigger: excludes the trigger itself, includes everything downstream exactly once, excludes the unrelated branch", () => {
    const graph = buildGraph();
    const radius = computeBlastRadius(graph, { kind: "evidence", id: "E1" }, "2026-08-27T00:00:00Z");

    expect(radius.trigger).toEqual({ kind: "evidence", id: "E1" });
    expect(radius.computedAt).toBe("2026-08-27T00:00:00Z");

    expect(radius.evidenceIds).toEqual(["E2", "E3", "E4"]);
    expect(radius.derivedEvidenceIds).toEqual(["E2", "E3", "E4"]);
    expect(radius.capsuleIds).toEqual(["C1", "C2", "C3"]);
    expect(radius.runIds).toEqual(["R1", "R2", "R3"]);
    expect(radius.agentIds).toEqual(["AG1", "AG2", "AG3"]);
    expect(radius.artifactIds).toEqual([]);

    // Every reachable downstream run appears exactly once (INV-12) -- no duplicates snuck in by
    // the two independent discovery paths (via capsule, via PRODUCED) for R1/R2/R3.
    expect(radius.runIds.length).toBe(new Set(radius.runIds).size);

    // Unrelated branch never appears anywhere.
    for (const id of ["E9", "C9", "R9", "AG9", "SRC9"]) {
      expect(radius.evidenceIds).not.toContain(id);
      expect(radius.capsuleIds).not.toContain(id);
      expect(radius.runIds).not.toContain(id);
      expect(radius.agentIds).not.toContain(id);
    }
  });

  it("source trigger: starts from CITES, includes the citing evidence itself (unlike the evidence-trigger case) but excludes it from derivedEvidenceIds", () => {
    const graph = buildGraph();
    const radius = computeBlastRadius(graph, { kind: "source", id: "SRC1" }, "2026-08-27T00:00:00Z");

    expect(radius.evidenceIds).toEqual(["E1", "E2", "E3", "E4"]);
    // E1 arrived via CITES, not DERIVED_FROM/PRODUCED -- it is affected but not "contaminated".
    expect(radius.derivedEvidenceIds).toEqual(["E2", "E3", "E4"]);
    expect(radius.capsuleIds).toEqual(["C1", "C2", "C3"]);
    expect(radius.runIds).toEqual(["R1", "R2", "R3"]);
    expect(radius.agentIds).toEqual(["AG1", "AG2", "AG3"]);
  });

  it("source trigger with no citing evidence returns an empty radius", () => {
    const graph = buildGraph();
    const radius = computeBlastRadius(
      graph,
      { kind: "source", id: "SRC-UNKNOWN" },
      "2026-08-27T00:00:00Z",
    );
    expect(radius.evidenceIds).toEqual([]);
    expect(radius.capsuleIds).toEqual([]);
    expect(radius.runIds).toEqual([]);
    expect(radius.agentIds).toEqual([]);
    expect(radius.artifactIds).toEqual([]);
    expect(radius.derivedEvidenceIds).toEqual([]);
  });

  it("authorization_grant trigger: v1 has no grant nodes projected, returns an empty radius with the trigger recorded", () => {
    const graph = buildGraph();
    const radius = computeBlastRadius(
      graph,
      { kind: "authorization_grant", id: "grant_abc" },
      "2026-08-27T00:00:00Z",
    );
    expect(radius).toEqual({
      trigger: { kind: "authorization_grant", id: "grant_abc" },
      evidenceIds: [],
      capsuleIds: [],
      runIds: [],
      agentIds: [],
      artifactIds: [],
      derivedEvidenceIds: [],
      computedAt: "2026-08-27T00:00:00Z",
    });
  });

  it("DERIVED_FROM cycle (E3 <-> E4) terminates and each node is visited exactly once, in isolation", () => {
    const edges: GraphEdge[] = [
      edge("DERIVED_FROM:E3->E1", "E3", "E1", "DERIVED_FROM"),
      edge("DERIVED_FROM:E4->E3", "E4", "E3", "DERIVED_FROM"),
      edge("DERIVED_FROM:E3->E4", "E3", "E4", "DERIVED_FROM"),
    ];
    const graph: DependencyGraph = { nodes: [], edges, skippedDanglingRefs: 0 };

    const radius = computeBlastRadius(graph, { kind: "evidence", id: "E1" }, "2026-08-27T00:00:00Z");

    expect(radius.evidenceIds).toEqual(["E3", "E4"]);
    expect(radius.derivedEvidenceIds).toEqual(["E3", "E4"]);
  });

  it("is deterministic across repeated calls with the same input", () => {
    const graph = buildGraph();
    const first = computeBlastRadius(graph, { kind: "evidence", id: "E1" }, "2026-08-27T00:00:00Z");
    const second = computeBlastRadius(graph, { kind: "evidence", id: "E1" }, "2026-08-27T00:00:00Z");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("is deterministic under a reordering of the edge array (same source records, different order)", () => {
    const graph = buildGraph();
    const reordered: DependencyGraph = { ...graph, edges: [...graph.edges].reverse() };
    const canonical = computeBlastRadius(graph, { kind: "evidence", id: "E1" }, "2026-08-27T00:00:00Z");
    const shuffled = computeBlastRadius(reordered, { kind: "evidence", id: "E1" }, "2026-08-27T00:00:00Z");
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(canonical));
  });

  it("empty graph projects to an empty radius for an evidence trigger", () => {
    const graph: DependencyGraph = { nodes: [], edges: [], skippedDanglingRefs: 0 };
    const radius = computeBlastRadius(graph, { kind: "evidence", id: "E-ghost" }, "2026-08-27T00:00:00Z");
    expect(radius.evidenceIds).toEqual([]);
    expect(radius.capsuleIds).toEqual([]);
    expect(radius.runIds).toEqual([]);
    expect(radius.agentIds).toEqual([]);
    expect(radius.artifactIds).toEqual([]);
    expect(radius.derivedEvidenceIds).toEqual([]);
  });
});
