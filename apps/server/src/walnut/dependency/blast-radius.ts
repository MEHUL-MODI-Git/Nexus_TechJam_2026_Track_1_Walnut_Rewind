// Blast radius computation (spec 001 §15, docs/walnut/04-DATA-MODEL-API-CONTRACTS.md §15 + §23,
// INV-12: every reachable downstream Run appears exactly once).
//
// PURE function over an already-projected DependencyGraph: given a trigger (a compromised/
// revoked/superseded evidence, source, or authorization grant), computes everything downstream
// that is now contaminated. No Date.now() inside -- the caller supplies computedAt, so two calls
// against the same graph and the same computedAt are byte-identical (same determinism discipline
// as projector.ts's INV-11).
//
// Traversal (doc 04 §23 walkthrough: compromised E17 -> Cap24 -> Run91 -> artifacts):
//   Evidence X is downstream-tainted via, transitively and cycle-safely:
//     - capsules containing it (CONTAINS_EVIDENCE capsule->X, reverse walk)
//     - runs that USED_CAPSULE one of those capsules
//     - evidence DERIVED_FROM it (reverse walk: derived evidence points AT its contributor)
//     - evidence PRODUCED by an already-affected run
//     - artifacts CHANGED_ARTIFACT by an already-affected run, and artifacts DERIVED_FROM
//       contaminated evidence (artifact nodes/edges are projected from workspace manifests
//       since the artifact-projection change; artifacts are terminal — the walk never back-propagates from an
//       artifact to its producer run)
//     - agents that EXECUTED an already-affected run (reverse walk)
//   and recursion continues from every newly-affected evidence and every newly-affected run.
//
// kind "evidence": the trigger evidence is the seed. It participates in the walk (so a
// DERIVED_FROM cycle back to it still terminates, and its own capsule/run are correctly part of
// the radius) but it is never added to the output arrays -- the caller already knows it is the
// trigger; the radius describes what is affected BY it, not it itself.
//
// kind "source": there is no single seed node already known to the caller -- the seeds are
// discovered here as every evidence that CITES the source (reverse walk). These seeds ARE
// genuinely part of the blast radius (nobody outside this function knew they existed yet), so
// they DO go into evidenceIds. They did not arrive via DERIVED_FROM/PRODUCED propagation, so they
// are excluded from derivedEvidenceIds specifically -- that array is the "reached by contagion"
// subset of evidenceIds, not a second copy of the same set. (This is why the two arrays are not
// always equal, even though every OTHER piece of evidence in a radius arrives via one of those
// two edge kinds.)
//
// kind "authorization_grant": v1 has no grant nodes in the projected graph -- grants live only in
// the auth plane's JSON store and are never projected (dependency-rewind STATE.md, "other open
// threads"). Grant-triggered radii land once grant nodes are projected (post-hackathon). Until
// then this returns an empty radius with the trigger recorded, honestly, rather than guessing at
// a traversal with no edges to walk.

import type { BlastRadius, GraphEdgeType } from "../types.js";
import type { DependencyGraph } from "./projector.js";

export interface BlastRadiusTrigger {
  kind: "evidence" | "source" | "authorization_grant";
  id: string;
}

function byOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort(byOrdinal);
}

// Groups edges of a single type by one endpoint, returning the OTHER endpoint per group. This is
// the single place adjacency is built, so every lookup below only ever sees edges of the type it
// asked for -- no traversal branch can accidentally walk an edge it didn't mean to.
function groupBy(
  edges: DependencyGraph["edges"],
  type: GraphEdgeType,
  key: "from" | "to",
): Map<string, string[]> {
  const other = key === "from" ? "to" : "from";
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== type) continue;
    const groupKey = edge[key];
    const value = edge[other];
    const bucket = map.get(groupKey);
    if (bucket) {
      bucket.push(value);
    } else {
      map.set(groupKey, [value]);
    }
  }
  return map;
}

export function computeBlastRadius(
  graph: DependencyGraph,
  trigger: BlastRadiusTrigger,
  computedAt: string,
): BlastRadius {
  if (trigger.kind === "authorization_grant") {
    return {
      trigger,
      evidenceIds: [],
      capsuleIds: [],
      runIds: [],
      agentIds: [],
      artifactIds: [],
      derivedEvidenceIds: [],
      computedAt,
    };
  }

  // DERIVED_FROM edges now carry two derived kinds (evidence -> evidence and, since the
  // manifest handoff, artifact -> evidence). The reverse walk must route each derived id to its
  // correct bucket, so resolve node types up front (type-aware traversal).
  const nodeTypeById = new Map<string, string>();
  for (const node of graph.nodes) {
    nodeTypeById.set(node.id, node.type);
  }

  // Reverse: evidenceId -> capsuleIds that CONTAINS_EVIDENCE it.
  const capsulesByEvidence = groupBy(graph.edges, "CONTAINS_EVIDENCE", "to");
  // Reverse: capsuleId -> runIds that USED_CAPSULE it.
  const runsByCapsule = groupBy(graph.edges, "USED_CAPSULE", "to");
  // Reverse: contributorEvidenceId -> evidenceIds DERIVED_FROM it.
  const derivedByContributor = groupBy(graph.edges, "DERIVED_FROM", "to");
  // Forward: runId -> evidenceIds it PRODUCED.
  const evidenceByProducerRun = groupBy(graph.edges, "PRODUCED", "from");
  // Forward: runId -> artifactIds it CHANGED_ARTIFACT.
  const artifactsByRun = groupBy(graph.edges, "CHANGED_ARTIFACT", "from");
  // Reverse: runId -> agentIds that EXECUTED it.
  const agentsByRun = groupBy(graph.edges, "EXECUTED", "to");
  // Reverse: sourceId -> evidenceIds that CITES it.
  const evidenceBySource = groupBy(graph.edges, "CITES", "to");

  const evidenceVisited = new Set<string>();
  const capsuleVisited = new Set<string>();
  const runVisited = new Set<string>();
  const agentVisited = new Set<string>();
  const artifactVisited = new Set<string>();

  const evidenceIds: string[] = [];
  const derivedEvidenceIds: string[] = [];
  const capsuleIds: string[] = [];
  const runIds: string[] = [];
  const agentIds: string[] = [];
  const artifactIds: string[] = [];

  type QueueItem = { kind: "evidence"; id: string } | { kind: "run"; id: string };
  const queue: QueueItem[] = [];

  // Marks an evidence id as visited (cycle-safety) and, optionally, records it in the output.
  // `contaminated` controls derivedEvidenceIds membership: true for evidence reached via
  // DERIVED_FROM/PRODUCED propagation, false for evidence that seeded the walk via CITES (source
  // trigger) or is the evidence trigger itself (never recorded at all).
  function seedEvidence(evidenceId: string, includeInOutput: boolean, contaminated: boolean): void {
    if (evidenceVisited.has(evidenceId)) return;
    evidenceVisited.add(evidenceId);
    if (includeInOutput) {
      evidenceIds.push(evidenceId);
      if (contaminated) derivedEvidenceIds.push(evidenceId);
    }
    queue.push({ kind: "evidence", id: evidenceId });
  }

  if (trigger.kind === "evidence") {
    seedEvidence(trigger.id, false, false);
  } else {
    // kind === "source": every evidence citing the compromised source is a discovered seed.
    for (const evidenceId of evidenceBySource.get(trigger.id) ?? []) {
      seedEvidence(evidenceId, true, false);
    }
  }

  while (queue.length > 0) {
    const item = queue.shift() as QueueItem;
    if (item.kind === "evidence") {
      for (const capsuleId of capsulesByEvidence.get(item.id) ?? []) {
        if (capsuleVisited.has(capsuleId)) continue;
        capsuleVisited.add(capsuleId);
        capsuleIds.push(capsuleId);
        for (const runId of runsByCapsule.get(capsuleId) ?? []) {
          if (runVisited.has(runId)) continue;
          runVisited.add(runId);
          runIds.push(runId);
          queue.push({ kind: "run", id: runId });
        }
      }
      for (const derivedId of derivedByContributor.get(item.id) ?? []) {
        if (nodeTypeById.get(derivedId) === "artifact") {
          // An artifact derived from contaminated evidence is an affected artifact, never
          // "derived evidence" (doc 04 §15 buckets them separately).
          if (!artifactVisited.has(derivedId)) {
            artifactVisited.add(derivedId);
            artifactIds.push(derivedId);
          }
          continue;
        }
        seedEvidence(derivedId, true, true);
      }
    } else {
      for (const evidenceId of evidenceByProducerRun.get(item.id) ?? []) {
        seedEvidence(evidenceId, true, true);
      }
      for (const artifactId of artifactsByRun.get(item.id) ?? []) {
        if (artifactVisited.has(artifactId)) continue;
        artifactVisited.add(artifactId);
        artifactIds.push(artifactId);
      }
      for (const agentId of agentsByRun.get(item.id) ?? []) {
        if (agentVisited.has(agentId)) continue;
        agentVisited.add(agentId);
        agentIds.push(agentId);
      }
    }
  }

  return {
    trigger,
    evidenceIds: sortedUnique(evidenceIds),
    capsuleIds: sortedUnique(capsuleIds),
    runIds: sortedUnique(runIds),
    agentIds: sortedUnique(agentIds),
    artifactIds: sortedUnique(artifactIds),
    derivedEvidenceIds: sortedUnique(derivedEvidenceIds),
    computedAt,
  };
}
