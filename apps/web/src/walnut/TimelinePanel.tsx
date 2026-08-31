import { useState } from "react";
import { api } from "../api";
import type { RunEvidenceResponse, RunEventsResponse } from "./types";
import { EvidenceCard } from "./EvidenceCard";

interface ActionState {
  loading: boolean;
  error: string | null;
  taintedCount: number | null;
}

const emptyActionState: ActionState = { loading: false, error: null, taintedCount: null };

export function TimelinePanel({
  evidence,
  events,
  onEvidenceChanged,
}: {
  evidence: RunEvidenceResponse;
  events: RunEventsResponse | null;
  onEvidenceChanged?: () => void;
}) {
  const [actions, setActions] = useState<Record<string, ActionState>>({});

  // window.prompt for the reason is a deliberate hackathon-scale shortcut (per the assignment) —
  // not a UI polish gap, a stated one. Revoke/compromise are middleware-enforced regardless of
  // where the reason string came from (HC-2): this button only ever calls the same REST route a
  // curl command would.
  function runAction(evidenceId: string, kind: "revoke" | "compromise"): void {
    const reason = window.prompt(
      kind === "revoke"
        ? "Reason for revoking this evidence:"
        : "Reason for marking this evidence compromised:",
    );
    if (reason === null || reason.trim().length === 0) return;

    setActions((previous) => ({
      ...previous,
      [evidenceId]: { loading: true, error: null, taintedCount: null },
    }));

    const call = kind === "revoke" ? api.revokeEvidence : api.compromiseEvidence;
    call(evidenceId, reason.trim())
      .then((result) => {
        setActions((previous) => ({
          ...previous,
          [evidenceId]: { loading: false, error: null, taintedCount: result.blastRadius.runIds.length },
        }));
        onEvidenceChanged?.();
      })
      .catch((cause) => {
        setActions((previous) => ({
          ...previous,
          [evidenceId]: {
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
            taintedCount: null,
          },
        }));
      });
  }

  return (
    <div className="walnut-timeline">
      <section className="walnut-timeline-section">
        <h3>Consumed</h3>
        {evidence.consumed.length === 0 ? (
          <p className="walnut-empty">No evidence entered this capsule.</p>
        ) : (
          <ul className="walnut-evidence-list">
            {evidence.consumed.map((item) => (
              <li key={item.ref.evidenceId + ":" + item.ref.evidenceVersion}>
                <EvidenceCard
                  claim={item.evidence.claim}
                  classification={item.ref.classification}
                  status={item.evidence.status}
                  citationVerification={item.ref.citationVerification}
                  sourceHash={item.ref.sourceHash}
                />
                <EvidenceActions
                  evidenceId={item.ref.evidenceId}
                  state={actions[item.ref.evidenceId] ?? emptyActionState}
                  onAction={runAction}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="walnut-timeline-section">
        <h3>Produced</h3>
        {evidence.produced.length === 0 ? (
          <p className="walnut-empty">This run published no evidence.</p>
        ) : (
          <ul className="walnut-evidence-list">
            {evidence.produced.map((item) => (
              <li key={item.evidenceId + ":" + item.version}>
                <EvidenceCard claim={item.claim} classification={item.classification} status={item.status} />
                <EvidenceActions
                  evidenceId={item.evidenceId}
                  state={actions[item.evidenceId] ?? emptyActionState}
                  onAction={runAction}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="walnut-timeline-section walnut-denied-section">
        <h3>Denied before context</h3>
        {evidence.deniedDecisions.length === 0 ? (
          <p className="walnut-empty">No candidate evidence was denied for this run.</p>
        ) : (
          <ul className="walnut-evidence-list">
            {evidence.deniedDecisions.map(({ decision, evidence: deniedEvidence }) => (
              <li key={decision.decisionId} className="walnut-denied-decision">
                {deniedEvidence ? (
                  <EvidenceCard
                    claim={deniedEvidence.claim}
                    classification={deniedEvidence.classification}
                    status={deniedEvidence.status}
                  />
                ) : (
                  <div className="walnut-evidence-card">
                    <p className="walnut-evidence-claim">Evidence {decision.evidenceId}</p>
                  </div>
                )}
                <div className="walnut-denied-meta">
                  <span className="walnut-chip walnut-chip-bad">Denied</span>
                  <strong>{decision.reasonCode}</strong>
                  <span>policy revision {decision.policyRevision}</span>
                  <code>{decision.decisionId}</code>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {events ? <FlightRecorder events={events} /> : null}
    </div>
  );
}

function FlightRecorder({ events }: { events: RunEventsResponse }) {
  const rejections = events.events.filter((event) => event.kind === "evidence.proposal_rejected");
  return (
    <section className="walnut-timeline-section walnut-flight-recorder">
      <div className="walnut-flight-heading">
        <div>
          <span className="walnut-label">Append-only flight recorder</span>
          <h3>{events.events.length} correlated events</h3>
        </div>
        <span className={events.chain.ok ? "walnut-chip walnut-chip-good" : "walnut-chip walnut-chip-bad"}>
          {events.chain.ok ? "chain verified" : "chain broken"}
        </span>
      </div>
      {rejections.length > 0 ? (
        <div className="walnut-rejection-list">
          {rejections.map((event) => {
            const payload = event.safePayload as {
              proposalIndex?: number;
              reason?: string;
              detail?: string;
            };
            return (
              <article key={event.eventId} className="walnut-rejection-event">
                <span>Rejected proposal {typeof payload.proposalIndex === "number" ? payload.proposalIndex + 1 : ""}</span>
                <strong>{payload.reason ?? "proposal_rejected"}</strong>
                <p>{payload.detail ?? "Evidence proposal did not pass verification."}</p>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="walnut-empty">No evidence proposals were rejected in this Run.</p>
      )}
      <details className="walnut-event-stream">
        <summary>Inspect event sequence</summary>
        <ol>
          {events.events.map((event) => (
            <li key={event.eventId}>
              <span>{String(event.sequence).padStart(2, "0")}</span>
              <strong>{event.kind}</strong>
              <code>{event.eventHash.slice(0, 12)}…</code>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

function EvidenceActions({
  evidenceId,
  state,
  onAction,
}: {
  evidenceId: string;
  state: ActionState;
  onAction: (evidenceId: string, kind: "revoke" | "compromise") => void;
}) {
  return (
    <div className="walnut-evidence-actions">
      <button
        type="button"
        className="button button-ghost walnut-evidence-action"
        disabled={state.loading}
        onClick={() => onAction(evidenceId, "revoke")}
      >
        Revoke
      </button>
      <button
        type="button"
        className="button button-danger walnut-evidence-action"
        disabled={state.loading}
        onClick={() => onAction(evidenceId, "compromise")}
      >
        Compromise
      </button>
      {state.error ? <span className="walnut-note walnut-warning">{state.error}</span> : null}
      {state.taintedCount !== null ? (
        <span className="walnut-note">{state.taintedCount} run(s) tainted</span>
      ) : null}
    </div>
  );
}
