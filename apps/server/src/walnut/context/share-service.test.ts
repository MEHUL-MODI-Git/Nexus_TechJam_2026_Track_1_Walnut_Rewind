import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorizationEvaluatorImpl } from "../auth/evaluator.js";
import { GrantStore } from "../auth/grant-store.js";
import type { WalnutPolicy } from "../auth/policy.js";
import { EvidenceLedger } from "../evidence/ledger.js";
import { REDACTION_MARKER, Redactor } from "../evidence/redactor.js";
import type { EvidenceRepository } from "../ports.js";
import type { Citation, Evidence, LedgerEvent, SourcePointer } from "../types.js";
import { ShareServiceImpl } from "./share-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function hex64(fill: string): string {
  return fill.repeat(64).slice(0, 64);
}

function pinnedPolicy(overrides: Partial<WalnutPolicy> = {}): WalnutPolicy {
  return {
    revision: 1,
    denyAgentIds: [],
    classificationCeilings: {},
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    evidenceId: "ev-1",
    version: 1,
    subjectKey: null,
    predicate: null,
    claim: "Launch date is September 14.",
    producerAgentId: "research-agent",
    producerRunId: "run-1",
    sourcePointerId: "ptr-1",
    citationId: "cit-1",
    classification: "INTERNAL",
    requiredScopes: ["launch:read"],
    status: "ACTIVE",
    validFrom: null,
    validTo: null,
    recordedAt: "2026-08-27T00:00:00.000Z",
    txClosedAt: null,
    supersedesEvidenceId: null,
    derivedFromEvidenceIds: [],
    claimHash: `sha256:${hex64("c")}`,
    ...overrides,
  };
}

// Sanctioned mock of the evidence plane (spec 003 §B1) — only getEvidence is exercised by
// ShareService, so every other method throws if a test path accidentally reaches it.
class StubEvidenceRepository implements EvidenceRepository {
  private readonly records = new Map<string, Evidence>();

  set(evidence: Evidence): void {
    this.records.set(evidence.evidenceId, evidence);
  }

  async getEvidence(evidenceId: string, _version?: number): Promise<Evidence | null> {
    return this.records.get(evidenceId) ?? null;
  }

  async listCandidateEvidence(): Promise<Evidence[]> {
    throw new Error("not used in this test");
  }

  async getSourcePointer(): Promise<SourcePointer | null> {
    throw new Error("not used in this test");
  }

  async resolveSourceContent(): Promise<
    | { ok: true; content: string; currentHash: string; drifted: boolean }
    | { ok: false; reason: "not_found" | "unsafe_path" | "unreadable" }
  > {
    throw new Error("not used in this test");
  }

  async getCitation(): Promise<Citation | null> {
    throw new Error("not used in this test");
  }
}

async function readChain(dataDir: string, chainId: string): Promise<LedgerEvent[]> {
  const raw = await readFile(path.join(dataDir, "walnut", "evidence", `${chainId}.ndjson`), "utf8");
  return raw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as LedgerEvent);
}

async function makeHarness(policyOverrides: Partial<WalnutPolicy> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "walnut-share-service-"));
  directories.push(root);
  const dataDir = path.join(root, "data");

  const policy = pinnedPolicy(policyOverrides);
  const grantStore = new GrantStore(dataDir);
  const evaluator = new AuthorizationEvaluatorImpl({ grantStore, policy, dataDir });
  const ledger = new EvidenceLedger(dataDir);
  const redactor = new Redactor({ environment: {} });
  const evidenceRepository = new StubEvidenceRepository();
  const shareService = new ShareServiceImpl({
    evidenceRepository,
    evaluator,
    grantStore,
    ledger,
    redactor,
  });

  return { dataDir, grantStore, evaluator, ledger, evidenceRepository, shareService };
}

describe("ShareServiceImpl.share", () => {
  it("case 1: happy path — recipient lacks consume, transfer issues one narrow grant per scope and re-authorizes to ALLOW", async () => {
    const { dataDir, grantStore, evidenceRepository, shareService } = await makeHarness();

    const evidence = makeEvidence({
      evidenceId: "ev-launch",
      requiredScopes: ["launch:read", "launch:comment"],
    });
    evidenceRepository.set(evidence);

    const now = new Date().toISOString();
    await grantStore.issue({
      agentId: "sender-agent",
      principalId: null,
      resourcePattern: "launch:*",
      action: "share",
      validFrom: now,
      validTo: null,
      issuedBy: "test-fixture",
      supersedesGrantId: null,
    });

    const result = await shareService.share({
      evidenceId: "ev-launch",
      fromAgentId: "sender-agent",
      toAgentId: "recipient-agent",
      principalId: null,
    });

    expect(result.result).toBe("ALLOW");
    expect(result.reasonCode).toBe("AUTHORIZED");
    expect(result.senderDecision.result).toBe("ALLOW");
    expect(result.recipientDecision?.result).toBe("ALLOW");
    expect(result.issuedGrantIds).toHaveLength(2);

    // One grant per required scope, exact-string resourcePattern (never a glob).
    const issuedGrants = await Promise.all(
      result.issuedGrantIds.map((grantId) => grantStore.getById(grantId)),
    );
    const patterns = issuedGrants.map((grant) => grant?.resourcePattern).sort();
    expect(patterns).toEqual(["launch:comment", "launch:read"]);
    for (const grant of issuedGrants) {
      expect(grant?.agentId).toBe("recipient-agent");
      expect(grant?.principalId).toBeNull();
      expect(grant?.action).toBe("consume");
      expect(grant?.issuedBy).toBe("share:sender-agent");
    }

    const verification = await new EvidenceLedger(dataDir).verifyChain("_governance");
    expect(verification.ok).toBe(true);
    expect(verification.eventCount).toBe(1);

    const governanceChain = await readChain(dataDir, "_governance");
    expect(governanceChain).toHaveLength(1);
    const event = governanceChain[0];
    expect(event?.kind).toBe("evidence.shared");
    expect(event?.runId).toBeNull();
    const payload = event?.safePayload as {
      result: string;
      senderDecisionId: string;
      recipientDecisionId: string | null;
    };
    expect(payload.result).toBe("ALLOW");
    // The shared Redactor's high-entropy heuristic (redactor.ts) sweeps mixed-class tokens of
    // 32+ chars whose Shannon entropy clears its threshold — an `auth_<uuid>` decisionId
    // sometimes clears it and sometimes doesn't, depending on the random uuid's own character
    // distribution, so asserting an exact string here (raw id XOR REDACTION_MARKER) is flaky by
    // construction. What's deterministic, and what this asserts, is that the field is present
    // and is one or the other — never absent, never some third shape. The un-redacted ids
    // themselves are asserted directly against `result.senderDecision`/`result.recipientDecision`
    // (never routed through the redactor) elsewhere in this file.
    expect(["string"]).toContain(typeof payload.senderDecisionId);
    expect(
      payload.senderDecisionId === REDACTION_MARKER ||
        payload.senderDecisionId === result.senderDecision.decisionId,
    ).toBe(true);
    expect(
      payload.recipientDecisionId === REDACTION_MARKER ||
        payload.recipientDecisionId === result.recipientDecision?.decisionId,
    ).toBe(true);
    expect(result.senderDecision.decisionId).toMatch(/^auth_/);
    expect(result.recipientDecision?.decisionId).toMatch(/^auth_/);
  });

  it("case 2 (INV-3, doc 04 §21 mirror): sender ALLOW but recipient's classification ceiling denies — no grants, event still appended", async () => {
    const { grantStore, evidenceRepository, shareService, dataDir } = await makeHarness({
      classificationCeilings: { "recipient-agent": "INTERNAL" },
    });

    const evidence = makeEvidence({
      evidenceId: "ev-payroll",
      classification: "CONFIDENTIAL",
      requiredScopes: ["payroll:read"],
    });
    evidenceRepository.set(evidence);

    const now = new Date().toISOString();
    await grantStore.issue({
      agentId: "sender-agent",
      principalId: null,
      resourcePattern: "payroll:read",
      action: "share",
      validFrom: now,
      validTo: null,
      issuedBy: "test-fixture",
      supersedesGrantId: null,
    });

    const result = await shareService.share({
      evidenceId: "ev-payroll",
      fromAgentId: "sender-agent",
      toAgentId: "recipient-agent",
      principalId: null,
    });

    expect(result.result).toBe("DENY");
    expect(result.reasonCode).toBe("CLASSIFICATION_DENIED");
    expect(result.senderDecision.result).toBe("ALLOW");
    expect(result.recipientDecision?.result).toBe("DENY");
    expect(result.recipientDecision?.reasonCode).toBe("CLASSIFICATION_DENIED");
    expect(result.issuedGrantIds).toEqual([]);

    const governanceChain = await readChain(dataDir, "_governance");
    expect(governanceChain).toHaveLength(1);
    expect(governanceChain[0]?.kind).toBe("evidence.shared");
  });

  it("case 3: sender lacks a share grant — DENY with AGENT_SCOPE_MISSING, null recipient decision, no grants, event still appended", async () => {
    const { grantStore, evidenceRepository, shareService, dataDir } = await makeHarness();

    const evidence = makeEvidence({ evidenceId: "ev-no-grant" });
    evidenceRepository.set(evidence);

    const result = await shareService.share({
      evidenceId: "ev-no-grant",
      fromAgentId: "sender-agent",
      toAgentId: "recipient-agent",
      principalId: null,
    });

    expect(result.result).toBe("DENY");
    expect(result.reasonCode).toBe("AGENT_SCOPE_MISSING");
    expect(result.senderDecision.reasonCode).toBe("AGENT_SCOPE_MISSING");
    expect(result.recipientDecision).toBeNull();
    expect(result.issuedGrantIds).toEqual([]);
    expect(await grantStore.listFor("recipient-agent", null)).toEqual([]);

    const governanceChain = await readChain(dataDir, "_governance");
    expect(governanceChain).toHaveLength(1);
    const payload = governanceChain[0]?.safePayload as { recipientDecisionId: string | null };
    expect(payload.recipientDecisionId).toBeNull();
  });

  it("case 4: recipient already authorized (pre-check ALLOW) — no grant issuance needed", async () => {
    const { grantStore, evidenceRepository, shareService } = await makeHarness();

    const evidence = makeEvidence({ evidenceId: "ev-already-allowed", requiredScopes: ["launch:read"] });
    evidenceRepository.set(evidence);

    const now = new Date().toISOString();
    await grantStore.issue({
      agentId: "sender-agent",
      principalId: null,
      resourcePattern: "launch:read",
      action: "share",
      validFrom: now,
      validTo: null,
      issuedBy: "test-fixture",
      supersedesGrantId: null,
    });
    await grantStore.issue({
      agentId: "recipient-agent",
      principalId: null,
      resourcePattern: "launch:read",
      action: "consume",
      validFrom: now,
      validTo: null,
      issuedBy: "test-fixture",
      supersedesGrantId: null,
    });

    const result = await shareService.share({
      evidenceId: "ev-already-allowed",
      fromAgentId: "sender-agent",
      toAgentId: "recipient-agent",
      principalId: null,
    });

    expect(result.result).toBe("ALLOW");
    expect(result.issuedGrantIds).toEqual([]);
  });

  it("case 5: REVOKED evidence denies the sender's own share check before any grant lookup", async () => {
    const { grantStore, evidenceRepository, shareService } = await makeHarness();

    const evidence = makeEvidence({ evidenceId: "ev-revoked", status: "REVOKED" });
    evidenceRepository.set(evidence);

    const now = new Date().toISOString();
    await grantStore.issue({
      agentId: "sender-agent",
      principalId: null,
      resourcePattern: "launch:read",
      action: "share",
      validFrom: now,
      validTo: null,
      issuedBy: "test-fixture",
      supersedesGrantId: null,
    });

    const result = await shareService.share({
      evidenceId: "ev-revoked",
      fromAgentId: "sender-agent",
      toAgentId: "recipient-agent",
      principalId: null,
    });

    expect(result.result).toBe("DENY");
    expect(result.reasonCode).toBe("EVIDENCE_REVOKED");
    expect(result.senderDecision.reasonCode).toBe("EVIDENCE_REVOKED");
    expect(result.recipientDecision).toBeNull();
    expect(result.issuedGrantIds).toEqual([]);
  });

  it("case 6: after a successful share, the recipient's transferred access is durable for a standalone re-authorization", async () => {
    const { grantStore, evaluator, evidenceRepository, shareService } = await makeHarness();

    const evidence = makeEvidence({ evidenceId: "ev-durable", requiredScopes: ["launch:read"] });
    evidenceRepository.set(evidence);

    const now = new Date().toISOString();
    await grantStore.issue({
      agentId: "sender-agent",
      principalId: null,
      resourcePattern: "launch:read",
      action: "share",
      validFrom: now,
      validTo: null,
      issuedBy: "test-fixture",
      supersedesGrantId: null,
    });

    const shareResult = await shareService.share({
      evidenceId: "ev-durable",
      fromAgentId: "sender-agent",
      toAgentId: "recipient-agent",
      principalId: null,
    });
    expect(shareResult.result).toBe("ALLOW");

    // A later, unrelated authorization call for the recipient's next capsule — not routed
    // through ShareService at all — must see the same durable access.
    const standalone = await evaluator.authorize({
      agentId: "recipient-agent",
      principalId: null,
      evidence,
      action: "consume",
      runId: null,
      capsuleId: null,
    });

    expect(standalone.result).toBe("ALLOW");
  });
});
