// Dependency graph projector (spec 001 GraphNode/GraphEdge, docs/walnut/04 §13, §23).
//
// INV-11: this is a PURE, DETERMINISTIC function from source records to a graph. No incremental
// state, no caches, no timestamps in the output, no randomness. Rebuilding from the same source
// records — in any input order — yields a byte-identical graph: same nodes, same edges, same
// order (all output arrays are sorted by id before being returned).
//
// The graph is a read-only projection over records owned elsewhere (upstream store snapshots,
// evidence/context stores). This module mints nodes/edges; it never mutates its input and never
// invents a node for a reference that does not resolve — dangling references are skipped and
// counted, never silently dropped and never phantom-minted.

import type {
  AgentVersion,
  ArtifactRecord,
  AuthorizationDecision,
  ContextCapsule,
  Evidence,
  GraphEdge,
  GraphEdgeType,
  GraphNode,
  GraphNodeType,
  ReconciliationRecord,
  SourcePointer,
  WalnutRunState,
} from "../types.js";

// One run's WalnutRunState timeline, as read from ../dependency/run-state.ts's
// WalnutRunStateStore. Declared structurally here (rather than importing RunStateRecord /
// RunStateHistoryEntry) so this module keeps depending only on ../types.js -- projectGraph stays
// a pure function of plain data, not of another module's storage shape.
export interface ProjectionRunState {
  runId: string;
  state: WalnutRunState;
  history: Array<{
    state: WalnutRunState;
    triggerEvidenceId: string | null;
    byRunId: string | null;
  }>;
}

export interface ProjectionInput {
  agents: Array<{ id: string; name: string; status: string }>;
  runs: Array<{ id: string; agentId: string; status: string }>;
  agentVersions: AgentVersion[];
  capsules: ContextCapsule[];
  evidence: Evidence[]; // ALL versions of all evidence
  decisions: AuthorizationDecision[];
  pointers: SourcePointer[];
  // Workspace before/after manifests feed artifact nodes,
  // CHANGED_ARTIFACT edges, and artifact-derivation edges.
  artifacts: ArtifactRecord[];
  runStates: ProjectionRunState[];
  reconciliations: ReconciliationRecord[];
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  skippedDanglingRefs: number;
}

function mkNode(
  id: string,
  type: GraphNodeType,
  label: string,
  status: string | null,
  metadata: Record<string, unknown>,
): GraphNode {
  return { id, type, label, status, metadata };
}

// Plain ordinal string comparison. Deliberately not localeCompare: locale collation is
// environment-dependent (ICU data, default locale) and INV-11 requires the same source records
// to project to a byte-identical graph on every machine, not just on the machine that ran the
// test.
function byOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Groups evidence records by evidenceId and keeps only the highest-version record per group —
// the "current" version. Deterministic regardless of input array order because version numbers
// are unique per evidenceId in the data model (comparison is a strict numeric max, not
// first-seen-wins).
function currentEvidenceByStableId(evidence: Evidence[]): Map<string, Evidence> {
  const byId = new Map<string, Evidence>();
  for (const ev of evidence) {
    const existing = byId.get(ev.evidenceId);
    if (!existing || ev.version > existing.version) {
      byId.set(ev.evidenceId, ev);
    }
  }
  return byId;
}

// Maps each distinct sourceId to a representative pointer's kind. When multiple pointers share a
// sourceId, the pointer with the lexicographically smallest pointerId is chosen — a fixed,
// order-independent tie-break so the result never depends on input array order.
function representativeKindBySourceId(pointers: SourcePointer[]): Map<string, string> {
  const bySourceId = new Map<string, SourcePointer>();
  for (const pointer of pointers) {
    const existing = bySourceId.get(pointer.sourceId);
    if (!existing || pointer.pointerId < existing.pointerId) {
      bySourceId.set(pointer.sourceId, pointer);
    }
  }
  const result = new Map<string, string>();
  for (const [sourceId, pointer] of [...bySourceId.entries()].sort((a, b) =>
    byOrdinal(a[0], b[0]),
  )) {
    result.set(sourceId, pointer.kind);
  }
  return result;
}

export function projectGraph(input: ProjectionInput): DependencyGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  let skippedDanglingRefs = 0;

  // -- Node minting --

  for (const agent of input.agents) {
    nodes.set(agent.id, mkNode(agent.id, "agent", agent.name, agent.status, {}));
  }

  const principalIds = new Set<string>();
  for (const capsule of input.capsules) {
    principalIds.add(capsule.agentPrincipalId);
    if (capsule.onBehalfOfPrincipalId !== null) {
      principalIds.add(capsule.onBehalfOfPrincipalId);
    }
  }
  for (const principalId of [...principalIds].sort()) {
    nodes.set(principalId, mkNode(principalId, "principal", principalId, null, {}));
  }

  for (const version of input.agentVersions) {
    nodes.set(
      version.versionId,
      mkNode(version.versionId, "agent_version", `${version.name} v${version.version}`, null, {
        version: version.version,
        configHash: version.configHash,
      }),
    );
  }

  const runStateByRunId = new Map<string, ProjectionRunState>();
  for (const runState of input.runStates) {
    runStateByRunId.set(runState.runId, runState);
  }

  for (const run of input.runs) {
    const runState = runStateByRunId.get(run.id);
    nodes.set(
      run.id,
      mkNode(
        run.id,
        "run",
        `Run ${run.id.slice(0, 8)}`,
        run.status,
        runState ? { walnutState: runState.state } : {},
      ),
    );
  }

  for (const capsule of input.capsules) {
    nodes.set(
      capsule.capsuleId,
      mkNode(capsule.capsuleId, "context_capsule", capsule.capsuleId, null, {
        policyRevision: capsule.policyRevision,
        evidenceCount: capsule.evidence.length,
        deniedCount: capsule.deniedEvidenceDecisionIds.length,
      }),
    );
  }

  const currentEvidence = currentEvidenceByStableId(input.evidence);
  for (const ev of currentEvidence.values()) {
    nodes.set(
      ev.evidenceId,
      mkNode(ev.evidenceId, "evidence", ev.claim.slice(0, 80), ev.status, {
        version: ev.version,
        classification: ev.classification,
      }),
    );
  }

  const sourceKindBySourceId = representativeKindBySourceId(input.pointers);
  for (const [sourceId, kind] of sourceKindBySourceId) {
    nodes.set(sourceId, mkNode(sourceId, "source", sourceId, null, { kind }));
  }

  for (const decision of input.decisions) {
    nodes.set(
      decision.decisionId,
      mkNode(
        decision.decisionId,
        "authorization_decision",
        `${decision.result}:${decision.reasonCode}`,
        decision.result,
        { reasonCode: decision.reasonCode, policyRevision: decision.policyRevision },
      ),
    );
  }

  for (const artifact of input.artifacts) {
    nodes.set(
      artifact.artifactId,
      mkNode(artifact.artifactId, "artifact", artifact.relativePath.slice(0, 80), artifact.state, {
        state: artifact.state,
        classification: artifact.classification,
      }),
    );
  }

  const nodeIds = new Set(nodes.keys());

  // -- Edge minting --
  //
  // Every edge is routed through addEdge, which is the single place that enforces: an edge is
  // never minted unless both endpoints were already minted as nodes above. A reference to a
  // node that does not exist is a dangling ref — it is skipped and counted, never used to
  // conjure a phantom node.

  function addEdge(type: GraphEdgeType, from: string, to: string): void {
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      skippedDanglingRefs += 1;
      return;
    }
    const id = `${type}:${from}->${to}`;
    if (!edges.has(id)) {
      edges.set(id, { id, from, to, type, metadata: {} });
    }
  }

  for (const run of input.runs) {
    addEdge("EXECUTED", run.agentId, run.id);
  }

  for (const capsule of input.capsules) {
    if (capsule.onBehalfOfPrincipalId !== null) {
      addEdge("ACTS_ON_BEHALF_OF", capsule.agentId, capsule.onBehalfOfPrincipalId);
    }
  }

  for (const version of input.agentVersions) {
    addEdge("OWNS", version.agentId, version.versionId);
  }

  for (const capsule of input.capsules) {
    addEdge("USED_CAPSULE", capsule.runId, capsule.capsuleId);
  }

  for (const capsule of input.capsules) {
    for (const ref of capsule.evidence) {
      addEdge("CONTAINS_EVIDENCE", capsule.capsuleId, ref.evidenceId);
    }
  }

  for (const capsule of input.capsules) {
    for (const ref of capsule.evidence) {
      addEdge("AUTHORIZED_BY", ref.evidenceId, ref.authorizationDecisionId);
    }
  }

  const pointerById = new Map<string, SourcePointer>();
  for (const pointer of input.pointers) {
    pointerById.set(pointer.pointerId, pointer);
  }

  for (const ev of currentEvidence.values()) {
    addEdge("PRODUCED", ev.producerRunId, ev.evidenceId);
  }

  for (const ev of currentEvidence.values()) {
    // Not a node-existence dangling ref: the pointer record itself is what is missing, so there
    // is no candidate "to" endpoint to test. Per spec, this is simply skipped, uncounted.
    const pointer = pointerById.get(ev.sourcePointerId);
    if (pointer) {
      addEdge("CITES", ev.evidenceId, pointer.sourceId);
    }
  }

  for (const ev of currentEvidence.values()) {
    for (const derivedFromId of ev.derivedFromEvidenceIds) {
      addEdge("DERIVED_FROM", ev.evidenceId, derivedFromId);
    }
  }

  for (const ev of currentEvidence.values()) {
    if (ev.supersedesEvidenceId !== null) {
      addEdge("SUPERSEDES", ev.evidenceId, ev.supersedesEvidenceId);
    }
  }

  // TAINTS evidence->run: one edge per (triggerEvidenceId, runId) pair with a TAINTED history
  // entry, deduped by addEdge's id scheme. A triggerEvidenceId that does not resolve to a minted
  // evidence node is a dangling ref like any other -- skipped and counted, never phantom-minted.
  for (const runState of input.runStates) {
    for (const entry of runState.history) {
      if (entry.state === "TAINTED" && entry.triggerEvidenceId !== null) {
        addEdge("TAINTS", entry.triggerEvidenceId, runState.runId);
      }
    }
  }

  // RECOVERED_BY staleRun->replacementRun: one edge per ReconciliationRecord.
  for (const reconciliation of input.reconciliations) {
    addEdge("RECOVERED_BY", reconciliation.staleRunId, reconciliation.replacementRunId);
  }

  for (const artifact of input.artifacts) {
    addEdge("CHANGED_ARTIFACT", artifact.runId, artifact.artifactId);
  }

  // Artifact derivation reuses DERIVED_FROM with the existing direction convention: the DERIVED
  // record points AT its contributor (artifact -> evidence), exactly like evidence -> evidence.
  for (const artifact of input.artifacts) {
    for (const contributorId of artifact.derivedFromEvidenceIds) {
      addEdge("DERIVED_FROM", artifact.artifactId, contributorId);
    }
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => byOrdinal(a.id, b.id)),
    edges: [...edges.values()].sort((a, b) => byOrdinal(a.id, b.id)),
    skippedDanglingRefs,
  };
}
