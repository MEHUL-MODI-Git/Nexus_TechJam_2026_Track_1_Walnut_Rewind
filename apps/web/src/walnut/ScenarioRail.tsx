import type { ClarificationsResponse, RunWalnutOverview } from "./types";
import type { WalnutTab } from "./WalnutDrawer";

type ProofTone = "proved" | "incident" | "pending";

interface ProofBeat {
  id: string;
  label: string;
  question: string;
  value: string;
  tone: ProofTone;
  tab: WalnutTab;
}

function shortId(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 8) + "…" + value.slice(-4);
}

function proofBeats(overview: RunWalnutOverview | null): ProofBeat[] {
  const evidenceCount = overview
    ? overview.evidenceSummary.consumed + overview.evidenceSummary.produced
    : 0;
  const deniedCount = overview?.decisions.denied ?? 0;
  const state = overview?.walnutRunState ?? null;
  const recoveryCount = overview?.recoverySummary.count ?? 0;

  return [
    {
      id: "provenance",
      label: "Verified truth",
      question: "Can we trust the claim?",
      value: overview === null ? "Reading run" : `${evidenceCount} evidence record${evidenceCount === 1 ? "" : "s"}`,
      tone: evidenceCount > 0 ? "proved" : "pending",
      tab: "evidence",
    },
    {
      id: "access",
      label: "Least privilege",
      question: "Was it allowed before the prompt?",
      value: overview === null ? "Reading policy" : `${deniedCount} blocked before context`,
      tone: deniedCount > 0 ? "proved" : "pending",
      tab: "evidence",
    },
    {
      id: "capsule",
      label: "Sealed context",
      question: "What exactly did the model know?",
      value: overview?.capsule ? shortId(overview.capsule.capsuleHash) : "No capsule",
      tone: overview?.capsule ? "proved" : "pending",
      tab: "overview",
    },
    {
      id: "impact",
      label: "Blast radius",
      question: "What inherited the bad belief?",
      value: state ?? "Reading graph",
      tone: state === "TAINTED" ? "incident" : state === "RECOVERED" ? "proved" : "pending",
      tab: "dependencies",
    },
    {
      id: "rewind",
      label: "Rewind",
      question: "Can we recover without rewriting?",
      value: overview === null ? "Reading recovery" : `${recoveryCount} replacement${recoveryCount === 1 ? "" : "s"}`,
      tone: recoveryCount > 0 ? "proved" : "pending",
      tab: "history",
    },
    {
      id: "integrity",
      label: "Tamper-evident",
      question: "Can history be silently changed?",
      value: overview === null ? "Reading ledger" : overview.chain.ok ? `${overview.chain.eventCount} events verified` : "Chain broken",
      tone: overview === null ? "pending" : overview.chain.ok ? "proved" : "incident",
      tab: "overview",
    },
  ];
}

export function ScenarioRail({
  runId,
  overview,
  clarification,
  onSelectTab,
}: {
  runId: string;
  overview: RunWalnutOverview | null;
  clarification: ClarificationsResponse["open"][number] | null;
  onSelectTab: (tab: WalnutTab) => void;
}) {
  const beats = proofBeats(overview);

  return (
    <section className="walnut-scenario" aria-labelledby="walnut-scenario-title">
      <div className="walnut-scenario-heading">
        <div>
          <div className="walnut-scenario-kicker">
            <span>Live case 01 · launch control incident</span>
            <span className="walnut-scenario-run">run {shortId(runId)}</span>
          </div>
          <h2 id="walnut-scenario-title">The Aurora Launch</h2>
          <p>
            A launch decision uses trusted evidence while payroll stays restricted. If the launch
            fact later becomes unsafe, find every affected decision and recover without rewriting
            what happened.
          </p>
        </div>
        <div className="walnut-scenario-flow" aria-label="Scenario roles">
          <span>Research</span>
          <i>→</i>
          <span>Strategy</span>
          <i>→</i>
          <span>Artifacts</span>
        </div>
      </div>

      {clarification ? (
        <div className="walnut-clarification" role="status">
          <div className="walnut-clarification-signal">Decision paused</div>
          <div>
            <strong>Conflicting evidence stopped the model call.</strong>
            <p>{clarification.question}</p>
            <div className="walnut-clarification-options">
              {clarification.options.map((option) => (
                <span key={option.id}>{option.label}</span>
              ))}
              <span>None of the above</span>
            </div>
          </div>
        </div>
      ) : null}

      <div className="walnut-proof-heading">
        <span>Proof line</span>
        <small>Every value below comes from the selected Run.</small>
      </div>
      <div className="walnut-proof-rail">
        {beats.map((beat, index) => (
          <button
            key={beat.id}
            type="button"
            className={`walnut-proof-beat walnut-proof-${beat.tone}`}
            onClick={() => onSelectTab(beat.tab)}
            aria-label={`${beat.label}: ${beat.value}. Open ${beat.tab}.`}
          >
            <span className="walnut-proof-index">{String(index + 1).padStart(2, "0")}</span>
            <strong>{beat.label}</strong>
            <span className="walnut-proof-question">{beat.question}</span>
            <span className="walnut-proof-value">{beat.value}</span>
          </button>
        ))}
      </div>

      <details className="walnut-coverage">
        <summary>Feature coverage — four operational questions</summary>
        <div className="walnut-coverage-grid">
          <CoverageItem
            number="01"
            title="Can I trust it?"
            copy="Exact citations · source drift · evidence versions · provenance"
          />
          <CoverageItem
            number="02"
            title="Was it allowed?"
            copy="Grants · pre-context denial · recipient re-authorization · clarification"
          />
          <CoverageItem
            number="03"
            title="What depends on it?"
            copy="Sealed capsules · rebuildable graph · blast radius · known-at history"
          />
          <CoverageItem
            number="04"
            title="Can I recover?"
            copy="Taint · reconcile · immutable old runs · ledger verification · redaction"
          />
        </div>
      </details>
    </section>
  );
}

function CoverageItem({ number, title, copy }: { number: string; title: string; copy: string }) {
  return (
    <div className="walnut-coverage-item">
      <span>{number}</span>
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  );
}
