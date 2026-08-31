import type { CitationVerification, Classification, EvidenceStatus } from "./types";

// Chip tone lookups. These map a *known* enum value to a fixed class name through an explicit
// switch — never by interpolating the value itself into a className — so an unexpected string
// (which, per project rule, must be treated as attacker-influenceable) can only ever fall
// through to the neutral default, never reach the DOM as part of an attribute name.

export function classificationTone(value: Classification): string {
  switch (value) {
    case "PUBLIC":
      return "walnut-chip-public";
    case "INTERNAL":
      return "walnut-chip-internal";
    case "CONFIDENTIAL":
      return "walnut-chip-confidential";
    case "RESTRICTED":
      return "walnut-chip-restricted";
    default:
      return "walnut-chip-neutral";
  }
}

export function evidenceStatusTone(value: EvidenceStatus): string {
  switch (value) {
    case "ACTIVE":
      return "walnut-chip-good";
    case "SUPERSEDED":
      return "walnut-chip-neutral";
    case "REVOKED":
    case "COMPROMISED":
      return "walnut-chip-bad";
    default:
      return "walnut-chip-neutral";
  }
}

export function citationTone(value: CitationVerification): string {
  return value === "VERIFIED" ? "walnut-chip-good" : "walnut-chip-amber";
}

// Generic status tone for the free-text node.status field on the dependency graph (RunStatus,
// AgentStatus, AuthResult, EvidenceStatus all pass through here depending on node type).
export function statusTone(value: string): string {
  switch (value) {
    case "ALLOW":
    case "ready":
    case "completed":
    case "ACTIVE":
      return "walnut-chip-good";
    case "DENY":
    case "failed":
    case "error":
    case "REVOKED":
    case "COMPROMISED":
      return "walnut-chip-bad";
    default:
      return "walnut-chip-neutral";
  }
}

export function truncateHash(hash: string): string {
  return hash.length > 16 ? hash.slice(0, 16) + "…" : hash;
}

export function Chip({ label, tone }: { label: string; tone: string }) {
  return <span className={"walnut-chip " + tone}>{label}</span>;
}

// The reusable, dumb chip row used by the Evidence tab: a claim followed by its chips. Every
// prop that carries untrusted text (claim) is rendered as a plain React child — never as HTML,
// never as part of an id/className/href.
export function EvidenceCard({
  claim,
  classification,
  status,
  citationVerification,
  sourceHash,
}: {
  claim: string;
  classification: Classification;
  status: EvidenceStatus;
  citationVerification?: CitationVerification | null;
  sourceHash?: string | null;
}) {
  return (
    <div className="walnut-evidence-card">
      <p className="walnut-evidence-claim">{claim}</p>
      <div className="walnut-chip-row">
        <Chip label={classification} tone={classificationTone(classification)} />
        <Chip label={status} tone={evidenceStatusTone(status)} />
        {citationVerification ? (
          <Chip label={citationVerification} tone={citationTone(citationVerification)} />
        ) : null}
        {sourceHash ? <span className="walnut-hash">{truncateHash(sourceHash)}</span> : null}
      </div>
    </div>
  );
}
