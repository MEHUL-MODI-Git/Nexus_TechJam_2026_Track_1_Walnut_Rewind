import type { DependenciesResponse, GraphNode, GraphNodeType } from "./types";
import { Chip, statusTone } from "./EvidenceCard";

const GROUP_ORDER: GraphNodeType[] = [
  "run",
  "context_capsule",
  "evidence",
  "source",
  "authorization_decision",
  "agent",
  "agent_version",
  "principal",
];

const GROUP_LABEL: Record<GraphNodeType, string> = {
  run: "Runs",
  context_capsule: "Context capsules",
  evidence: "Evidence",
  source: "Sources",
  authorization_decision: "Authorization decisions",
  agent: "Agents",
  agent_version: "Agent versions",
  principal: "Principals",
  runtime_event: "Runtime events",
  artifact: "Artifacts",
};

export function DependencyPanel({ dependencies }: { dependencies: DependenciesResponse }) {
  const { graph, focus } = dependencies;

  const byType = new Map<GraphNodeType, GraphNode[]>();
  for (const node of graph.nodes) {
    const bucket = byType.get(node.type);
    if (bucket) {
      bucket.push(node);
    } else {
      byType.set(node.type, [node]);
    }
  }

  const orderedTypes = [
    ...GROUP_ORDER.filter((type) => byType.has(type)),
    ...[...byType.keys()].filter((type) => !GROUP_ORDER.includes(type)),
  ];

  const edgeCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    edgeCounts.set(edge.type, (edgeCounts.get(edge.type) ?? 0) + 1);
  }

  return (
    <div className="walnut-dependencies">
      {orderedTypes.length === 0 ? (
        <p className="walnut-empty">No dependency graph nodes for this run.</p>
      ) : (
        orderedTypes.map((type) => (
          <section className="walnut-dep-group" key={type}>
            <h3>{GROUP_LABEL[type]}</h3>
            <ul className="walnut-dep-list">
              {(byType.get(type) ?? []).map((node) => (
                <li
                  key={node.id}
                  className={
                    "walnut-dep-item" + (node.id === focus ? " walnut-dep-focus" : "")
                  }
                >
                  <span>{node.label}</span>
                  {node.status !== null ? (
                    <Chip label={node.status} tone={statusTone(node.status)} />
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <div className="walnut-edge-summary">
        <h3>Edges</h3>
        {edgeCounts.size === 0 ? (
          <p className="walnut-empty">No edges.</p>
        ) : (
          <ul className="walnut-edge-list">
            {[...edgeCounts.entries()].map(([type, count]) => (
              <li key={type}>
                {type} ×{count}
              </li>
            ))}
          </ul>
        )}
      </div>

      {graph.skippedDanglingRefs > 0 ? (
        <p className="walnut-note walnut-warning">
          {graph.skippedDanglingRefs} dangling reference(s) skipped while building this graph.
        </p>
      ) : null}
    </div>
  );
}
