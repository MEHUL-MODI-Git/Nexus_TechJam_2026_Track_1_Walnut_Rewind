import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { AttestationResponse, ReconciliationRecord, RunAttestation, RunWalnutOverview, VerifyResponse } from "./types";
import { truncateHash } from "./EvidenceCard";

interface AttestationState {
  loading: boolean;
  error: string | null;
  data: AttestationResponse | null;
}

const emptyAttestationState: AttestationState = { loading: true, error: null, data: null };

export function OverviewPanel({
  overview,
  runId,
  onReconciled,
}: {
  overview: RunWalnutOverview;
  runId: string;
  // Phase-3 (P3-D4): a successful reconcile mints a brand-new Run; this panel refreshes ITS OWN
  // attestation (walnutRunState flips to RECOVERED) but has no way to navigate the drawer to the
  // replacement Run. The callback exists for a caller that wants to react to that (e.g. surface
  // the replacement Run id elsewhere in the page); it is optional so this panel works standalone.
  onReconciled?: (reconciliation: ReconciliationRecord) => void;
}) {
  const {
    capsule,
    chain,
    decisions,
    walnutRunState,
    evidenceSummary,
    dependencySummary,
    recoverySummary,
    note,
  } = overview;

  const [attestationState, setAttestationState] = useState<AttestationState>(emptyAttestationState);
  const attestationRequestSequence = useRef(0);

  function loadAttestation(): void {
    const sequence = ++attestationRequestSequence.current;
    setAttestationState(emptyAttestationState);
    api
      .walnutAttestation(runId)
      .then((data) => {
        if (attestationRequestSequence.current === sequence) {
          setAttestationState({ loading: false, error: null, data });
        }
      })
      .catch((reason) => {
        if (attestationRequestSequence.current !== sequence) return;
        setAttestationState({
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
          data: null,
        });
      });
  }

  useEffect(() => {
    loadAttestation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  async function handleVerify() {
    setVerifying(true);
    setVerifyError(null);
    try {
      const result = await api.walnutVerify(runId);
      setVerifyResult(result);
    } catch (reason) {
      setVerifyError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setVerifying(false);
    }
  }

  const [reconciling, setReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<ReconciliationRecord | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);

  async function handleReconcile() {
    setReconciling(true);
    setReconcileError(null);
    try {
      const result = await api.reconcile(runId);
      setReconcileResult(result.reconciliation);
      // "refresh": THIS run's own attestation genuinely changes on a successful reconcile —
      // walnutRunState flips to RECOVERED (WalnutRunStateStore.markRecovered) — so re-fetch it
      // rather than leaving the stale pre-reconcile counts on screen.
      loadAttestation();
      onReconciled?.(result.reconciliation);
    } catch (reason) {
      // A 409 here is the product working, not a bug: reconcile refuses a CLEAN run (spec
      // ReconciliationServiceImpl.reconcile step 1) — shown inline, same styling as any other
      // error, no special-casing of the status code in the message itself.
      setReconcileError(
        reason instanceof ApiError
          ? reason.message
          : reason instanceof Error
            ? reason.message
            : String(reason),
      );
    } finally {
      setReconciling(false);
    }
  }

  return (
    <div className="walnut-overview">
      {capsule === null ? (
        <p className="walnut-empty">No context capsule was recorded for this run.</p>
      ) : (
        <div className="walnut-card">
          <div className="walnut-card-row">
            <span className="walnut-label">Capsule</span>
            <span>{capsule.capsuleId}</span>
          </div>
          <div className="walnut-card-row">
            <span className="walnut-label">Hash</span>
            <span className="walnut-hash">{truncateHash(capsule.capsuleHash)}</span>
          </div>
          <div className="walnut-card-row">
            <span className="walnut-label">Policy revision</span>
            <span>{capsule.policyRevision}</span>
          </div>
          <div className="walnut-card-row">
            <span className="walnut-label">Evidence</span>
            <span>
              {capsule.evidenceCount} allowed · {capsule.deniedCount} denied
            </span>
          </div>
          <div className="walnut-card-row">
            <span className="walnut-label">Transaction cut</span>
            <span>{capsule.transactionCut}</span>
          </div>
        </div>
      )}

      <div className={"walnut-badge " + (chain.ok ? "walnut-badge-ok" : "walnut-badge-error")}>
        {chain.ok
          ? `chain verified (${chain.eventCount} events)`
          : `${chain.reason ?? "chain broken"} at sequence ${chain.brokenAtSequence ?? "unknown"}`}
      </div>

      <div className="walnut-card">
        <div className="walnut-card-row">
          <span className="walnut-label">Decisions</span>
          <span>
            {decisions.allowed} allowed · {decisions.denied} denied
          </span>
        </div>
        <div className="walnut-card-row">
          <span className="walnut-label">Run state</span>
          <span>{walnutRunState}</span>
        </div>
        <div className="walnut-card-row">
          <span className="walnut-label">Evidence</span>
          <span>
            {evidenceSummary.consumed} consumed · {evidenceSummary.produced} produced
          </span>
        </div>
        <div className="walnut-card-row">
          <span className="walnut-label">Dependencies</span>
          <span>
            {dependencySummary.upstream} upstream · {dependencySummary.downstream} downstream
          </span>
        </div>
        <div className="walnut-card-row">
          <span className="walnut-label">Recoveries</span>
          <span>{recoverySummary.count}</span>
        </div>
      </div>

      <div className="walnut-card">
        <h3 className="walnut-attestation-title">Attestation</h3>
        {attestationState.loading ? (
          <p className="walnut-note">Loading attestation…</p>
        ) : attestationState.error ? (
          <p className="walnut-note walnut-warning">{attestationState.error}</p>
        ) : attestationState.data === null ? null : attestationState.data.attestation === null ? (
          <p className="walnut-note">{attestationState.data.note}</p>
        ) : (
          <AttestationDetail attestation={attestationState.data.attestation} note={attestationState.data.note} />
        )}
      </div>

      <div className="walnut-actions">
        <button type="button" className="button button-ghost" disabled={verifying} onClick={handleVerify}>
          {verifying ? "Verifying…" : "Verify chain"}
        </button>
        <button
          type="button"
          className="button button-ghost"
          disabled={reconciling}
          onClick={handleReconcile}
        >
          {reconciling ? "Reconciling…" : "Reconcile"}
        </button>
      </div>

      {verifyError ? <p className="walnut-note walnut-warning">{verifyError}</p> : null}
      {verifyResult ? (
        <div className="walnut-card">
          <div className="walnut-card-row">
            <span className="walnut-label">Run chain</span>
            <span>{verifyResult.run.ok ? "verified" : (verifyResult.run.reason ?? "broken")}</span>
          </div>
          <div className="walnut-card-row">
            <span className="walnut-label">Governance chain</span>
            <span>
              {verifyResult.governance.ok ? "verified" : (verifyResult.governance.reason ?? "broken")}
            </span>
          </div>
        </div>
      ) : null}

      {reconcileError ? <p className="walnut-note walnut-warning">{reconcileError}</p> : null}
      {reconcileResult ? (
        <div className="walnut-card">
          <div className="walnut-card-row">
            <span className="walnut-label">Reconciliation</span>
            <span>{reconcileResult.result}</span>
          </div>
          <div className="walnut-card-row">
            <span className="walnut-label">Replacement run</span>
            <span className="walnut-hash">{reconcileResult.replacementRunId}</span>
          </div>
        </div>
      ) : null}

      <p className="walnut-note">{note}</p>
    </div>
  );
}

function AttestationDetail({ attestation, note }: { attestation: RunAttestation; note: string }) {
  return (
    <div>
      <div className="walnut-attestation-grid">
        <AttestationStat label="Events" value={attestation.eventCount} />
        <AttestationStat label="Runtime events" value={attestation.runtimeEventCount} />
        <AttestationStat label="Consumed" value={attestation.evidenceConsumed} />
        <AttestationStat label="Denied" value={attestation.evidenceDenied} />
        <AttestationStat label="Commands" value={attestation.commandCount} />
        <AttestationStat label="Failed steps" value={attestation.failedStepCount} />
        <AttestationStat label="Redactions" value={attestation.redactionCount} />
      </div>
      <div className="walnut-card-row">
        <span className="walnut-label">Chain head</span>
        <span className="walnut-hash">
          {attestation.chainVerified ? "verified" : "BROKEN"} · {truncateHash(attestation.chainHead)}
        </span>
      </div>
      <div className="walnut-card-row">
        <span className="walnut-label">Route</span>
        <span>
          Ark endpoint hidden · codex{" "}
          {attestation.routeReceipt.codexVersion} · {attestation.routeReceipt.runtimeProvider}
          {attestation.routeReceipt.runtimeImage ? ` (${attestation.routeReceipt.runtimeImage})` : ""} ·
          sandbox {attestation.routeReceipt.sandboxMode}
        </span>
      </div>
      <div className="walnut-card-row">
        <span className="walnut-label">Changed artifacts</span>
        {attestation.changedArtifacts.length === 0 ? (
          <span>none</span>
        ) : (
          <span className="walnut-artifact-paths">
            {attestation.changedArtifacts.map((path) => (
              <code key={path}>{path}</code>
            ))}
          </span>
        )}
      </div>
      <p className="walnut-note">{note}</p>
    </div>
  );
}

function AttestationStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="walnut-attestation-stat">
      <span className="walnut-attestation-value">{value}</span>
      <span className="walnut-attestation-label">{label}</span>
    </div>
  );
}
