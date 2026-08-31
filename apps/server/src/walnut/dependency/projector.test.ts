import { describe, expect, it } from "vitest";
import type {
  AgentVersion,
  AuthorizationDecision,
  ContextCapsule,
  ContextEvidenceRef,
  Evidence,
  SourcePointer,
} from "../types.js";
import { projectGraph, type ProjectionInput } from "./projector.js";

// -- Hand-built fixture --------------------------------------------------------------------
//
// 2 agents, 1 principal ("prin-alice", reachable via both agentPrincipalId and
// onBehalfOfPrincipalId on cap-1), 2 runs, 2 agent versions, 2 capsules (cap-1 has 2 evidence
// refs + 1 denied decision id; cap-2 is empty), 3 evidence records (ev-a, ev-b v1 AND v2, ev-c)
// where ev-b's CURRENT version (v2) supersedes ev-a and ev-c derivedFrom ev-a, 2 pointers
// sharing one sourceId ("src-shared") + 1 pointer with a distinct sourceId ("src-other"), and 3
// decisions (2 ALLOW, 1 DENY).

function baseInput(): ProjectionInput {
  const agents: ProjectionInput["agents"] = [
    { id: "ag-1", name: "Agent One", status: "active" },
    { id: "ag-2", name: "Agent Two", status: "idle" },
  ];

  const runs: ProjectionInput["runs"] = [
    { id: "run-001", agentId: "ag-1", status: "completed" },
    { id: "run-002", agentId: "ag-2", status: "running" },
  ];

  const agentVersions: AgentVersion[] = [
    {
      versionId: "ver-1",
      agentId: "ag-1",
      version: 1,
      name: "Agent One",
      description: "",
      workspaceInstructions: "",
      configHash: "hash-ver-1",
      validFrom: "2026-01-01T00:00:00Z",
      validTo: null,
      recordedAt: "2026-01-01T00:00:00Z",
      txClosedAt: null,
      supersedesVersionId: null,
    },
    {
      versionId: "ver-2",
      agentId: "ag-2",
      version: 1,
      name: "Agent Two",
      description: "",
      workspaceInstructions: "",
      configHash: "hash-ver-2",
      validFrom: "2026-01-01T00:00:00Z",
      validTo: null,
      recordedAt: "2026-01-01T00:00:00Z",
      txClosedAt: null,
      supersedesVersionId: null,
    },
  ];

  const refA: ContextEvidenceRef = {
    evidenceId: "ev-a",
    evidenceVersion: 1,
    authorizationDecisionId: "dec-1",
    sourcePointerId: "ptr-1",
    sourceHash: "sh-1",
    citationId: null,
    citationVerification: null,
    classification: "INTERNAL",
    validFrom: null,
    validTo: null,
    recordedAt: "2026-01-01T00:00:00Z",
  };

  const refB: ContextEvidenceRef = {
    evidenceId: "ev-b",
    evidenceVersion: 2,
    authorizationDecisionId: "dec-2",
    sourcePointerId: "ptr-2",
    sourceHash: "sh-2",
    citationId: null,
    citationVerification: null,
    classification: "INTERNAL",
    validFrom: null,
    validTo: null,
    recordedAt: "2026-01-01T00:00:00Z",
  };

  const capsules: ContextCapsule[] = [
    {
      schemaVersion: 1,
      capsuleId: "cap-1",
      runId: "run-001",
      agentId: "ag-1",
      agentVersionId: "ver-1",
      agentPrincipalId: "prin-alice",
      onBehalfOfPrincipalId: "prin-alice",
      policyRevision: 3,
      policyHash: "ph-1",
      evidence: [refA, refB],
      deniedEvidenceDecisionIds: ["dec-3"],
      createdAt: "2026-01-01T00:00:00Z",
      transactionCut: "2026-01-01T00:00:00Z",
      capsuleHash: "chash-1",
    },
    {
      schemaVersion: 1,
      capsuleId: "cap-2",
      runId: "run-002",
      agentId: "ag-2",
      agentVersionId: "ver-2",
      agentPrincipalId: "prin-alice",
      onBehalfOfPrincipalId: null,
      policyRevision: 1,
      policyHash: "ph-2",
      evidence: [],
      deniedEvidenceDecisionIds: [],
      createdAt: "2026-01-01T00:00:00Z",
      transactionCut: "2026-01-01T00:00:00Z",
      capsuleHash: "chash-2",
    },
  ];

  const evidence: Evidence[] = [
    {
      evidenceId: "ev-a",
      version: 1,
      subjectKey: null,
      predicate: null,
      claim: "Evidence A claim text",
      producerAgentId: "ag-1",
      producerRunId: "run-001",
      sourcePointerId: "ptr-1",
      citationId: null,
      classification: "INTERNAL",
      requiredScopes: [],
      status: "ACTIVE",
      validFrom: null,
      validTo: null,
      recordedAt: "2026-01-01T00:00:00Z",
      txClosedAt: null,
      supersedesEvidenceId: null,
      derivedFromEvidenceIds: [],
      claimHash: "hash-a",
    },
    {
      evidenceId: "ev-b",
      version: 1,
      subjectKey: null,
      predicate: null,
      claim: "Evidence B claim text v1",
      producerAgentId: "ag-2",
      producerRunId: "run-002",
      sourcePointerId: "ptr-2",
      citationId: null,
      classification: "INTERNAL",
      requiredScopes: [],
      status: "SUPERSEDED",
      validFrom: null,
      validTo: null,
      recordedAt: "2026-01-01T00:00:00Z",
      txClosedAt: "2026-01-02T00:00:00Z",
      supersedesEvidenceId: null,
      derivedFromEvidenceIds: [],
      claimHash: "hash-b1",
    },
    {
      evidenceId: "ev-b",
      version: 2,
      subjectKey: null,
      predicate: null,
      claim: "Evidence B claim text v2",
      producerAgentId: "ag-2",
      producerRunId: "run-002",
      sourcePointerId: "ptr-2",
      citationId: null,
      classification: "INTERNAL",
      requiredScopes: [],
      status: "ACTIVE",
      validFrom: null,
      validTo: null,
      recordedAt: "2026-01-02T00:00:00Z",
      txClosedAt: null,
      supersedesEvidenceId: "ev-a",
      derivedFromEvidenceIds: [],
      claimHash: "hash-b2",
    },
    {
      evidenceId: "ev-c",
      version: 1,
      subjectKey: null,
      predicate: null,
      claim: "Evidence C claim text",
      producerAgentId: "ag-1",
      producerRunId: "run-001",
      sourcePointerId: "ptr-3",
      citationId: null,
      classification: "INTERNAL",
      requiredScopes: [],
      status: "ACTIVE",
      validFrom: null,
      validTo: null,
      recordedAt: "2026-01-01T00:00:00Z",
      txClosedAt: null,
      supersedesEvidenceId: null,
      derivedFromEvidenceIds: ["ev-a"],
      claimHash: "hash-c",
    },
  ];

  const decisions: AuthorizationDecision[] = [
    {
      decisionId: "dec-1",
      runId: "run-001",
      capsuleId: "cap-1",
      agentId: "ag-1",
      principalId: "prin-alice",
      evidenceId: "ev-a",
      evidenceVersion: 1,
      action: "consume",
      resource: "res-a",
      requiredScopes: [],
      matchedAgentGrantIds: [],
      matchedPrincipalGrantIds: [],
      policyRevision: 3,
      policyHash: "ph-1",
      result: "ALLOW",
      reasonCode: "AUTHORIZED",
      recordedAt: "2026-01-01T00:00:00Z",
    },
    {
      decisionId: "dec-2",
      runId: "run-001",
      capsuleId: "cap-1",
      agentId: "ag-1",
      principalId: "prin-alice",
      evidenceId: "ev-b",
      evidenceVersion: 2,
      action: "consume",
      resource: "res-b",
      requiredScopes: [],
      matchedAgentGrantIds: [],
      matchedPrincipalGrantIds: [],
      policyRevision: 3,
      policyHash: "ph-1",
      result: "ALLOW",
      reasonCode: "AUTHORIZED",
      recordedAt: "2026-01-01T00:00:00Z",
    },
    {
      decisionId: "dec-3",
      runId: "run-001",
      capsuleId: "cap-1",
      agentId: "ag-1",
      principalId: "prin-alice",
      evidenceId: "ev-c",
      evidenceVersion: 1,
      action: "consume",
      resource: "res-c",
      requiredScopes: [],
      matchedAgentGrantIds: [],
      matchedPrincipalGrantIds: [],
      policyRevision: 3,
      policyHash: "ph-1",
      result: "DENY",
      reasonCode: "CLASSIFICATION_DENIED",
      recordedAt: "2026-01-01T00:00:00Z",
    },
  ];

  const pointers: SourcePointer[] = [
    {
      pointerId: "ptr-1",
      sourceId: "src-shared",
      kind: "workspace_file",
      locator: { path: "a.txt" },
      contentHash: "pch-1",
      mediaType: "text/plain",
      charStart: null,
      charEnd: null,
      lineStart: null,
      lineEnd: null,
      observedAt: "2026-01-01T00:00:00Z",
      classification: "INTERNAL",
    },
    {
      pointerId: "ptr-2",
      sourceId: "src-shared",
      kind: "workspace_lines",
      locator: { path: "a.txt", lineStart: 1 },
      contentHash: "pch-2",
      mediaType: "text/plain",
      charStart: null,
      charEnd: null,
      lineStart: 1,
      lineEnd: 2,
      observedAt: "2026-01-01T00:00:00Z",
      classification: "INTERNAL",
    },
    {
      pointerId: "ptr-3",
      sourceId: "src-other",
      kind: "runtime_event",
      locator: { eventId: "rte-1" },
      contentHash: "pch-3",
      mediaType: null,
      charStart: null,
      charEnd: null,
      lineStart: null,
      lineEnd: null,
      observedAt: "2026-01-01T00:00:00Z",
      classification: "INTERNAL",
    },
  ];

  return {
    agents,
    runs,
    agentVersions,
    capsules,
    evidence,
    decisions,
    pointers,
    runStates: [],
    reconciliations: [],
    artifacts: [],
  };
}

const EXPECTED_NODE_IDS = [
  "ag-1",
  "ag-2",
  "cap-1",
  "cap-2",
  "dec-1",
  "dec-2",
  "dec-3",
  "ev-a",
  "ev-b",
  "ev-c",
  "prin-alice",
  "run-001",
  "run-002",
  "src-other",
  "src-shared",
  "ver-1",
  "ver-2",
];

const EXPECTED_EDGE_IDS = [
  "ACTS_ON_BEHALF_OF:ag-1->prin-alice",
  "AUTHORIZED_BY:ev-a->dec-1",
  "AUTHORIZED_BY:ev-b->dec-2",
  "CITES:ev-a->src-shared",
  "CITES:ev-b->src-shared",
  "CITES:ev-c->src-other",
  "CONTAINS_EVIDENCE:cap-1->ev-a",
  "CONTAINS_EVIDENCE:cap-1->ev-b",
  "DERIVED_FROM:ev-c->ev-a",
  "EXECUTED:ag-1->run-001",
  "EXECUTED:ag-2->run-002",
  "OWNS:ag-1->ver-1",
  "OWNS:ag-2->ver-2",
  "PRODUCED:run-001->ev-a",
  "PRODUCED:run-001->ev-c",
  "PRODUCED:run-002->ev-b",
  "SUPERSEDES:ev-b->ev-a",
  "USED_CAPSULE:run-001->cap-1",
  "USED_CAPSULE:run-002->cap-2",
];

function shuffled(input: ProjectionInput): ProjectionInput {
  // A deterministic reordering (reverse) of every array in the input — not the same order as
  // baseInput(), but drawn from the exact same source records. INV-11 requires the projection to
  // be indifferent to this.
  return {
    agents: [...input.agents].reverse(),
    runs: [...input.runs].reverse(),
    agentVersions: [...input.agentVersions].reverse(),
    capsules: [...input.capsules].reverse().map((c) => ({ ...c, evidence: [...c.evidence].reverse() })),
    evidence: [...input.evidence].reverse(),
    decisions: [...input.decisions].reverse(),
    pointers: [...input.pointers].reverse(),
    runStates: [...input.runStates].reverse(),
    reconciliations: [...input.reconciliations].reverse(),
    artifacts: [...input.artifacts].reverse(),
  };
}

describe("projectGraph", () => {
  it("INV-11: is deterministic across repeated calls with the same input", () => {
    const input = baseInput();
    const first = projectGraph(input);
    const second = projectGraph(input);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("INV-11: is deterministic across input array reordering (rebuild-from-source)", () => {
    const canonical = projectGraph(baseInput());
    const reordered = projectGraph(shuffled(baseInput()));
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(canonical));
  });

  it("mints exactly the expected node id set, sorted", () => {
    const graph = projectGraph(baseInput());
    expect(graph.nodes.map((n) => n.id)).toEqual(EXPECTED_NODE_IDS);
  });

  it("mints exactly the expected edge id set, sorted", () => {
    const graph = projectGraph(baseInput());
    expect(graph.edges.map((e) => e.id)).toEqual(EXPECTED_EDGE_IDS);
  });

  it("has zero skipped dangling refs on a fully-resolving fixture", () => {
    const graph = projectGraph(baseInput());
    expect(graph.skippedDanglingRefs).toBe(0);
  });

  it("current-version selection: ev-b node carries v2 metadata, and its SUPERSEDES edge comes from v2's field (v1 has supersedesEvidenceId: null)", () => {
    const graph = projectGraph(baseInput());
    const evB = graph.nodes.find((n) => n.id === "ev-b");
    expect(evB).toBeDefined();
    expect(evB?.metadata["version"]).toBe(2);
    expect(evB?.status).toBe("ACTIVE"); // v2's status, not v1's SUPERSEDED
    expect(graph.edges.some((e) => e.id === "SUPERSEDES:ev-b->ev-a")).toBe(true);
  });

  it("dangling ref: a capsule evidence ref to a nonexistent evidence id is skipped, counted, and mints no phantom node", () => {
    const input = baseInput();
    const ghostRef: ContextEvidenceRef = {
      evidenceId: "ev-ghost",
      evidenceVersion: 1,
      authorizationDecisionId: "dec-1",
      sourcePointerId: "ptr-1",
      sourceHash: "sh-ghost",
      citationId: null,
      citationVerification: null,
      classification: "INTERNAL",
      validFrom: null,
      validTo: null,
      recordedAt: "2026-01-01T00:00:00Z",
    };
    const cap2 = input.capsules.find((c) => c.capsuleId === "cap-2");
    if (!cap2) throw new Error("fixture invariant: cap-2 must exist");
    cap2.evidence.push(ghostRef);

    const graph = projectGraph(input);

    // No phantom "ev-ghost" node.
    expect(graph.nodes.some((n) => n.id === "ev-ghost")).toBe(false);
    // Neither edge that would have referenced it was minted.
    expect(graph.edges.some((e) => e.id.includes("ev-ghost"))).toBe(false);
    // CONTAINS_EVIDENCE (cap-2 -> ev-ghost) and AUTHORIZED_BY (ev-ghost -> dec-1) each counted once.
    expect(graph.skippedDanglingRefs).toBe(2);
    // Everything else in the graph is unaffected.
    expect(graph.nodes.map((n) => n.id)).toEqual(EXPECTED_NODE_IDS);
  });

  it("empty input projects to an empty graph with zero skipped refs", () => {
    const graph = projectGraph({
      agents: [],
      runs: [],
      agentVersions: [],
      capsules: [],
      evidence: [],
      decisions: [],
      pointers: [],
      runStates: [],
      reconciliations: [],
      artifacts: [],
    });
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.skippedDanglingRefs).toBe(0);
  });

  it("TAINTED run-state history mints a TAINTS edge from the trigger evidence, and a reconciliation record mints RECOVERED_BY; dangling trigger evidence ids are skipped and counted", () => {
    const input = baseInput();
    input.runStates = [
      {
        runId: "run-001",
        state: "TAINTED",
        history: [
          { state: "STALE", triggerEvidenceId: null, byRunId: null },
          { state: "TAINTED", triggerEvidenceId: "ev-a", byRunId: null },
          // Dangling: no evidence node "ev-ghost" exists -- skipped and counted, not phantom-minted.
          { state: "TAINTED", triggerEvidenceId: "ev-ghost", byRunId: null },
        ],
      },
      {
        runId: "run-002",
        state: "RECOVERED",
        history: [{ state: "RECOVERED", triggerEvidenceId: null, byRunId: "run-001" }],
      },
    ];
    input.reconciliations = [
      {
        reconciliationId: "rec_1",
        triggerEvidenceIds: ["ev-a"],
        staleRunId: "run-002",
        replacementRunId: "run-001",
        oldCapsuleId: "cap-2",
        newCapsuleId: "cap-1",
        createdAt: "2026-01-03T00:00:00Z",
        result: "COMPLETED",
      },
    ];

    const graph = projectGraph(input);

    expect(graph.edges.some((e) => e.id === "TAINTS:ev-a->run-001")).toBe(true);
    expect(graph.edges.some((e) => e.id === "RECOVERED_BY:run-002->run-001")).toBe(true);
    // The dangling triggerEvidenceId "ev-ghost" contributed exactly one skipped ref.
    expect(graph.skippedDanglingRefs).toBe(1);

    const run001 = graph.nodes.find((n) => n.id === "run-001");
    expect(run001?.metadata["walnutState"]).toBe("TAINTED");
    const run002 = graph.nodes.find((n) => n.id === "run-002");
    expect(run002?.metadata["walnutState"]).toBe("RECOVERED");
    // Starter-kit status is untouched by the walnut overlay.
    expect(run001?.status).toBe("completed");
  });

  it("artifact records mint artifact nodes, CHANGED_ARTIFACT and DERIVED_FROM edges; dangling refs counted", () => {
    const input = baseInput();
    input.artifacts = [
      {
        artifactId: "art_00000000-0000-4000-8000-000000000001",
        runId: "run-001",
        agentId: "ag-1",
        relativePath: "launch-strategy.md",
        state: "CREATED",
        contentHashBefore: null,
        contentHashAfter: "sha256:" + "0".repeat(64),
        classification: "INTERNAL",
        recordedAt: "2026-08-27T00:00:00.000Z",
        derivedFromEvidenceIds: ["ev-a", "ev-ghost-contributor"],
      },
    ];
    const graph = projectGraph(input);

    const artifactNode = graph.nodes.find(
      (node) => node.id === "art_00000000-0000-4000-8000-000000000001",
    );
    expect(artifactNode).toMatchObject({
      type: "artifact",
      label: "launch-strategy.md",
      status: "CREATED",
    });

    const edgeIds = graph.edges.map((edge) => edge.id);
    expect(edgeIds).toContain(
      "CHANGED_ARTIFACT:run-001->art_00000000-0000-4000-8000-000000000001",
    );
    expect(edgeIds).toContain(
      "DERIVED_FROM:art_00000000-0000-4000-8000-000000000001->ev-a",
    );
    // The unknown contributor is a dangling ref: skipped and counted, never phantom-minted.
    expect(graph.nodes.some((node) => node.id === "ev-ghost-contributor")).toBe(false);
    expect(graph.skippedDanglingRefs).toBeGreaterThanOrEqual(1);

    // Determinism holds with artifacts present.
    expect(JSON.stringify(projectGraph(input))).toBe(JSON.stringify(graph));
  });
});
