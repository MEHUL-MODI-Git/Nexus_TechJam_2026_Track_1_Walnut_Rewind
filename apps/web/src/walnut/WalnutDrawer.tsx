import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type {
  ClarificationsResponse,
  DependenciesResponse,
  ReconciliationRecord,
  RunEvidenceResponse,
  RunEventsResponse,
  RunWalnutOverview,
} from "./types";
import { OverviewPanel } from "./OverviewPanel";
import { TimelinePanel } from "./TimelinePanel";
import { DependencyPanel } from "./DependencyPanel";
import { HistoryPanel } from "./HistoryPanel";
import { ScenarioRail } from "./ScenarioRail";

export type WalnutTab = "overview" | "evidence" | "dependencies" | "history";

interface TabState<T> {
  loading: boolean;
  error: string | null;
  data: T | null;
}

const emptyTabState = { loading: false, error: null, data: null };

const tabs: Array<{ id: WalnutTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "evidence", label: "Evidence" },
  { id: "dependencies", label: "Dependencies" },
  { id: "history", label: "History" },
];

export function WalnutDrawer({
  runId,
  onReconciled,
}: {
  runId: string;
  // Bubbles OverviewPanel's reconcile result up to the page: a reconcile mints a replacement
  // Run outside the send-message path, so the chat has no other way to learn about it.
  onReconciled?: (reconciliation: ReconciliationRecord) => void;
}) {
  const [tab, setTab] = useState<WalnutTab>("overview");
  const [overview, setOverview] = useState<TabState<RunWalnutOverview>>(emptyTabState);
  const [evidence, setEvidence] = useState<TabState<RunEvidenceResponse>>(emptyTabState);
  const [events, setEvents] = useState<RunEventsResponse | null>(null);
  const [dependencies, setDependencies] = useState<TabState<DependenciesResponse>>(emptyTabState);
  const [clarification, setClarification] = useState<
    ClarificationsResponse["open"][number] | null
  >(null);
  const mountedRef = useRef(true);
  const activeRunRef = useRef(runId);
  activeRunRef.current = runId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A new run: forget whatever the previous run's tabs had loaded and start back on Overview.
  useEffect(() => {
    setTab("overview");
    setOverview(emptyTabState);
    setEvidence(emptyTabState);
    setEvents(null);
    setDependencies(emptyTabState);
    setClarification(null);
  }, [runId]);

  const loadOverview = useCallback(() => {
    const requestedRunId = runId;
    setOverview({ loading: true, error: null, data: null });
    api
      .walnutOverview(runId)
      .then((data) => {
        if (mountedRef.current && activeRunRef.current === requestedRunId) {
          setOverview({ loading: false, error: null, data });
        }
      })
      .catch((reason) => {
        if (mountedRef.current && activeRunRef.current === requestedRunId) {
          setOverview({
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
            data: null,
          });
        }
      });
  }, [runId]);

  const loadEvidence = useCallback(() => {
    const requestedRunId = runId;
    setEvidence({ loading: true, error: null, data: null });
    Promise.all([api.walnutEvidence(runId), api.walnutEvents(runId)])
      .then(([data, eventData]) => {
        if (mountedRef.current && activeRunRef.current === requestedRunId) {
          setEvidence({ loading: false, error: null, data });
          setEvents(eventData);
        }
      })
      .catch((reason) => {
        if (mountedRef.current && activeRunRef.current === requestedRunId) {
          setEvidence({
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
            data: null,
          });
          setEvents(null);
        }
      });
  }, [runId]);

  const loadDependencies = useCallback(() => {
    const requestedRunId = runId;
    setDependencies({ loading: true, error: null, data: null });
    api
      .walnutDependencies(runId)
      .then((data) => {
        if (mountedRef.current && activeRunRef.current === requestedRunId) {
          setDependencies({ loading: false, error: null, data });
        }
      })
      .catch((reason) => {
        if (mountedRef.current && activeRunRef.current === requestedRunId) {
          setDependencies({
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
            data: null,
          });
        }
      });
  }, [runId]);

  const loadClarification = useCallback(() => {
    const requestedRunId = runId;
    api
      .walnutClarifications()
      .then((data) => {
        if (mountedRef.current && activeRunRef.current === requestedRunId) {
          setClarification(data.open.find((item) => item.runId === requestedRunId) ?? null);
        }
      })
      .catch(() => {
        if (mountedRef.current && activeRunRef.current === requestedRunId) {
          setClarification(null);
        }
      });
  }, [runId]);

  const refreshIncidentState = useCallback(() => {
    loadOverview();
    loadEvidence();
    loadDependencies();
    loadClarification();
  }, [loadClarification, loadDependencies, loadEvidence, loadOverview]);

  useEffect(() => {
    loadClarification();
  }, [loadClarification]);

  useEffect(() => {
    if (tab === "overview" && !overview.loading && overview.data === null && overview.error === null) {
      loadOverview();
    }
  }, [tab, overview, loadOverview]);

  useEffect(() => {
    if (tab === "evidence" && !evidence.loading && evidence.data === null && evidence.error === null) {
      loadEvidence();
    }
  }, [tab, evidence, loadEvidence]);

  useEffect(() => {
    if (
      tab === "dependencies" &&
      !dependencies.loading &&
      dependencies.data === null &&
      dependencies.error === null
    ) {
      loadDependencies();
    }
  }, [tab, dependencies, loadDependencies]);

  return (
    <div className="walnut-drawer">
      <ScenarioRail
        runId={runId}
        overview={overview.data}
        clarification={clarification}
        onSelectTab={setTab}
      />

      <div className="walnut-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={"walnut-tab" + (tab === item.id ? " walnut-tab-active" : "")}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="walnut-panel">
        {tab === "overview" &&
          (overview.loading ? (
            <WalnutLoading />
          ) : overview.error ? (
            <WalnutError message={overview.error} onRetry={loadOverview} />
          ) : overview.data ? (
            <OverviewPanel
              overview={overview.data}
              runId={runId}
              onReconciled={(reconciliation) => {
                refreshIncidentState();
                onReconciled?.(reconciliation);
              }}
            />
          ) : null)}

        {tab === "evidence" &&
          (evidence.loading ? (
            <WalnutLoading />
          ) : evidence.error ? (
            <WalnutError message={evidence.error} onRetry={loadEvidence} />
          ) : evidence.data ? (
            <TimelinePanel
              evidence={evidence.data}
              events={events}
              onEvidenceChanged={refreshIncidentState}
            />
          ) : null)}

        {tab === "dependencies" &&
          (dependencies.loading ? (
            <WalnutLoading />
          ) : dependencies.error ? (
            <WalnutError message={dependencies.error} onRetry={loadDependencies} />
          ) : dependencies.data ? (
            <DependencyPanel dependencies={dependencies.data} />
          ) : null)}

        {/* HistoryPanel manages its own fetch/refetch (the ?knownAt= control needs to re-request
            on every change) -- it does not use this drawer's single-fetch TabState pattern. */}
        {tab === "history" && <HistoryPanel runId={runId} />}
      </div>
    </div>
  );
}

function WalnutLoading() {
  return (
    <div className="walnut-loading">
      <span className="spinner" aria-label="Loading" />
      Loading…
    </div>
  );
}

function WalnutError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="walnut-error" role="alert">
      <span>{message}</span>
      <button type="button" className="button button-ghost" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
