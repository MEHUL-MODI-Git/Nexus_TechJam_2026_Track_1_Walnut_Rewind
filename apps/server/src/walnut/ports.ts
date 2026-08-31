// spec 003 port declarations (v1.1); implementations live in their owning plane.
//
// Type-only module: these are the call contracts across the ownership seam (spec
// 003-walnut-service-ports.md §A + §B). Each side implements its own port and mocks the other's
// in tests. Upstream `Agent`/`AgentRun` are consumed directly from ../types.js, never
// re-exported; spec-001 shapes come from ./types.js.

import type { Agent, AgentRun } from "../types.js";
import type {
  AgentVersion,
  AuthorizationDecision,
  Citation,
  CitationVerification,
  ClarificationRequest,
  ContextCapsule,
  Evidence,
  SourcePointer,
} from "./types.js";

// -- §A1. ContextBroker.build --

export interface CapsuleBuildInput {
  run: AgentRun; // upstream type, already persisted, status "queued"
  agent: Agent; // upstream type
  agentVersionId: string;
  onBehalfOfPrincipalId: string | null; // v1 demo: from route/fixture; null = agent alone
  userPrompt: string;
}

export type CapsuleBuildResult =
  | {
      kind: "ok";
      capsule: ContextCapsule; // finalized, hashed, already persisted
      deniedDecisions: AuthorizationDecision[]; // full objects for logging/UI; ids are in capsule
    }
  | {
      kind: "denied"; // the RUN may not proceed at all
      decisions: AuthorizationDecision[];
      reasonCode: AuthorizationDecision["reasonCode"];
      message: string;
    }
  | {
      kind: "clarification_required";
      request: ClarificationRequest;
    };

export interface ContextBroker {
  build(input: CapsuleBuildInput): Promise<CapsuleBuildResult>;
  renderPrompt(userPrompt: string, capsule: ContextCapsule): Promise<string>;
}

// -- §A3. Capsule persistence + lookup port (implemented in context/capsule-store.ts) --

export interface CapsuleStore {
  save(capsule: ContextCapsule): Promise<void>; // rejects if capsuleId already exists
  getById(capsuleId: string): Promise<ContextCapsule | null>;
  getByRunId(runId: string): Promise<ContextCapsule | null>; // one capsule per run in v1
}

// -- §A5. AgentVersion resolver (implemented in context/agent-version-store.ts) --

export interface AgentVersionResolver {
  resolve(agent: Agent): Promise<AgentVersion>; // upstream Agent in, spec-001 AgentVersion out
}

// -- §B1. Read ports (implemented by Codex, consumed by broker / citation verifier / projector) --

export interface EvidenceRepository {
  getEvidence(evidenceId: string, version?: number): Promise<Evidence | null>; // no version = latest
  listCandidateEvidence(query: {
    agentId: string; // the consuming agent
    knownAt?: string; // ISO; omit = now (temporal resolver, P3-D5)
  }): Promise<Evidence[]>; // ALL statuses/classifications — filtering is authz's job,
  // and the broker needs DENY candidates to record decisions
  getSourcePointer(pointerId: string): Promise<SourcePointer | null>;
  resolveSourceContent(pointerId: string): Promise<
    | { ok: true; content: string; currentHash: string; drifted: boolean } // drifted: hash != pointer.contentHash (INV-19)
    | { ok: false; reason: "not_found" | "unsafe_path" | "unreadable" }
  >;
  getCitation(citationId: string): Promise<Citation | null>;
}

// -- §B3. CitationVerifier hook (implemented in context/citation-verifier.ts, called
// by Codex's EvidenceWriteService.createEvidence and by recheck paths) --

export interface CitationVerifier {
  // Creation-time verification (INV-5 / HC-6): receives the FULL quote, because Citation stores
  // only quotePreview + quoteHash (amended 2026-08-27).
  verify(input: {
    quote: string;
    charStart: number;
    charEnd: number;
    pointer: SourcePointer;
  }): Promise<
    | { verification: "VERIFIED"; quoteHash: string } // sha256: of the quote's UTF-8 bytes
    | { verification: "MISMATCH" | "DRIFTED" | "UNAVAILABLE"; detail: string }
  >;

  // Later recheck (no stored full quote): hash comparison against the stored quoteHash.
  recheck(input: { citation: Citation; pointer: SourcePointer }): Promise<CitationVerification>;
}
