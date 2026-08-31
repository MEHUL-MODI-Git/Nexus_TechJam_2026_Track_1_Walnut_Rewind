// AuthorizationEvaluator (spec 003 §B3) — pure, deterministic given (input, grants, policy)
// apart from decisionId/recordedAt. Always resolves to a decision; DENY is a return value, never
// a throw. Persists every decision (immutable, append-only) to
// APP_DATA_DIR/walnut/decisions/decisions.json.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentGrant,
  AgentId,
  AuthorizationDecision,
  CapsuleId,
  Evidence,
  PrincipalId,
  RunId,
} from "../types.js";
import { CLASSIFICATION_ORDER } from "../types.js";
import type { GrantStore } from "./grant-store.js";
import type { WalnutPolicy } from "./policy.js";
import { policyHash } from "./policy.js";

export interface AuthorizeInput {
  agentId: AgentId;
  principalId: PrincipalId | null;
  evidence: Evidence;
  action: "consume" | "share";
  runId: RunId | null;
  capsuleId: CapsuleId | null;
}

export interface AuthorizationEvaluator {
  authorize(input: AuthorizeInput): Promise<AuthorizationDecision>;
}

interface DecisionsFile {
  version: 1;
  decisions: AuthorizationDecision[];
}

const emptyDecisionsFile = (): DecisionsFile => ({ version: 1, decisions: [] });

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// resourcePattern is a glob over scope strings where `*` matches any run of characters:
// escape regex specials, then turn escaped `\*` back into `.*`, anchored both ends.
function patternMatches(pattern: string, scope: string): boolean {
  const escaped = escapeRegExpLiteral(pattern).replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(scope);
}

function isValidNow(grant: AgentGrant, now: string): boolean {
  if (grant.txClosedAt !== null) return false;
  if (grant.validFrom > now) return false;
  if (grant.validTo !== null && now >= grant.validTo) return false;
  return true;
}

// resource = substring of the FIRST requiredScopes entry before the first ":" (or the whole
// entry if no ":"), or "none" when requiredScopes is empty (doc 04 §21).
function computeResource(requiredScopes: string[]): string {
  const first = requiredScopes[0];
  if (first === undefined) return "none";
  const colonIndex = first.indexOf(":");
  return colonIndex === -1 ? first : first.slice(0, colonIndex);
}

type LegFailureReason = "SCOPE_MISSING" | "GRANT_EXPIRED" | null;

interface LegEvaluation {
  matchedGrantIds: string[];
  satisfied: boolean;
  failureReason: LegFailureReason;
}

// Evaluates one leg (agent or principal) against every required scope. Empty requiredScopes is
// trivially satisfied. matchedGrantIds accumulates every valid covering grant across ALL scopes,
// even when the leg ultimately fails on a different scope — callers need the full matched list
// regardless of the final result (doc 04 §21 shows a DENY with a non-empty matched list).
function evaluateLeg(
  grants: AgentGrant[],
  requiredScopes: string[],
  action: AuthorizeInput["action"],
  now: string,
): LegEvaluation {
  const matched = new Set<string>();
  let satisfied = true;
  let failureReason: LegFailureReason = null;

  for (const scope of requiredScopes) {
    const covering = grants.filter(
      (grant) => grant.action === action && patternMatches(grant.resourcePattern, scope),
    );
    const validCovering = covering.filter((grant) => isValidNow(grant, now));
    for (const grant of validCovering) matched.add(grant.grantId);

    if (validCovering.length === 0 && satisfied) {
      satisfied = false;
      failureReason = covering.length > 0 ? "GRANT_EXPIRED" : "SCOPE_MISSING";
    }
  }

  return { matchedGrantIds: Array.from(matched), satisfied, failureReason };
}

export class AuthorizationEvaluatorImpl implements AuthorizationEvaluator {
  private readonly grantStore: GrantStore;
  private readonly policy: WalnutPolicy;
  private readonly decisionsPath: string;
  private data: DecisionsFile | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: { grantStore: GrantStore; policy: WalnutPolicy; dataDir: string }) {
    this.grantStore = options.grantStore;
    this.policy = options.policy;
    this.decisionsPath = path.join(options.dataDir, "walnut", "decisions", "decisions.json");
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizationDecision> {
    const now = new Date().toISOString();
    const evidence = input.evidence;
    const requiredScopes = evidence.requiredScopes;
    const resource = computeResource(requiredScopes);

    const usableGrants = await this.grantStore.listFor(input.agentId, input.principalId);
    const agentGrants = usableGrants.filter((grant) => grant.principalId === null);
    const principalGrants = usableGrants.filter((grant) => grant.principalId !== null);

    const agentLeg = evaluateLeg(agentGrants, requiredScopes, input.action, now);
    const principalLeg: LegEvaluation =
      input.principalId !== null
        ? evaluateLeg(principalGrants, requiredScopes, input.action, now)
        : { matchedGrantIds: [], satisfied: true, failureReason: null };

    const ceiling = this.policy.classificationCeilings[input.agentId] ?? "RESTRICTED";

    let result: AuthorizationDecision["result"] = "ALLOW";
    let reasonCode: AuthorizationDecision["reasonCode"] = "AUTHORIZED";

    if (this.policy.denyAgentIds.includes(input.agentId)) {
      result = "DENY";
      reasonCode = "POLICY_DENIED";
    } else if (evidence.status === "REVOKED") {
      result = "DENY";
      reasonCode = "EVIDENCE_REVOKED";
    } else if (evidence.status === "COMPROMISED") {
      result = "DENY";
      reasonCode = "EVIDENCE_COMPROMISED";
    } else if (evidence.status === "SUPERSEDED") {
      result = "DENY";
      reasonCode = "EVIDENCE_SUPERSEDED";
    } else if (CLASSIFICATION_ORDER[evidence.classification] > CLASSIFICATION_ORDER[ceiling]) {
      result = "DENY";
      reasonCode = "CLASSIFICATION_DENIED";
    } else if (!agentLeg.satisfied) {
      result = "DENY";
      reasonCode = agentLeg.failureReason === "GRANT_EXPIRED" ? "GRANT_EXPIRED" : "AGENT_SCOPE_MISSING";
    } else if (!principalLeg.satisfied) {
      result = "DENY";
      reasonCode =
        principalLeg.failureReason === "GRANT_EXPIRED" ? "GRANT_EXPIRED" : "PRINCIPAL_SCOPE_MISSING";
    }

    const decision: AuthorizationDecision = {
      decisionId: `auth_${randomUUID()}`,
      runId: input.runId,
      capsuleId: input.capsuleId,
      agentId: input.agentId,
      principalId: input.principalId,
      evidenceId: evidence.evidenceId,
      evidenceVersion: evidence.version,
      action: input.action,
      resource,
      requiredScopes,
      matchedAgentGrantIds: agentLeg.matchedGrantIds,
      matchedPrincipalGrantIds: principalLeg.matchedGrantIds,
      policyRevision: this.policy.revision,
      policyHash: policyHash(this.policy),
      result,
      reasonCode,
      recordedAt: now,
    };

    await this.appendDecision(decision);
    return decision;
  }

  // Read-all accessor (P2-X1): every persisted AuthorizationDecision, unfiltered — additive, no
  // behaviour change to authorize(). Consumed by the dependency projector, which mints an
  // authorization_decision node per decision (doc 04 §13).
  async listAll(): Promise<AuthorizationDecision[]> {
    const file = await this.ensureLoaded();
    return structuredClone(file.decisions);
  }

  private async ensureLoaded(): Promise<DecisionsFile> {
    if (this.data) return this.data;
    await mkdir(path.dirname(this.decisionsPath), { recursive: true });
    try {
      const raw = await readFile(this.decisionsPath, "utf8");
      const parsed = JSON.parse(raw) as DecisionsFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.decisions)) {
        throw new Error("Unsupported decisions file format");
      }
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.data = emptyDecisionsFile();
    }
    return this.data;
  }

  private async persist(data: DecisionsFile): Promise<void> {
    const temporaryPath = `${this.decisionsPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.decisionsPath);
  }

  // Same clone-mutate-persist-swap queue pattern as GrantStore — decisions are immutable once
  // appended, so this only ever pushes.
  private async appendDecision(decision: AuthorizationDecision): Promise<void> {
    const operation = this.queue.then(async () => {
      const current = await this.ensureLoaded();
      const next: DecisionsFile = { version: 1, decisions: [...current.decisions, decision] };
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }
}
