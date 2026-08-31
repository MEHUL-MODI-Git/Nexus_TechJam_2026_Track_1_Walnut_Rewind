import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { HistoryResponse } from "./types";
import { Chip, EvidenceCard, statusTone } from "./EvidenceCard";

interface HistoryState {
  loading: boolean;
  error: string | null;
  data: HistoryResponse | null;
}

const emptyHistoryState: HistoryState = { loading: true, error: null, data: null };

// The one Walnut tab that manages its own fetch/refetch cycle instead of the drawer's generic
// TabState pattern (WalnutDrawer.tsx): the `?knownAt=` control needs to re-request on every
// change, which the drawer's "fetch once, cache until runId changes" pattern does not support.
export function HistoryPanel({ runId }: { runId: string }) {
  const [knownAtInput, setKnownAtInput] = useState("");
  const [state, setState] = useState<HistoryState>(emptyHistoryState);
  const requestSequence = useRef(0);

  const load = useCallback(
    (isoKnownAt: string | null) => {
      const sequence = ++requestSequence.current;
      setState({ loading: true, error: null, data: null });
      api
        .walnutHistory(runId, isoKnownAt ?? undefined)
        .then((data) => {
          if (requestSequence.current === sequence) {
            setState({ loading: false, error: null, data });
          }
        })
        .catch((reason) => {
          if (requestSequence.current !== sequence) return;
          setState({
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
            data: null,
          });
        });
    },
    [runId],
  );

  useEffect(() => {
    setKnownAtInput("");
    load(null);
  }, [runId, load]);

  function handleKnownAtChange(value: string): void {
    setKnownAtInput(value);
    if (value === "") {
      load(null);
      return;
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      load(parsed.toISOString());
    }
  }

  return (
    <div className="walnut-history">
      <label className="walnut-history-known-at">
        <span className="walnut-label">Known at</span>
        <input
          type="datetime-local"
          value={knownAtInput}
          onChange={(event) => handleKnownAtChange(event.target.value)}
        />
      </label>

      {state.loading ? (
        <p className="walnut-note">Loading history…</p>
      ) : state.error ? (
        <div className="walnut-error" role="alert">
          <span>{state.error}</span>
          <button
            type="button"
            className="button button-ghost"
            onClick={() => load(knownAtInput === "" ? null : new Date(knownAtInput).toISOString())}
          >
            Retry
          </button>
        </div>
      ) : state.data ? (
        <HistoryBody data={state.data} />
      ) : null}
    </div>
  );
}

function HistoryBody({ data }: { data: HistoryResponse }) {
  const { knownAt, evidence, runState, stateHistory } = data;
  return (
    <div>
      <p className="walnut-note">Effective known-at: {knownAt}</p>

      <div className="walnut-card-row">
        <span className="walnut-label">Run state</span>
        <Chip label={runState} tone={statusTone(runState)} />
      </div>

      <section className="walnut-timeline-section">
        <h3>State history</h3>
        {stateHistory.length === 0 ? (
          <p className="walnut-empty">No state transitions recorded for this run.</p>
        ) : (
          <ul className="walnut-dep-list">
            {stateHistory.map((entry, index) => (
              <li key={index} className="walnut-dep-item">
                <span>{entry.reason}</span>
                <Chip label={entry.state} tone={statusTone(entry.state)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="walnut-timeline-section">
        <h3>Evidence known at this instant</h3>
        {evidence.length === 0 ? (
          <p className="walnut-empty">No evidence was known to this run at this instant.</p>
        ) : (
          <ul className="walnut-evidence-list">
            {evidence.map((item) => (
              <li key={item.evidenceId + ":" + item.version}>
                <EvidenceCard claim={item.claim} classification={item.classification} status={item.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
