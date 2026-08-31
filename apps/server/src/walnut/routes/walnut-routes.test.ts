import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../../agent-service.js";
import { createApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { JsonStore } from "../../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../types.js";
import { WorkspaceManager } from "../../workspace.js";
import { AuthorizationEvaluatorImpl } from "../auth/evaluator.js";
import { GrantStore } from "../auth/grant-store.js";
import { defaultPolicy } from "../auth/policy.js";
import { AgentVersionStoreImpl } from "../context/agent-version-store.js";
import { CapsuleStoreImpl } from "../context/capsule-store.js";
import { ClarificationStoreImpl } from "../context/clarification-store.js";
import { ReconciliationServiceImpl, ReconciliationStore } from "../dependency/reconciliation.js";
import { WalnutRunStateStore } from "../dependency/run-state.js";
import { CitationVerifierImpl } from "../context/citation-verifier.js";
import { ContextBrokerImpl } from "../context/context-broker.js";
import { ShareServiceImpl } from "../context/share-service.js";
import { EvidenceStore, FileEvidenceRepository } from "../evidence/evidence-store.js";
import { EvidenceWriteServiceImpl } from "../evidence/evidence-write-service.js";
import { EvidenceLedger } from "../evidence/ledger.js";
import { processOutbox } from "../evidence/outbox.js";
import { Redactor } from "../evidence/redactor.js";
import { WorkspaceArtifactStore } from "../evidence/workspace-artifacts.js";
import { WorkspaceSourceResolver } from "../evidence/workspace-source.js";
import type { LedgerEvent } from "../types.js";
import type { WalnutRouteDeps } from "./walnut-routes.js";

class FakeRunner implements AgentRunner {
  public readonly requests: RunnerRequest[] = [];

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(request);
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const AUTH_TOKEN = "walnut-routes-test-token-0123456789";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface Harness {
  app: FastifyInstance;
  service: AgentService;
  root: string;
  grantStore: GrantStore;
  evidenceStore: EvidenceStore;
  writeService: EvidenceWriteServiceImpl;
  runStates: WalnutRunStateStore;
  config: ReturnType<typeof loadConfig>;
}

async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "walnut-routes-test-"));
  temporaryDirectories.push(root);

  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    APP_AUTH_TOKEN: AUTH_TOKEN,
  });

  const grantStore = new GrantStore(config.dataDirectory);
  const evaluator = new AuthorizationEvaluatorImpl({
    grantStore,
    policy: defaultPolicy,
    dataDir: config.dataDirectory,
  });
  const capsuleStore = new CapsuleStoreImpl(config.dataDirectory);
  const agentVersions = new AgentVersionStoreImpl(config.dataDirectory);
  const ledger = new EvidenceLedger(config.dataDirectory);
  const redactor = new Redactor({ environment: {} });
  const artifactStore = new WorkspaceArtifactStore(config.dataDirectory);

  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const evidenceStore = new EvidenceStore(config.dataDirectory);
  const workspaceSources = new WorkspaceSourceResolver({
    resolveWorkspacePath: (agentId) => workspaces.workspacePath(agentId),
  });
  const evidenceRepository = new FileEvidenceRepository({
    store: evidenceStore,
    sources: workspaceSources,
  });
  const citationVerifier = new CitationVerifierImpl({ evidenceRepository });
  const writeService = new EvidenceWriteServiceImpl({
    store: evidenceStore,
    sources: workspaceSources,
    verifier: citationVerifier,
    ledger,
    redactor,
  });

  const clarificationStore = new ClarificationStoreImpl(root);
  const runStates = new WalnutRunStateStore(root);
  const reconciliationStore = new ReconciliationStore(root);

  const broker = new ContextBrokerImpl({
    evidenceRepository,
    evaluator,
    capsuleStore,
    policy: defaultPolicy,
    getGovernanceHead: async () => (await ledger.verifyChain("_governance")).eventCount,
    clarifications: clarificationStore,
  });

  const shareService = new ShareServiceImpl({
    evidenceRepository,
    evaluator,
    grantStore,
    ledger,
    redactor,
  });

  const processRunOutbox = async (input: {
    workspacePath: string;
    agentId: string;
    runId: string;
  }): Promise<{
    acceptedCount: number;
    rejectedCount: number;
    rejections: Array<{ index: number; reason: string; detail: string }>;
  }> => {
    const result = await processOutbox({
      workspacePath: input.workspacePath,
      agentId: input.agentId,
      runId: input.runId,
      writeService,
    });
    return {
      acceptedCount: result.accepted.length,
      rejectedCount: result.rejected.length,
      rejections: result.rejected,
    };
  };

  const store = new JsonStore(path.join(root, "data", "db.json"));
  const runner = new FakeRunner();
  const service = new AgentService(config, store, workspaces, runner, {
    broker,
    versions: agentVersions,
    capsules: capsuleStore,
    ledger,
    redactor,
    artifacts: artifactStore,
    processRunOutbox,
  });
  await service.initialize();

  const reconcileService = new ReconciliationServiceImpl({
    runStates,
    capsules: capsuleStore,
    ledger,
    redactor,
    store: reconciliationStore,
    startRun: async (agentId, prompt) => {
      const { run } = await service.sendMessage(agentId, prompt);
      return { runId: run.id };
    },
  });

  const routeReceipt = async () => ({
    arkModel: config.arkModel || null,
    codexVersion: "test-codex-0.0.0",
    runtimeProvider: config.runtimeProvider,
    runtimeImage: null,
    sandboxMode: config.codexSandboxMode,
  });

  const walnutDeps: WalnutRouteDeps = {
    store,
    evidenceStore,
    artifactStore,
    capsuleStore,
    agentVersions,
    grantStore,
    ledger,
    writeService,
    shareService,
    redactor,
    evaluator,
    runStates,
    reconciliations: reconciliationStore,
    reconcileService,
    clarifications: clarificationStore,
    routeReceipt,
    dataDir: config.dataDirectory,
  };

  const app = await createApp(config, service, walnutDeps);

  return { app, service, root, grantStore, evidenceStore, writeService, runStates, config };
}

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${AUTH_TOKEN}` };
}

async function readChain(root: string, chainId: string): Promise<LedgerEvent[]> {
  const raw = await readFile(path.join(root, "data", "walnut", "evidence", `${chainId}.ndjson`), "utf8");
  return raw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as LedgerEvent);
}

// Shared Phase-3 fixture: a producer writes one Evidence record, a separate consumer agent is
// granted the matching scope and sends a real (FakeRunner) message, so the resulting Run's
// ContextCapsule genuinely CONTAINS_EVIDENCE it -- the one graph shape blast-radius/reconcile/
// history all need (an evidence node with a real capsule->run path downstream of it).
async function seedConsumedEvidence(
  service: AgentService,
  writeService: EvidenceWriteServiceImpl,
  grantStore: GrantStore,
  options: { scope: string; filename: string; quote: string },
): Promise<{ evidenceId: string; runId: string }> {
  const producer = await service.createAgent({ name: `Producer-${randomUUID()}` });
  const consumer = await service.createAgent({ name: `Consumer-${randomUUID()}` });

  const sourceContent = `${options.quote}\n`;
  await writeFile(path.join(producer.workspacePath, options.filename), sourceContent, "utf8");
  const charStart = sourceContent.indexOf(options.quote);
  const charEnd = charStart + options.quote.length;

  const created = await writeService.createEvidence({
    claim: options.quote,
    subjectKey: null,
    predicate: null,
    producerAgentId: producer.id,
    producerRunId: randomUUID(),
    classification: "INTERNAL",
    requiredScopes: [options.scope],
    source: { path: options.filename, quote: options.quote, charStart, charEnd },
    derivedFromEvidenceIds: [],
    supersedesEvidenceId: null,
    validFrom: null,
    validTo: null,
  });
  if (!created.ok) {
    throw new Error(`setup failed to create evidence: ${created.reason} ${created.detail}`);
  }

  const scopePrefix = options.scope.split(":").slice(0, -1).join(":");
  await grantStore.issue({
    agentId: consumer.id,
    principalId: null,
    resourcePattern: `${scopePrefix}:*`,
    action: "consume",
    validFrom: new Date(0).toISOString(),
    validTo: null,
    issuedBy: "test",
    supersedesGrantId: null,
  });

  const { run } = await service.sendMessage(consumer.id, `about ${options.filename}`);
  await expect.poll(() => service.getRun(run.id).status).toBe("completed");

  return { evidenceId: created.evidence.evidenceId, runId: run.id };
}

describe("Grants routes", () => {
  it("issues, lists, and revokes a grant; grant.issued/grant.revoked land on the governance chain; a second revoke is 409", async () => {
    const { app, service, root } = await makeHarness();
    const agent = await service.createAgent({ name: "Grantee" });

    const issueResponse = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/grants`,
      headers: authHeader(),
      payload: { resourcePattern: "project:launch:*", action: "consume" },
    });
    expect(issueResponse.statusCode).toBe(200);
    const grant = issueResponse.json().grant;
    expect(grant.agentId).toBe(agent.id);
    expect(grant.resourcePattern).toBe("project:launch:*");
    expect(grant.action).toBe("consume");

    const governanceAfterIssue = await readChain(root, "_governance");
    expect(governanceAfterIssue.at(-1)?.kind).toBe("grant.issued");

    const listResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/grants`,
      headers: authHeader(),
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().grants.map((item: { grantId: string }) => item.grantId)).toContain(
      grant.grantId,
    );

    const otherAgent = await service.createAgent({ name: "Other grantee" });
    const crossAgentRevoke = await app.inject({
      method: "POST",
      url: `/api/agents/${otherAgent.id}/grants/${grant.grantId}/revoke`,
      headers: authHeader(),
    });
    expect(crossAgentRevoke.statusCode).toBe(409);

    const revokeResponse = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/grants/${grant.grantId}/revoke`,
      headers: authHeader(),
    });
    expect(revokeResponse.statusCode).toBe(200);
    expect(revokeResponse.json().grant.txClosedAt).not.toBeNull();

    const governanceAfterRevoke = await readChain(root, "_governance");
    expect(governanceAfterRevoke.at(-1)?.kind).toBe("grant.revoked");

    const secondRevoke = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/grants/${grant.grantId}/revoke`,
      headers: authHeader(),
    });
    expect(secondRevoke.statusCode).toBe(409);

    await app.close();
  });

  it("rejects malformed validity instants and principal identities", async () => {
    const { app, service } = await makeHarness();
    const agent = await service.createAgent({ name: "Validated grantee" });

    for (const payload of [
      { resourcePattern: "project:*", action: "consume", validTo: "tomorrow" },
      { resourcePattern: "project:*", action: "consume", principalId: "alice" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/grants`,
        headers: authHeader(),
        payload,
      });
      expect(response.statusCode).toBe(400);
    }

    await app.close();
  });
});

describe("Evidence detail + lifecycle", () => {
  it("returns evidence detail with citation and pointer, then revoke transitions it to REVOKED with 2 versions; unknown id is 404", async () => {
    const { app, service, writeService } = await makeHarness();
    const agent = await service.createAgent({ name: "Producer" });

    const sourceContent = "The launch date is October 1.\n";
    await writeFile(path.join(agent.workspacePath, "notes.txt"), sourceContent, "utf8");
    const quote = "The launch date is October 1.";
    const charStart = sourceContent.indexOf(quote);
    const charEnd = charStart + quote.length;

    const created = await writeService.createEvidence({
      claim: quote,
      subjectKey: null,
      predicate: null,
      producerAgentId: agent.id,
      producerRunId: randomUUID(),
      classification: "INTERNAL",
      requiredScopes: ["project:launch:read"],
      source: { path: "notes.txt", quote, charStart, charEnd },
      derivedFromEvidenceIds: [],
      supersedesEvidenceId: null,
      validFrom: null,
      validTo: null,
    });
    if (!created.ok) {
      throw new Error(`setup failed to create evidence: ${created.reason} ${created.detail}`);
    }
    const evidenceId = created.evidence.evidenceId;

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/evidence/${evidenceId}`,
      headers: authHeader(),
    });
    expect(detailResponse.statusCode).toBe(200);
    const detail = detailResponse.json();
    expect(detail.current.evidenceId).toBe(evidenceId);
    expect(detail.versions).toHaveLength(1);
    expect(detail.citation).not.toBeNull();
    expect(detail.pointer).not.toBeNull();

    const revokeResponse = await app.inject({
      method: "POST",
      url: `/api/evidence/${evidenceId}/revoke`,
      headers: authHeader(),
      payload: { reason: "source integrity concern" },
    });
    expect(revokeResponse.statusCode).toBe(200);
    expect(revokeResponse.json().evidence.status).toBe("REVOKED");

    const detailAfterRevoke = await app.inject({
      method: "GET",
      url: `/api/evidence/${evidenceId}`,
      headers: authHeader(),
    });
    expect(detailAfterRevoke.json().current.status).toBe("REVOKED");
    expect(detailAfterRevoke.json().versions).toHaveLength(2);

    const unknownResponse = await app.inject({
      method: "GET",
      url: `/api/evidence/ev_${randomUUID()}`,
      headers: authHeader(),
    });
    expect(unknownResponse.statusCode).toBe(404);

    await app.close();
  });
});

describe("Share route", () => {
  it("shares evidence from a granted sender to a recipient lacking a grant, transferring access and returning ALLOW; sharing unknown evidence is 404", async () => {
    const { app, service, writeService, grantStore } = await makeHarness();
    const producer = await service.createAgent({ name: "ShareProducer" });
    const sender = await service.createAgent({ name: "Sender" });
    const recipient = await service.createAgent({ name: "Recipient" });

    const sourceContent = "Budget approved at 2 million.\n";
    await writeFile(path.join(producer.workspacePath, "budget.txt"), sourceContent, "utf8");
    const quote = "Budget approved at 2 million.";
    const charStart = sourceContent.indexOf(quote);
    const charEnd = charStart + quote.length;

    const created = await writeService.createEvidence({
      claim: quote,
      subjectKey: null,
      predicate: null,
      producerAgentId: producer.id,
      producerRunId: randomUUID(),
      classification: "INTERNAL",
      requiredScopes: ["project:budget:read"],
      source: { path: "budget.txt", quote, charStart, charEnd },
      derivedFromEvidenceIds: [],
      supersedesEvidenceId: null,
      validFrom: null,
      validTo: null,
    });
    if (!created.ok) {
      throw new Error(`setup failed to create evidence: ${created.reason} ${created.detail}`);
    }
    const evidenceId = created.evidence.evidenceId;

    // The sender needs its own "share" grant over the scope to pass the sender-side check.
    await grantStore.issue({
      agentId: sender.id,
      principalId: null,
      resourcePattern: "project:budget:*",
      action: "share",
      validFrom: new Date(0).toISOString(),
      validTo: null,
      issuedBy: "test",
      supersedesGrantId: null,
    });

    const shareResponse = await app.inject({
      method: "POST",
      url: `/api/evidence/${evidenceId}/share/${recipient.id}`,
      headers: authHeader(),
      payload: { fromAgentId: sender.id },
    });
    expect(shareResponse.statusCode).toBe(200);
    const body = shareResponse.json();
    expect(body.result).toBe("ALLOW");
    expect(body.issuedGrantIds).toHaveLength(1);
    expect(typeof body.senderDecisionId).toBe("string");
    expect(typeof body.recipientDecisionId).toBe("string");
    expect(typeof body.reasonCode).toBe("string");

    const unknownShareResponse = await app.inject({
      method: "POST",
      url: `/api/evidence/ev_${randomUUID()}/share/${recipient.id}`,
      headers: authHeader(),
      payload: { fromAgentId: sender.id },
    });
    expect(unknownShareResponse.statusCode).toBe(404);

    await app.close();
  });
});

describe("Run overview, evidence timeline, and verify", () => {
  it("returns live summaries plus denied evidence reasons, applies knownAt, and verifies both chains", async () => {
    const { app, service, writeService } = await makeHarness();
    const producer = await service.createAgent({ name: "DeniedEvidenceProducer" });
    const consumer = await service.createAgent({ name: "DeniedEvidenceConsumer" });
    const sourceContent = "Payroll adjustment pool is restricted.\n";
    const quote = "Payroll adjustment pool is restricted.";
    await writeFile(path.join(producer.workspacePath, "payroll.txt"), sourceContent, "utf8");

    const created = await writeService.createEvidence({
      claim: quote,
      subjectKey: "project:aurora",
      predicate: "payroll_adjustment",
      producerAgentId: producer.id,
      producerRunId: randomUUID(),
      classification: "RESTRICTED",
      requiredScopes: ["project:payroll:read"],
      source: { path: "payroll.txt", quote, charStart: 0, charEnd: quote.length },
      derivedFromEvidenceIds: [],
      supersedesEvidenceId: null,
      validFrom: null,
      validTo: null,
    });
    if (!created.ok) {
      throw new Error(`setup failed to create evidence: ${created.reason} ${created.detail}`);
    }

    const { run: deniedRun } = await service.sendMessage(consumer.id, "summarize the launch plan");
    await expect.poll(() => service.getRun(deniedRun.id).status).toBe("completed");

    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${deniedRun.id}/evidence`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.deniedDecisionIds).toHaveLength(1);
    expect(body.deniedDecisions).toHaveLength(1);
    expect(body.deniedDecisions[0]).toMatchObject({
      decision: {
        decisionId: body.deniedDecisionIds[0],
        evidenceId: created.evidence.evidenceId,
        result: "DENY",
        reasonCode: "AGENT_SCOPE_MISSING",
        policyRevision: 1,
      },
      evidence: {
        evidenceId: created.evidence.evidenceId,
        claim: quote,
        classification: "RESTRICTED",
      },
    });

    const agent = await service.createAgent({ name: "Runner" });
    const { run } = await service.sendMessage(agent.id, "what is the launch date?");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const overviewResponse = await app.inject({
      method: "GET",
      url: `/api/runs/${run.id}/walnut`,
      headers: authHeader(),
    });
    expect(overviewResponse.statusCode).toBe(200);
    const overview = overviewResponse.json();
    expect(overview.capsule).not.toBeNull();
    expect(overview.chain.ok).toBe(true);
    expect(overview.note).toContain("Live Walnut state");
    expect(overview.walnutRunState).toBe("CLEAN");
    expect(overview.attestation).not.toBeNull();
    expect(overview.attestation.chainVerified).toBe(true);
    expect(overview.evidenceSummary).toEqual({ consumed: 0, denied: 1, produced: 0 });
    expect(overview.dependencySummary.directEdges).toBeGreaterThan(0);
    expect(overview.recoverySummary).toEqual({ count: 0, latest: null });

    const evidenceResponse = await app.inject({
      method: "GET",
      url: `/api/runs/${run.id}/evidence?knownAt=2026-01-01T00:00:00.000Z`,
      headers: authHeader(),
    });
    expect(evidenceResponse.statusCode).toBe(200);
    expect(evidenceResponse.json().knownAt).toBe("2026-01-01T00:00:00.000Z");
    expect(evidenceResponse.json().consumed).toEqual([]);

    const offsetEvidenceResponse = await app.inject({
      method: "GET",
      url: `/api/runs/${run.id}/evidence?knownAt=${encodeURIComponent("2026-01-01T08:00:00.000+08:00")}`,
      headers: authHeader(),
    });
    expect(offsetEvidenceResponse.statusCode).toBe(200);
    expect(offsetEvidenceResponse.json().knownAt).toBe("2026-01-01T00:00:00.000Z");

    const evidenceResponseNoQuery = await app.inject({
      method: "GET",
      url: `/api/runs/${run.id}/evidence`,
      headers: authHeader(),
    });
    expect(evidenceResponseNoQuery.json().knownAt).toBeNull();

    const invalidKnownAt = await app.inject({
      method: "GET",
      url: `/api/runs/${run.id}/evidence?knownAt=not-a-date`,
      headers: authHeader(),
    });
    expect(invalidKnownAt.statusCode).toBe(400);

    const verifyResponse = await app.inject({
      method: "GET",
      url: `/api/runs/${run.id}/evidence/verify`,
      headers: authHeader(),
    });
    expect(verifyResponse.statusCode).toBe(200);
    const verify = verifyResponse.json();
    expect(verify.run.ok).toBe(true);
    expect(verify.governance.ok).toBe(true);

    const eventsResponse = await app.inject({
      method: "GET",
      url: `/api/runs/${run.id}/events`,
      headers: authHeader(),
    });
    expect(eventsResponse.statusCode).toBe(200);
    const flightRecorder = eventsResponse.json();
    expect(flightRecorder.chain.ok).toBe(true);
    expect(flightRecorder.events.map((event: { kind: string }) => event.kind)).toEqual([
      "run.requested",
      "capsule.finalized",
      "run.completed",
    ]);
    expect(flightRecorder.events[0]).toMatchObject({
      sequence: 1,
      actor: "middleware",
      redactionApplied: false,
    });

    await app.close();
  });
});

describe("Dependencies route", () => {
  it("projects a graph containing the run node and its capsule node, focused on the run", async () => {
    const { app, service } = await makeHarness();
    const agent = await service.createAgent({ name: "DepRunner" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const capsule = await service.getCapsuleForRun(run.id);

    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${run.id}/dependencies`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.focus).toBe(run.id);
    expect(body.graph.nodes.length).toBeGreaterThan(0);
    const nodeIds = body.graph.nodes.map((node: { id: string }) => node.id);
    expect(nodeIds).toContain(run.id);
    expect(nodeIds).toContain(capsule?.capsuleId);

    await app.close();
  });
});

describe("Auth coverage", () => {
  it("rejects a walnut route request with no bearer token", async () => {
    const { app } = await makeHarness();
    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${randomUUID()}/grants`,
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("Blast radius + revoke/compromise tagging (P3-D2/E1)", () => {
  it("computes a blast radius from evidence to the run whose capsule contains it, and compromising the evidence marks that run TAINTED", async () => {
    const { app, service, writeService, grantStore, runStates } = await makeHarness();
    const { evidenceId, runId } = await seedConsumedEvidence(service, writeService, grantStore, {
      scope: "project:contract:read",
      filename: "contract.txt",
      quote: "The contract renews on March 1.",
    });

    const notFoundResponse = await app.inject({
      method: "GET",
      url: `/api/evidence/ev_${randomUUID()}/blast-radius`,
      headers: authHeader(),
    });
    expect(notFoundResponse.statusCode).toBe(404);

    const blastResponse = await app.inject({
      method: "GET",
      url: `/api/evidence/${evidenceId}/blast-radius`,
      headers: authHeader(),
    });
    expect(blastResponse.statusCode).toBe(200);
    expect(blastResponse.json().blastRadius.runIds).toContain(runId);

    const compromiseResponse = await app.inject({
      method: "POST",
      url: `/api/evidence/${evidenceId}/compromise`,
      headers: authHeader(),
      payload: { reason: "source integrity incident" },
    });
    expect(compromiseResponse.statusCode).toBe(200);
    const compromiseBody = compromiseResponse.json();
    expect(compromiseBody.evidence.status).toBe("COMPROMISED");
    expect(compromiseBody.blastRadius.runIds).toContain(runId);

    expect(await runStates.get(runId)).toBe("TAINTED");

    await app.close();
  });
});

describe("Reconcile route (P3-D4)", () => {
  it("refuses a CLEAN run with 409 and reconciles a TAINTED run into a new completed Run", async () => {
    const { app, service, writeService, grantStore } = await makeHarness();

    const cleanAgent = await service.createAgent({ name: "CleanAgent" });
    const { run: cleanRun } = await service.sendMessage(cleanAgent.id, "hello");
    await expect.poll(() => service.getRun(cleanRun.id).status).toBe("completed");

    const cleanReconcile = await app.inject({
      method: "POST",
      url: `/api/runs/${cleanRun.id}/reconcile`,
      headers: authHeader(),
    });
    expect(cleanReconcile.statusCode).toBe(409);

    const { evidenceId, runId: staleRunId } = await seedConsumedEvidence(
      service,
      writeService,
      grantStore,
      {
        scope: "project:vendor:read",
        filename: "vendor.txt",
        quote: "The vendor contract renews annually.",
      },
    );

    const compromiseResponse = await app.inject({
      method: "POST",
      url: `/api/evidence/${evidenceId}/compromise`,
      headers: authHeader(),
      payload: { reason: "vendor leak" },
    });
    expect(compromiseResponse.statusCode).toBe(200);

    const reconcileResponse = await app.inject({
      method: "POST",
      url: `/api/runs/${staleRunId}/reconcile`,
      headers: authHeader(),
    });
    expect(reconcileResponse.statusCode).toBe(200);
    const reconciliation = reconcileResponse.json().reconciliation;
    expect(reconciliation.staleRunId).toBe(staleRunId);
    expect(reconciliation.result).toBe("COMPLETED");

    const newRun = service.getRun(reconciliation.replacementRunId as string);
    expect(newRun.id).toBe(reconciliation.replacementRunId);

    const unknownRunReconcile = await app.inject({
      method: "POST",
      url: `/api/runs/${randomUUID()}/reconcile`,
      headers: authHeader(),
    });
    expect(unknownRunReconcile.statusCode).toBe(404);

    await app.close();
  }, 15000);
});

describe("History route (P3-D5/D6)", () => {
  it("returns runState + evidence restricted to what the run actually consumed, filtered by knownAt", async () => {
    const { app, service, writeService, grantStore } = await makeHarness();
    const beforeCreate = new Date().toISOString();

    const { evidenceId, runId } = await seedConsumedEvidence(service, writeService, grantStore, {
      scope: "project:lease:read",
      filename: "lease.txt",
      quote: "The lease expires in December.",
    });

    const historyResponse = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/history`,
      headers: authHeader(),
    });
    expect(historyResponse.statusCode).toBe(200);
    const history = historyResponse.json();
    expect(
      history.evidence.map((item: { evidenceId: string }) => item.evidenceId),
    ).toEqual([evidenceId]);
    expect(history.runState).toBe("CLEAN");
    expect(history.stateHistory).toEqual([]);

    const beforeResponse = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/history?knownAt=${encodeURIComponent(beforeCreate)}`,
      headers: authHeader(),
    });
    expect(beforeResponse.statusCode).toBe(200);
    expect(beforeResponse.json().evidence).toEqual([]);

    await app.close();
  });
});

describe("Attestation route (P3-E1)", () => {
  it("returns real counts, chainHead, and routeReceipt for a completed run", async () => {
    const { app, service } = await makeHarness();
    const agent = await service.createAgent({ name: "AttestRunner" });
    const { run } = await service.sendMessage(agent.id, "what time is the launch?");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${run.id}/attestation`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.attestation).not.toBeNull();
    expect(body.attestation.eventCount).toBeGreaterThan(0);
    expect(body.attestation.chainVerified).toBe(true);
    expect(body.attestation.walnutRunState).toBe("CLEAN");
    expect(body.attestation.changedArtifacts).toEqual([]);
    expect(typeof body.attestation.chainHead).toBe("string");
    expect(body.attestation.routeReceipt.codexVersion).toBe("test-codex-0.0.0");
    expect(body.attestation.routeReceipt.arkModel).toBeNull();
    expect(body.note).toContain("safe before/after workspace diffs");

    await app.close();
  });

  it("returns { attestation: null, note } for a run with no capsule", async () => {
    const { app, service } = await makeHarness();
    const agent = await service.createAgent({ name: "DeniedAgent" });
    defaultPolicy.denyAgentIds.push(agent.id);
    try {
      const { run } = await service.sendMessage(agent.id, "hello");
      await expect.poll(() => service.getRun(run.id).status).toBe("failed");

      const response = await app.inject({
        method: "GET",
        url: `/api/runs/${run.id}/attestation`,
        headers: authHeader(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.attestation).toBeNull();
      expect(body.note).toBe("run has no capsule");
    } finally {
      defaultPolicy.denyAgentIds = defaultPolicy.denyAgentIds.filter((id) => id !== agent.id);
    }

    await app.close();
  });
});

describe("Clarifications route (P3-C1 visibility)", () => {
  it("returns an empty open list when there are no open clarification requests", async () => {
    const { app } = await makeHarness();
    const response = await app.inject({
      method: "GET",
      url: "/api/walnut/clarifications",
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().open).toEqual([]);
    await app.close();
  });
});

describe("Verify-tamper route (P3-E1)", () => {
  it("detects tampering in a demo-only corrupted copy without ever touching the real chain", async () => {
    const { app, service } = await makeHarness();
    const agent = await service.createAgent({ name: "TamperRunner" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const plainResponse = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/verify-tamper`,
      headers: authHeader(),
    });
    expect(plainResponse.statusCode).toBe(200);
    expect(plainResponse.json().ok).toBe(true);

    const tamperResponse = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/verify-tamper`,
      headers: authHeader(),
      payload: { corruptSequence: 1 },
    });
    expect(tamperResponse.statusCode).toBe(200);
    const body = tamperResponse.json();
    expect(body.original.ok).toBe(true);
    expect(body.corrupted.ok).toBe(false);

    const realChainAfter = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/verify-tamper`,
      headers: authHeader(),
    });
    expect(realChainAfter.statusCode).toBe(200);
    expect(realChainAfter.json().ok).toBe(true);

    await app.close();
  });
});
