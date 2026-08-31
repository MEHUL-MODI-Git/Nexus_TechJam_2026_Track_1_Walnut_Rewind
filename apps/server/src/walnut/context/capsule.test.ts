import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, AgentRun } from "../../types.js";
import { AuthorizationEvaluatorImpl } from "../auth/evaluator.js";
import { GrantStore } from "../auth/grant-store.js";
import type { WalnutPolicy } from "../auth/policy.js";
import { canonicalJson } from "../evidence/canonical-json.js";
import type { EvidenceRepository } from "../ports.js";
import type {
  AuthorizationDecision,
  Citation,
  Evidence,
  EvidenceStatus,
  SourcePointer,
} from "../types.js";
import { AgentVersionStoreImpl } from "./agent-version-store.js";
import { CapsuleStoreImpl } from "./capsule-store.js";
import { ClarificationStoreImpl } from "./clarification-store.js";
import { ContextBrokerImpl } from "./context-broker.js";

const CANARY = "WALNUT_CANARY_DENIED_PAYROLL_93c1e7";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "walnut-capsule-test-"));
  temporaryDirectories.push(root);
  return root;
}

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

function makePointer(overrides: Partial<SourcePointer> = {}): SourcePointer {
  return {
    pointerId: "ptr-1",
    sourceId: "source-1",
    kind: "workspace_lines",
    locator: { path: "launch-plan.txt" },
    contentHash: `sha256:${hex64("a")}`,
    mediaType: "text/plain",
    charStart: null,
    charEnd: null,
    lineStart: 11,
    lineEnd: 11,
    observedAt: "2026-08-27T00:00:00.000Z",
    classification: "INTERNAL",
    ...overrides,
  };
}

function makeCitation(overrides: Partial<Citation> = {}): Citation {
  return {
    citationId: "cit-1",
    pointerId: "ptr-1",
    quotePreview: "Launch date is September 14.",
    quoteHash: `sha256:${hex64("b")}`,
    charStart: null,
    charEnd: null,
    lineStart: 11,
    lineEnd: 11,
    verification: "VERIFIED",
    verifiedAt: "2026-08-27T00:00:00.000Z",
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
    producerRunId: "run-73",
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

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "strategy-agent",
    name: "Strategy Agent",
    description: "Plans launch strategy.",
    instructions: "Answer questions about launch timing.",
    status: "ready",
    workspacePath: "/tmp/strategy-agent",
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    agentId: "strategy-agent",
    status: "queued",
    prompt: "What is the launch date?",
    output: null,
    error: null,
    usage: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

// Sanctioned mock of the evidence plane (spec 003 §B1) — implements EvidenceRepository entirely
// in memory so context/** tests never depend on evidence/**.
class FixtureEvidenceRepository implements EvidenceRepository {
  constructor(
    private readonly evidenceRecords: Evidence[],
    private readonly pointers: Map<string, SourcePointer>,
    private readonly citations: Map<string, Citation>,
  ) {}

  async getEvidence(evidenceId: string, version?: number): Promise<Evidence | null> {
    const matches = this.evidenceRecords.filter((item) => item.evidenceId === evidenceId);
    if (matches.length === 0) return null;
    if (version !== undefined) {
      return matches.find((item) => item.version === version) ?? null;
    }
    return matches[matches.length - 1] ?? null;
  }

  async listCandidateEvidence(): Promise<Evidence[]> {
    return [...this.evidenceRecords];
  }

  async getSourcePointer(pointerId: string): Promise<SourcePointer | null> {
    return this.pointers.get(pointerId) ?? null;
  }

  async resolveSourceContent(): Promise<
    | { ok: true; content: string; currentHash: string; drifted: boolean }
    | { ok: false; reason: "not_found" | "unsafe_path" | "unreadable" }
  > {
    return { ok: false, reason: "not_found" };
  }

  async getCitation(citationId: string): Promise<Citation | null> {
    return this.citations.get(citationId) ?? null;
  }
}

// Two allowed INTERNAL launch-date evidences (VERIFIED citations, real line bounds) plus one
// denied CONFIDENTIAL payroll evidence carrying the planted canary literal.
function buildFixtureRepository(): FixtureEvidenceRepository {
  const pointerLaunch1 = makePointer({ pointerId: "ptr-launch-1", sourceId: "source-launch-1" });
  const pointerLaunch2 = makePointer({
    pointerId: "ptr-launch-2",
    sourceId: "source-launch-2",
    lineStart: 22,
    lineEnd: 22,
  });
  const pointerPayroll = makePointer({
    pointerId: "ptr-payroll-1",
    sourceId: "source-payroll-1",
    locator: { path: "payroll.csv" },
    classification: "CONFIDENTIAL",
    lineStart: 5,
    lineEnd: 5,
  });

  const citationLaunch1 = makeCitation({ citationId: "cit-launch-1", pointerId: "ptr-launch-1" });
  const citationLaunch2 = makeCitation({
    citationId: "cit-launch-2",
    pointerId: "ptr-launch-2",
    quotePreview: "Launch confirmed for Q3.",
    lineStart: 22,
    lineEnd: 22,
  });

  const evidenceLaunch1 = makeEvidence({
    evidenceId: "ev-launch-1",
    sourcePointerId: "ptr-launch-1",
    citationId: "cit-launch-1",
  });
  const evidenceLaunch2 = makeEvidence({
    evidenceId: "ev-launch-2",
    claim: "Launch confirmed for Q3.",
    sourcePointerId: "ptr-launch-2",
    citationId: "cit-launch-2",
  });
  const evidencePayroll = makeEvidence({
    evidenceId: "ev-payroll-1",
    claim: `Payroll total this quarter: ${CANARY}`,
    producerAgentId: "finance-agent",
    producerRunId: "run-99",
    sourcePointerId: "ptr-payroll-1",
    citationId: null,
    classification: "CONFIDENTIAL",
    requiredScopes: ["payroll:read"],
  });

  return new FixtureEvidenceRepository(
    [evidenceLaunch1, evidenceLaunch2, evidencePayroll],
    new Map([
      ["ptr-launch-1", pointerLaunch1],
      ["ptr-launch-2", pointerLaunch2],
      ["ptr-payroll-1", pointerPayroll],
    ]),
    new Map([
      ["cit-launch-1", citationLaunch1],
      ["cit-launch-2", citationLaunch2],
    ]),
  );
}

// Two ACTIVE evidence records sharing subjectKey/predicate but with different claimHash — both
// authorized under the "launch:*" grants issued below (P3-C1 conflict-detection fixture).
// `secondStatus` lets tests flip the second record to e.g. SUPERSEDED to prove the conflict
// clears once one side is no longer ACTIVE.
function buildConflictFixtureRepository(
  options: { secondStatus?: EvidenceStatus } = {},
): FixtureEvidenceRepository {
  const pointerA = makePointer({ pointerId: "ptr-conflict-a", sourceId: "source-conflict-a" });
  const pointerB = makePointer({
    pointerId: "ptr-conflict-b",
    sourceId: "source-conflict-b",
    lineStart: 30,
    lineEnd: 30,
  });

  const citationA = makeCitation({ citationId: "cit-conflict-a", pointerId: "ptr-conflict-a" });
  const citationB = makeCitation({
    citationId: "cit-conflict-b",
    pointerId: "ptr-conflict-b",
    quotePreview: "Launch date is October 7.",
    lineStart: 30,
    lineEnd: 30,
  });

  const evidenceA = makeEvidence({
    evidenceId: "ev-conflict-a",
    subjectKey: "launch_date",
    predicate: "confirmed_on",
    claim: "Launch date is September 14.",
    sourcePointerId: "ptr-conflict-a",
    citationId: "cit-conflict-a",
    claimHash: `sha256:${hex64("d1")}`,
  });
  const evidenceB = makeEvidence({
    evidenceId: "ev-conflict-b",
    subjectKey: "launch_date",
    predicate: "confirmed_on",
    claim: "Launch date is October 7.",
    sourcePointerId: "ptr-conflict-b",
    citationId: "cit-conflict-b",
    claimHash: `sha256:${hex64("d2")}`,
    status: options.secondStatus ?? "ACTIVE",
  });

  return new FixtureEvidenceRepository(
    [evidenceA, evidenceB],
    new Map([
      ["ptr-conflict-a", pointerA],
      ["ptr-conflict-b", pointerB],
    ]),
    new Map([
      ["cit-conflict-a", citationA],
      ["cit-conflict-b", citationB],
    ]),
  );
}

// Same-key, different-claimHash pair as above, but both DENIED (CONFIDENTIAL payroll scope no
// grant covers) — proves a conflict among evidence the agent cannot see never surfaces.
function buildDeniedConflictFixtureRepository(): FixtureEvidenceRepository {
  const pointerA = makePointer({
    pointerId: "ptr-denied-conflict-a",
    sourceId: "source-denied-conflict-a",
    locator: { path: "payroll.csv" },
    classification: "CONFIDENTIAL",
    lineStart: 40,
    lineEnd: 40,
  });
  const pointerB = makePointer({
    pointerId: "ptr-denied-conflict-b",
    sourceId: "source-denied-conflict-b",
    locator: { path: "payroll.csv" },
    classification: "CONFIDENTIAL",
    lineStart: 41,
    lineEnd: 41,
  });

  const evidenceA = makeEvidence({
    evidenceId: "ev-denied-conflict-a",
    subjectKey: "payroll_total",
    predicate: "amount",
    claim: "Payroll total is 100.",
    producerAgentId: "finance-agent",
    producerRunId: "run-99",
    sourcePointerId: "ptr-denied-conflict-a",
    citationId: null,
    classification: "CONFIDENTIAL",
    requiredScopes: ["payroll:read"],
    claimHash: `sha256:${hex64("e1")}`,
  });
  const evidenceB = makeEvidence({
    evidenceId: "ev-denied-conflict-b",
    subjectKey: "payroll_total",
    predicate: "amount",
    claim: "Payroll total is 200.",
    producerAgentId: "finance-agent",
    producerRunId: "run-99",
    sourcePointerId: "ptr-denied-conflict-b",
    citationId: null,
    classification: "CONFIDENTIAL",
    requiredScopes: ["payroll:read"],
    claimHash: `sha256:${hex64("e2")}`,
  });

  return new FixtureEvidenceRepository(
    [evidenceA, evidenceB],
    new Map([
      ["ptr-denied-conflict-a", pointerA],
      ["ptr-denied-conflict-b", pointerB],
    ]),
    new Map(),
  );
}

const DEFAULT_USER_PROMPT = "What is the launch date?";

async function setupBroker(
  options: {
    policy?: WalnutPolicy;
    issueGrants?: boolean;
    governanceHead?: number;
    repository?: FixtureEvidenceRepository;
  } = {},
) {
  const root = await makeRoot();
  const policy = options.policy ?? pinnedPolicy();
  const grantStore = new GrantStore(root);
  const evaluator = new AuthorizationEvaluatorImpl({ grantStore, policy, dataDir: root });
  const capsuleStore = new CapsuleStoreImpl(root);
  const versionStore = new AgentVersionStoreImpl(root);
  const clarifications = new ClarificationStoreImpl(root);
  const repository = options.repository ?? buildFixtureRepository();

  if (options.issueGrants ?? true) {
    await grantStore.issue({
      agentId: "strategy-agent",
      principalId: null,
      resourcePattern: "launch:*",
      action: "consume",
      validFrom: "2000-01-01T00:00:00.000Z",
      validTo: null,
      issuedBy: "test",
      supersedesGrantId: null,
    });
    await grantStore.issue({
      agentId: "*",
      principalId: "user:alice",
      resourcePattern: "launch:*",
      action: "consume",
      validFrom: "2000-01-01T00:00:00.000Z",
      validTo: null,
      issuedBy: "test",
      supersedesGrantId: null,
    });
  }

  const broker = new ContextBrokerImpl({
    evidenceRepository: repository,
    evaluator,
    capsuleStore,
    policy,
    clarifications,
    getGovernanceHead: async () => options.governanceHead ?? 0,
  });

  return {
    root,
    grantStore,
    evaluator,
    capsuleStore,
    versionStore,
    repository,
    policy,
    broker,
    clarifications,
  };
}

function buildInput(overrides: { run?: AgentRun; agent?: Agent } = {}) {
  return {
    run: overrides.run ?? makeRun(),
    agent: overrides.agent ?? makeAgent(),
    agentVersionId: "av_test",
    onBehalfOfPrincipalId: "user:alice",
    userPrompt: DEFAULT_USER_PROMPT,
  };
}

describe("ContextBrokerImpl.build / renderPrompt", () => {
  it("INV-1: capsule.evidence refs resolve to ALLOW decisions; the denied payroll decision is DENY", async () => {
    const { root, broker } = await setupBroker();

    const result = await broker.build(buildInput());
    if (result.kind !== "ok") throw new Error(`expected kind "ok", got "${result.kind}"`);

    const decisionsRaw = await readFile(
      path.join(root, "walnut", "decisions", "decisions.json"),
      "utf8",
    );
    const decisions = (JSON.parse(decisionsRaw) as { decisions: AuthorizationDecision[] }).decisions;

    expect(result.capsule.evidence).toHaveLength(2);
    for (const ref of result.capsule.evidence) {
      const decision = decisions.find((candidate) => candidate.decisionId === ref.authorizationDecisionId);
      expect(decision?.result).toBe("ALLOW");
    }

    expect(result.capsule.deniedEvidenceDecisionIds).toHaveLength(1);
    const deniedId = result.capsule.deniedEvidenceDecisionIds[0];
    expect(deniedId).toBeDefined();
    const deniedDecision = decisions.find((candidate) => candidate.decisionId === deniedId);
    expect(deniedDecision?.result).toBe("DENY");
    expect(result.deniedDecisions.map((decision) => decision.decisionId)).toEqual([deniedId]);
  });

  it('INV-2(a): renderPrompt excludes the canary, includes allowed claims + capsule id, and is byte-identical across calls', async () => {
    const { broker } = await setupBroker();

    const result = await broker.build(buildInput());
    if (result.kind !== "ok") throw new Error(`expected kind "ok", got "${result.kind}"`);

    const first = await broker.renderPrompt(DEFAULT_USER_PROMPT, result.capsule);
    const second = await broker.renderPrompt(DEFAULT_USER_PROMPT, result.capsule);

    expect(first).not.toContain(CANARY);
    expect(first).toContain("Launch date is September 14.");
    expect(first).toContain("Launch confirmed for Q3.");
    expect(first).toContain(result.capsule.capsuleId);
    expect(first).toContain(DEFAULT_USER_PROMPT);
    expect(first).toBe(second);
  });

  it("INV-2(b): the persisted capsule file on disk does not contain the canary", async () => {
    const { root, broker } = await setupBroker();

    const result = await broker.build(buildInput());
    if (result.kind !== "ok") throw new Error(`expected kind "ok", got "${result.kind}"`);

    const raw = await readFile(
      path.join(root, "walnut", "capsules", `${result.capsule.capsuleId}.json`),
    );
    expect(raw.includes(CANARY)).toBe(false);
  });

  it("all candidates denied still yields kind ok with an empty capsule and every decision recorded as denied", async () => {
    const { broker } = await setupBroker({ issueGrants: false });

    const result = await broker.build(buildInput());

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(`expected kind "ok", got "${result.kind}"`);
    expect(result.capsule.evidence).toEqual([]);
    expect(result.capsule.deniedEvidenceDecisionIds).toHaveLength(3);
    expect(result.deniedDecisions).toHaveLength(3);
    for (const decision of result.deniedDecisions) {
      expect(decision.result).toBe("DENY");
    }
  });

  it("run-level policy denial: a deny-listed agent yields kind denied and writes no capsule file", async () => {
    const { root, broker } = await setupBroker({
      policy: pinnedPolicy({ denyAgentIds: ["strategy-agent"] }),
    });
    const run = makeRun({ id: "run-denied" });

    const result = await broker.build(buildInput({ run }));

    expect(result).toEqual({
      kind: "denied",
      decisions: [],
      reasonCode: "POLICY_DENIED",
      message: "Agent is deny-listed by policy revision 1",
    });

    const capsuleFiles = await readdir(path.join(root, "walnut", "capsules")).catch(() => [] as string[]);
    expect(capsuleFiles.filter((name) => name.endsWith(".json") && name !== "index.json")).toEqual([]);
  });

  it("capsuleHash integrity: recomputing the canonical hash over the capsule minus capsuleHash matches", async () => {
    const { broker } = await setupBroker();

    const result = await broker.build(buildInput());
    if (result.kind !== "ok") throw new Error(`expected kind "ok", got "${result.kind}"`);

    const { capsuleHash, ...rest } = result.capsule;
    const recomputed = `sha256:${createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex")}`;
    expect(capsuleHash).toBe(recomputed);
  });

  it("INV-7: capsuleStore rejects re-saving the same capsule and a second capsule for the same runId; getByRunId resolves", async () => {
    const { capsuleStore, broker } = await setupBroker();
    const run = makeRun({ id: "run-inv7" });

    const result = await broker.build(buildInput({ run }));
    if (result.kind !== "ok") throw new Error(`expected kind "ok", got "${result.kind}"`);

    await expect(capsuleStore.save(result.capsule)).rejects.toThrow();
    await expect(broker.build(buildInput({ run }))).rejects.toThrow();

    const fetched = await capsuleStore.getByRunId(run.id);
    expect(fetched?.capsuleId).toBe(result.capsule.capsuleId);
  });

  it("frozen: capsule, its evidence array, and each ref reject mutation", async () => {
    const { broker } = await setupBroker();

    const result = await broker.build(buildInput());
    if (result.kind !== "ok") throw new Error(`expected kind "ok", got "${result.kind}"`);

    expect(Object.isFrozen(result.capsule)).toBe(true);
    expect(Object.isFrozen(result.capsule.evidence)).toBe(true);
    for (const ref of result.capsule.evidence) {
      expect(Object.isFrozen(ref)).toBe(true);
    }

    expect(() => {
      (result.capsule.evidence as unknown as unknown[]).push({});
    }).toThrow();
  });

  it("transactionCut uses the stubbed governance head: ledger:0", async () => {
    const { broker } = await setupBroker();

    const result = await broker.build(buildInput());
    if (result.kind !== "ok") throw new Error(`expected kind "ok", got "${result.kind}"`);

    expect(result.capsule.transactionCut).toBe("ledger:0");
  });
});

describe("ContextBrokerImpl.build / conflict detection (P3-C1, INV-22)", () => {
  it('two conflicting AUTHORIZED evidence records yield "clarification_required", not a capsule', async () => {
    const { root, broker, clarifications, capsuleStore } = await setupBroker({
      repository: buildConflictFixtureRepository(),
    });
    const run = makeRun({ id: "run-conflict-a" });

    const result = await broker.build(buildInput({ run }));

    if (result.kind !== "clarification_required") {
      throw new Error(`expected kind "clarification_required", got "${result.kind}"`);
    }
    expect(result.request.kind).toBe("evidence_conflict");
    expect(result.request.runId).toBe(run.id);
    expect(result.request.agentId).toBe("strategy-agent");
    expect(result.request.options).toHaveLength(2);
    expect(result.request.options.map((option) => option.id)).toEqual([
      "ev-conflict-a",
      "ev-conflict-b",
    ]);
    expect(result.request.allowNoneOfAbove).toBe(true);
    expect(result.request.defaultOnTimeout).toBe("REFUSE");
    expect(result.request.resolvedAt).toBeNull();

    const open = await clarifications.listOpen();
    expect(open.map((request) => request.requestId)).toEqual([result.request.requestId]);

    const capsule = await capsuleStore.getByRunId(run.id);
    expect(capsule).toBeNull();

    const capsuleFiles = await readdir(path.join(root, "walnut", "capsules")).catch(
      () => [] as string[],
    );
    expect(
      capsuleFiles.filter((name) => name.endsWith(".json") && name !== "index.json"),
    ).toEqual([]);
  });

  it("a conflict among evidence that was DENIED does not trigger clarification; build stays ok", async () => {
    const { broker } = await setupBroker({
      repository: buildDeniedConflictFixtureRepository(),
    });
    const run = makeRun({ id: "run-conflict-denied" });

    const result = await broker.build(buildInput({ run }));

    expect(result.kind).toBe("ok");
  });

  it("superseding one conflicting evidence record (status SUPERSEDED) makes build ok again", async () => {
    const { broker } = await setupBroker({
      repository: buildConflictFixtureRepository({ secondStatus: "SUPERSEDED" }),
    });
    const run = makeRun({ id: "run-conflict-resolved" });

    const result = await broker.build(buildInput({ run }));

    expect(result.kind).toBe("ok");
  });
});

describe("AgentVersionStoreImpl.resolve", () => {
  it("same agent config resolves to the same versionId; changed instructions mint version 2 and close the prior version", async () => {
    const root = await makeRoot();
    const store = new AgentVersionStoreImpl(root);
    const agent = makeAgent();

    const first = await store.resolve(agent);
    const second = await store.resolve(agent);
    expect(second.versionId).toBe(first.versionId);
    expect(second.version).toBe(1);
    expect(second.supersedesVersionId).toBeNull();

    const changedAgent = makeAgent({ instructions: "Different instructions entirely." });
    const third = await store.resolve(changedAgent);

    expect(third.version).toBe(2);
    expect(third.supersedesVersionId).toBe(first.versionId);
    expect(third.versionId).not.toBe(first.versionId);

    const raw = await readFile(path.join(root, "walnut", "agent-versions", "versions.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      versions: Array<{ versionId: string; txClosedAt: string | null }>;
    };
    const priorRecord = parsed.versions.find((version) => version.versionId === first.versionId);
    expect(priorRecord?.txClosedAt).not.toBeNull();
  });
});
