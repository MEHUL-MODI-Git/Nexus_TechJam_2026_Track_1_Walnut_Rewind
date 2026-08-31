import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthorizationDecision, Evidence } from "../types.js";
import { AuthorizationEvaluatorImpl } from "./evaluator.js";
import { GrantStore } from "./grant-store.js";
import { policyHash, type WalnutPolicy } from "./policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "walnut-auth-test-"));
  temporaryDirectories.push(root);
  return root;
}

function pinnedPolicy(overrides: Partial<WalnutPolicy> = {}): WalnutPolicy {
  return {
    revision: 1,
    denyAgentIds: [],
    classificationCeilings: {},
    ...overrides,
  };
}

async function setup(policy: WalnutPolicy = pinnedPolicy()): Promise<{
  root: string;
  grantStore: GrantStore;
  evaluator: AuthorizationEvaluatorImpl;
  policy: WalnutPolicy;
}> {
  const root = await makeRoot();
  const grantStore = new GrantStore(root);
  const evaluator = new AuthorizationEvaluatorImpl({ grantStore, policy, dataDir: root });
  return { root, grantStore, evaluator, policy };
}

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    evidenceId: "evidence-1",
    version: 1,
    subjectKey: null,
    predicate: null,
    claim: "employee count is 42",
    producerAgentId: "agent-1",
    producerRunId: "run-1",
    sourcePointerId: "pointer-1",
    citationId: null,
    classification: "INTERNAL",
    requiredScopes: ["payroll:read"],
    status: "ACTIVE",
    validFrom: null,
    validTo: null,
    recordedAt: "2026-08-27T00:00:00.000Z",
    txClosedAt: null,
    supersedesEvidenceId: null,
    derivedFromEvidenceIds: [],
    claimHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  };
}

const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";
const EXPIRED_AT = "2000-06-01T00:00:00.000Z";

async function issueAgentGrant(
  grantStore: GrantStore,
  overrides: Partial<Parameters<GrantStore["issue"]>[0]> = {},
) {
  return grantStore.issue({
    agentId: "agent-1",
    principalId: null,
    resourcePattern: "payroll:*",
    action: "consume",
    validFrom: PAST,
    validTo: null,
    issuedBy: "test",
    supersedesGrantId: null,
    ...overrides,
  });
}

async function issuePrincipalGrant(
  grantStore: GrantStore,
  overrides: Partial<Parameters<GrantStore["issue"]>[0]> = {},
) {
  return grantStore.issue({
    agentId: "*",
    principalId: "principal-1",
    resourcePattern: "payroll:*",
    action: "consume",
    validFrom: PAST,
    validTo: null,
    issuedBy: "test",
    supersedesGrantId: null,
    ...overrides,
  });
}

describe("AuthorizationEvaluatorImpl.authorize", () => {
  it("case 1: ALLOW when both agent and principal legs hold covering grants", async () => {
    const { grantStore, evaluator, policy } = await setup();
    const agentGrant = await issueAgentGrant(grantStore);
    const principalGrant = await issuePrincipalGrant(grantStore);

    const decision = await evaluator.authorize({
      agentId: "agent-1",
      principalId: "principal-1",
      evidence: makeEvidence(),
      action: "consume",
      runId: null,
      capsuleId: null,
    });

    expect(decision.result).toBe("ALLOW");
    expect(decision.reasonCode).toBe("AUTHORIZED");
    expect(decision.matchedAgentGrantIds).toEqual([agentGrant.grantId]);
    expect(decision.matchedPrincipalGrantIds).toEqual([principalGrant.grantId]);
    expect(decision.policyRevision).toBe(policy.revision);
    expect(decision.policyHash).toBe(policyHash(policy));
  });

  it("case 2: doc-04 §21 replica — principal covers, agent does not → AGENT_SCOPE_MISSING", async () => {
    const { grantStore, evaluator } = await setup();
    const principalGrant = await issuePrincipalGrant(grantStore);

    const decision = await evaluator.authorize({
      agentId: "agent-1",
      principalId: "principal-1",
      evidence: makeEvidence({ requiredScopes: ["payroll:read"] }),
      action: "consume",
      runId: null,
      capsuleId: null,
    });

    expect(decision.result).toBe("DENY");
    expect(decision.reasonCode).toBe("AGENT_SCOPE_MISSING");
    expect(decision.matchedAgentGrantIds).toEqual([]);
    expect(decision.matchedPrincipalGrantIds).toEqual([principalGrant.grantId]);
    expect(decision.resource).toBe("payroll");
  });

  it("case 3: principalId null uses the agent leg only; agent grant suffices for ALLOW", async () => {
    const { grantStore, evaluator } = await setup();
    await issueAgentGrant(grantStore);

    const decision = await evaluator.authorize({
      agentId: "agent-1",
      principalId: null,
      evidence: makeEvidence(),
      action: "consume",
      runId: null,
      capsuleId: null,
    });

    expect(decision.result).toBe("ALLOW");
    expect(decision.reasonCode).toBe("AUTHORIZED");
    expect(decision.matchedPrincipalGrantIds).toEqual([]);
  });

  it("case 4: evidence status REVOKED / COMPROMISED / SUPERSEDED deny before grants are consulted", async () => {
    const { grantStore, evaluator } = await setup();
    await issueAgentGrant(grantStore);
    await issuePrincipalGrant(grantStore);

    const statuses: Array<[Evidence["status"], AuthorizationDecision["reasonCode"]]> = [
      ["REVOKED", "EVIDENCE_REVOKED"],
      ["COMPROMISED", "EVIDENCE_COMPROMISED"],
      ["SUPERSEDED", "EVIDENCE_SUPERSEDED"],
    ];

    for (const [status, reasonCode] of statuses) {
      const decision = await evaluator.authorize({
        agentId: "agent-1",
        principalId: "principal-1",
        evidence: makeEvidence({ status }),
        action: "consume",
        runId: null,
        capsuleId: null,
      });
      expect(decision.result).toBe("DENY");
      expect(decision.reasonCode).toBe(reasonCode);
    }
  });

  it("case 5: expired or revoked agent grant yields GRANT_EXPIRED", async () => {
    const { grantStore, evaluator } = await setup();
    await issueAgentGrant(grantStore, { validTo: EXPIRED_AT });

    const expiredDecision = await evaluator.authorize({
      agentId: "agent-1",
      principalId: null,
      evidence: makeEvidence(),
      action: "consume",
      runId: null,
      capsuleId: null,
    });
    expect(expiredDecision.result).toBe("DENY");
    expect(expiredDecision.reasonCode).toBe("GRANT_EXPIRED");

    const { grantStore: grantStore2, evaluator: evaluator2 } = await setup();
    const grant = await issueAgentGrant(grantStore2);
    await grantStore2.revoke(grant.grantId);

    const revokedDecision = await evaluator2.authorize({
      agentId: "agent-1",
      principalId: null,
      evidence: makeEvidence(),
      action: "consume",
      runId: null,
      capsuleId: null,
    });
    expect(revokedDecision.result).toBe("DENY");
    expect(revokedDecision.reasonCode).toBe("GRANT_EXPIRED");
  });

  it("case 6: classification above the agent's ceiling → CLASSIFICATION_DENIED", async () => {
    const policy = pinnedPolicy({ classificationCeilings: { "agent-1": "INTERNAL" } });
    const { grantStore, evaluator } = await setup(policy);
    await issueAgentGrant(grantStore);

    const decision = await evaluator.authorize({
      agentId: "agent-1",
      principalId: null,
      evidence: makeEvidence({ classification: "CONFIDENTIAL" }),
      action: "consume",
      runId: null,
      capsuleId: null,
    });

    expect(decision.result).toBe("DENY");
    expect(decision.reasonCode).toBe("CLASSIFICATION_DENIED");
  });

  it("case 7: deny-listed agent → POLICY_DENIED even when grants would cover", async () => {
    const policy = pinnedPolicy({ denyAgentIds: ["agent-1"] });
    const { grantStore, evaluator } = await setup(policy);
    await issueAgentGrant(grantStore);

    const decision = await evaluator.authorize({
      agentId: "agent-1",
      principalId: null,
      evidence: makeEvidence(),
      action: "consume",
      runId: null,
      capsuleId: null,
    });

    expect(decision.result).toBe("DENY");
    expect(decision.reasonCode).toBe("POLICY_DENIED");
  });

  it("case 8: empty requiredScopes → ALLOW with empty matched lists and resource 'none'", async () => {
    const { evaluator } = await setup();

    const decision = await evaluator.authorize({
      agentId: "agent-1",
      principalId: null,
      evidence: makeEvidence({ requiredScopes: [] }),
      action: "consume",
      runId: null,
      capsuleId: null,
    });

    expect(decision.result).toBe("ALLOW");
    expect(decision.reasonCode).toBe("AUTHORIZED");
    expect(decision.matchedAgentGrantIds).toEqual([]);
    expect(decision.matchedPrincipalGrantIds).toEqual([]);
    expect(decision.resource).toBe("none");
  });

  it("case 9: glob matching — payroll:* covers payroll:read, * covers anything, payroll:read does not cover payroll:write", async () => {
    const { grantStore, evaluator } = await setup();
    await issueAgentGrant(grantStore, { resourcePattern: "payroll:*" });

    const covered = await evaluator.authorize({
      agentId: "agent-1",
      principalId: null,
      evidence: makeEvidence({ requiredScopes: ["payroll:read"] }),
      action: "consume",
      runId: null,
      capsuleId: null,
    });
    expect(covered.result).toBe("ALLOW");

    // "payroll:*" also covers "payroll:write" — the wildcard is a suffix match, not just "read".
    const alsoCovered = await evaluator.authorize({
      agentId: "agent-1",
      principalId: null,
      evidence: makeEvidence({ requiredScopes: ["payroll:write"] }),
      action: "consume",
      runId: null,
      capsuleId: null,
    });
    expect(alsoCovered.result).toBe("ALLOW");

    const { grantStore: grantStore2, evaluator: evaluator2 } = await setup();
    await issueAgentGrant(grantStore2, { resourcePattern: "*" });

    const wildcard = await evaluator2.authorize({
      agentId: "agent-1",
      principalId: null,
      evidence: makeEvidence({ requiredScopes: ["anything:at all"] }),
      action: "consume",
      runId: null,
      capsuleId: null,
    });
    expect(wildcard.result).toBe("ALLOW");

    const { grantStore: grantStore3, evaluator: evaluator3 } = await setup();
    await issueAgentGrant(grantStore3, { resourcePattern: "payroll:read" });

    const exactOnly = await evaluator3.authorize({
      agentId: "agent-1",
      principalId: null,
      evidence: makeEvidence({ requiredScopes: ["payroll:write"] }),
      action: "consume",
      runId: null,
      capsuleId: null,
    });
    expect(exactOnly.result).toBe("DENY");
    expect(exactOnly.reasonCode).toBe("AGENT_SCOPE_MISSING");
  });

  it("case 10: DENY never throws — the promise always resolves", async () => {
    const { evaluator } = await setup();

    await expect(
      evaluator.authorize({
        agentId: "agent-1",
        principalId: null,
        evidence: makeEvidence(),
        action: "consume",
        runId: null,
        capsuleId: null,
      }),
    ).resolves.toMatchObject({ result: "DENY" });
  });

  it("case 11: decisions are persisted to decisions.json across calls", async () => {
    const { root, grantStore, evaluator } = await setup();
    await issueAgentGrant(grantStore);

    const first = await evaluator.authorize({
      agentId: "agent-1",
      principalId: null,
      evidence: makeEvidence({ evidenceId: "evidence-1" }),
      action: "consume",
      runId: null,
      capsuleId: null,
    });
    const second = await evaluator.authorize({
      agentId: "agent-1",
      principalId: null,
      evidence: makeEvidence({ evidenceId: "evidence-2" }),
      action: "consume",
      runId: null,
      capsuleId: null,
    });

    const raw = await readFile(
      path.join(root, "walnut", "decisions", "decisions.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version: 1; decisions: AuthorizationDecision[] };

    expect(parsed.decisions).toHaveLength(2);
    const ids = parsed.decisions.map((decision) => decision.decisionId);
    expect(ids).toEqual([first.decisionId, second.decisionId]);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id.startsWith("auth_")).toBe(true);
    }
  });

  it("case 12: a 'read' grant does not satisfy a 'consume' action → AGENT_SCOPE_MISSING", async () => {
    const { grantStore, evaluator } = await setup();
    await issueAgentGrant(grantStore, { action: "read" });

    const decision = await evaluator.authorize({
      agentId: "agent-1",
      principalId: null,
      evidence: makeEvidence(),
      action: "consume",
      runId: null,
      capsuleId: null,
    });

    expect(decision.result).toBe("DENY");
    expect(decision.reasonCode).toBe("AGENT_SCOPE_MISSING");
  });
});
