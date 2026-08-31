import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { AuthorizationEvaluatorImpl } from "./walnut/auth/evaluator.js";
import { GrantStore } from "./walnut/auth/grant-store.js";
import { defaultPolicy, type WalnutPolicy } from "./walnut/auth/policy.js";
import { AgentVersionStoreImpl } from "./walnut/context/agent-version-store.js";
import { CapsuleStoreImpl } from "./walnut/context/capsule-store.js";
import { ClarificationStoreImpl } from "./walnut/context/clarification-store.js";
import { CitationVerifierImpl } from "./walnut/context/citation-verifier.js";
import { ContextBrokerImpl } from "./walnut/context/context-broker.js";
import type { LedgerEvent } from "./walnut/types.js";
import { EvidenceLedger } from "./walnut/evidence/ledger.js";
import { EvidenceStore, FileEvidenceRepository } from "./walnut/evidence/evidence-store.js";
import { EvidenceWriteServiceImpl } from "./walnut/evidence/evidence-write-service.js";
import { processOutbox } from "./walnut/evidence/outbox.js";
import { Redactor } from "./walnut/evidence/redactor.js";
import { WorkspaceArtifactStore } from "./walnut/evidence/workspace-artifacts.js";
import { WorkspaceSourceResolver } from "./walnut/evidence/workspace-source.js";
import { WorkspaceManager } from "./workspace.js";

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

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  options: { policy?: WalnutPolicy; root?: string } = {},
): Promise<{
  service: AgentService;
  root: string;
  grantStore: GrantStore;
  artifactStore: WorkspaceArtifactStore;
}> {
  const root = options.root ?? (await mkdtemp(path.join(tmpdir(), "launchpad-test-")));
  if (options.root === undefined) temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });

  const policy = options.policy ?? defaultPolicy;
  const grantStore = new GrantStore(config.dataDirectory);
  const evaluator = new AuthorizationEvaluatorImpl({ grantStore, policy, dataDir: config.dataDirectory });
  const capsuleStore = new CapsuleStoreImpl(config.dataDirectory);
  const versionStore = new AgentVersionStoreImpl(config.dataDirectory);
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
  const evidenceWriteService = new EvidenceWriteServiceImpl({
    store: evidenceStore,
    sources: workspaceSources,
    verifier: citationVerifier,
    ledger,
    redactor,
  });

  const broker = new ContextBrokerImpl({
    evidenceRepository,
    evaluator,
    capsuleStore,
    policy,
    getGovernanceHead: async () => (await ledger.verifyChain("_governance")).eventCount,
    clarifications: new ClarificationStoreImpl(root),
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
      writeService: evidenceWriteService,
    });
    return {
      acceptedCount: result.accepted.length,
      rejectedCount: result.rejected.length,
      rejections: result.rejected,
    };
  };

  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    workspaces,
    runner,
    {
      broker,
      versions: versionStore,
      capsules: capsuleStore,
      ledger,
      redactor,
      artifacts: artifactStore,
      processRunOutbox,
    },
  );
  await service.initialize();
  return { service, root, grantStore, artifactStore };
}

async function readRunChain(root: string, runId: string): Promise<LedgerEvent[]> {
  const raw = await readFile(path.join(root, "data", "walnut", "evidence", `${runId}.ndjson`), "utf8");
  return raw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as LedgerEvent);
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const { service } = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const { service } = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service } = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const { service } = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("redacts runner errors before persisting or serving them", async () => {
    const plantedSecret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    const runner: AgentRunner = {
      run: async () => {
        throw new Error(`provider rejected ${plantedSecret}`);
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service, root } = await makeService(runner);
    expect((await service.systemInfo()).arkModel).toBeNull();
    const agent = await service.createAgent({ name: "Failure redaction" });
    const { run } = await service.sendMessage(agent.id, "trigger failure");

    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getRun(run.id).error).toBe("provider rejected [REDACTED]");
    expect(service.getAgent(agent.id).lastError).toBe("provider rejected [REDACTED]");

    const rawDatabase = await readFile(path.join(root, "data", "db.json"), "utf8");
    expect(rawDatabase).not.toContain(plantedSecret);
  });

  it("records workspace changes from a persisted before/after manifest", async () => {
    const runner: AgentRunner = {
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "result.txt"), "created by run", "utf8");
        return { output: "done", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service, root, artifactStore } = await makeService(runner);
    const agent = await service.createAgent({ name: "Artifact producer" });
    const { run } = await service.sendMessage(agent.id, "create an artifact");

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(await artifactStore.listByRun(run.id)).toMatchObject([
      { runId: run.id, relativePath: "result.txt", state: "CREATED" },
    ]);
    expect((await readRunChain(root, run.id)).map((event) => event.kind)).toEqual([
      "run.requested",
      "capsule.finalized",
      "artifact.diff",
      "run.completed",
    ]);
  });
});

describe("AgentService x walnut context/evidence wiring (P1-X1)", () => {
  it("(a) a successful run gets a capsule, a walnut-rendered prompt, populated RunnerRequest fields, and an ordered, verified ledger chain", async () => {
    const runner = new FakeRunner();
    const { service, root } = await makeService(runner);
    const agent = await service.createAgent({ name: "Walnut Builder" });
    const { run } = await service.sendMessage(agent.id, "what is the launch date?");

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const capsule = await service.getCapsuleForRun(run.id);
    expect(capsule).not.toBeNull();
    expect(capsule?.runId).toBe(run.id);

    expect(runner.requests).toHaveLength(1);
    const request = runner.requests[0];
    expect(request?.prompt.startsWith(`<WALNUT_CONTEXT capsule="${capsule?.capsuleId}"`)).toBe(true);
    expect(request?.runId).toBe(run.id);
    expect(request?.principalId).toBeNull();
    expect(request?.agentVersionId).toBe(capsule?.agentVersionId);
    expect(request?.contextCapsuleId).toBe(capsule?.capsuleId);

    const chain = await readRunChain(root, run.id);
    expect(chain.map((event) => event.kind)).toEqual([
      "run.requested",
      "capsule.finalized",
      "run.completed",
    ]);

    const ledger = new EvidenceLedger(path.join(root, "data"));
    expect(await ledger.verifyChain(run.id)).toMatchObject({ ok: true, eventCount: 3 });
  });

  it("(b) a deny-listed agent fails the run before the runner is ever invoked; no capsule is persisted", async () => {
    const runner = new FakeRunner();
    // The deny list keys by agentId, which is only minted once createAgent runs — so create the
    // agent under a permissive service first, then re-open a second service pointed at the SAME
    // data directory with a policy that denies that exact id.
    const { service: setupService, root } = await makeService(runner);
    const setupAgent = await setupService.createAgent({ name: "Denied Agent" });

    const denyingPolicy: WalnutPolicy = {
      revision: 1,
      denyAgentIds: [setupAgent.id],
      classificationCeilings: {},
    };
    const { service: denyingService } = await makeService(runner, { policy: denyingPolicy, root });

    const { run } = await denyingService.sendMessage(setupAgent.id, "what is the launch date?");
    await expect.poll(() => denyingService.getRun(run.id).status).toBe("failed");

    expect(denyingService.getRun(run.id).error).toContain("deny-listed");
    expect(denyingService.getAgent(setupAgent.id).status).toBe("ready");
    expect(runner.requests).toHaveLength(0);

    const capsule = await denyingService.getCapsuleForRun(run.id);
    expect(capsule).toBeNull();
    const capsuleFiles = await readdir(path.join(root, "data", "walnut", "capsules")).catch(
      () => [] as string[],
    );
    expect(capsuleFiles.filter((name) => name.endsWith(".json") && name !== "index.json")).toEqual([]);
  });

  it("(c) the prompt text never reaches the run chain — only its hash does", async () => {
    const runner = new FakeRunner();
    const { service, root } = await makeService(runner);
    const agent = await service.createAgent({ name: "Prompt Hash Agent" });
    const distinctivePrompt = "WALNUT_TEST_DISTINCTIVE_PROMPT_9f3ac1";
    const { run } = await service.sendMessage(agent.id, distinctivePrompt);

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const raw = await readFile(
      path.join(root, "data", "walnut", "evidence", `${run.id}.ndjson`),
      "utf8",
    );
    expect(raw.includes(distinctivePrompt)).toBe(false);

    const chain = await readRunChain(root, run.id);
    const requested = chain.find((event) => event.kind === "run.requested");
    const payload = requested?.safePayload as { promptHash: string };
    expect(payload.promptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("AgentService x walnut evidence outbox (P2-E1/P2-E2/P2-E3)", () => {
  it("persists a redacted, inspectable rejection event when a citation does not match", async () => {
    const { service, root } = await makeService();
    const agent = await service.createAgent({ name: "Citation verifier" });
    const sourceRelativePath = "launch-date.txt";
    const sourceContent = "The approved launch date is October 1.";
    await writeFile(path.join(agent.workspacePath, sourceRelativePath), sourceContent, "utf8");
    const actualQuote = "October 1";
    const charStart = sourceContent.indexOf(actualQuote);

    await mkdir(path.join(agent.workspacePath, ".walnut"), { recursive: true });
    await writeFile(
      path.join(agent.workspacePath, ".walnut", "outbox.json"),
      JSON.stringify({
        evidence: [
          {
            claim: "The launch date is October 15.",
            classification: "INTERNAL",
            requiredScopes: ["project:launch:read"],
            source: {
              path: sourceRelativePath,
              quote: "October 15",
              charStart,
              charEnd: charStart + actualQuote.length,
            },
            derivedFromEvidenceIds: [],
          },
        ],
      }),
      "utf8",
    );

    const { run } = await service.sendMessage(agent.id, "publish the launch date");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const chain = await readRunChain(root, run.id);
    expect(chain.map((event) => event.kind)).toEqual([
      "run.requested",
      "capsule.finalized",
      "evidence.proposal_rejected",
      "evidence.outbox_processed",
      "run.completed",
    ]);
    const rejection = chain.find((event) => event.kind === "evidence.proposal_rejected");
    expect(rejection?.safePayload).toMatchObject({
      proposalIndex: 0,
      reason: "citation_mismatch",
    });
    expect(rejection?.redactionReceipt).toBeDefined();
    expect(chain.find((event) => event.kind === "evidence.outbox_processed")?.safePayload).toEqual({
      acceptedCount: 0,
      rejectedCount: 1,
    });
  });

  it("ingests a Run's workspace outbox into real Evidence, then re-authorizes it on a later, different Agent's Run (INV-1/INV-2 integration)", async () => {
    const producerRunner = new FakeRunner();
    const { service: producerService, root } = await makeService(producerRunner);
    const producerAgent = await producerService.createAgent({ name: "Producer" });

    const sourceRelativePath = "launch-plan.txt";
    const sourceContent = "Preface.\nLaunch date is September 14.\nTrailer.\n";
    await writeFile(
      path.join(producerAgent.workspacePath, sourceRelativePath),
      sourceContent,
      "utf8",
    );
    const quote = "Launch date is September 14.";
    const charStart = sourceContent.indexOf(quote);
    const charEnd = charStart + quote.length;

    await mkdir(path.join(producerAgent.workspacePath, ".walnut"), { recursive: true });
    await writeFile(
      path.join(producerAgent.workspacePath, ".walnut", "outbox.json"),
      JSON.stringify({
        evidence: [
          {
            claim: "Launch date is September 14.",
            classification: "INTERNAL",
            requiredScopes: ["project:launch:read"],
            source: { path: sourceRelativePath, quote, charStart, charEnd },
            derivedFromEvidenceIds: [],
          },
        ],
      }),
      "utf8",
    );

    const { run: producerRun } = await producerService.sendMessage(
      producerAgent.id,
      "publish the launch date",
    );
    await expect.poll(() => producerService.getRun(producerRun.id).status).toBe("completed");

    const producerChain = await readRunChain(root, producerRun.id);
    expect(producerChain.map((event) => event.kind)).toEqual([
      "run.requested",
      "capsule.finalized",
      "evidence.created",
      "evidence.outbox_processed",
      "run.completed",
    ]);
    const outboxEvent = producerChain.find((event) => event.kind === "evidence.outbox_processed");
    expect(outboxEvent?.safePayload).toEqual({ acceptedCount: 1, rejectedCount: 0 });

    const processedFiles = await readdir(path.join(producerAgent.workspacePath, ".walnut"));
    expect(processedFiles).toContain(`outbox.processed-${producerRun.id}.json`);

    // A second, unrelated Agent under the SAME data directory, with no grants yet: the new
    // evidence is a candidate for every consuming Agent (v1 listCandidateEvidence is agent-id
    // blind), but is DENIED for lack of a scope grant — the capsule is still valid and empty,
    // and the DENY decision id is recorded (spec 003 §A1: per-evidence DENY -> kind "ok").
    const consumerRunner = new FakeRunner();
    const { service: consumerService, grantStore: consumerGrantStore } = await makeService(
      consumerRunner,
      { root },
    );
    const consumerAgent = await consumerService.createAgent({ name: "Consumer" });

    const { run: firstConsumerRun } = await consumerService.sendMessage(
      consumerAgent.id,
      "what is the launch date?",
    );
    await expect.poll(() => consumerService.getRun(firstConsumerRun.id).status).toBe("completed");

    const deniedCapsule = await consumerService.getCapsuleForRun(firstConsumerRun.id);
    expect(deniedCapsule?.evidence).toEqual([]);
    expect(deniedCapsule?.deniedEvidenceDecisionIds.length).toBe(1);
    expect(consumerRunner.requests[0]?.prompt).not.toContain("Launch date is September 14.");

    // Issue the consumer Agent a grant covering the required scope, then re-run: the evidence
    // ref now enters the capsule, and its claim text reaches the FakeRunner-captured rendered
    // prompt (HC-5: authorization happens before context construction, not after).
    await consumerGrantStore.issue({
      agentId: consumerAgent.id,
      principalId: null,
      resourcePattern: "project:launch:*",
      action: "consume",
      validFrom: new Date(0).toISOString(),
      validTo: null,
      issuedBy: "test",
      supersedesGrantId: null,
    });

    const { run: secondConsumerRun } = await consumerService.sendMessage(
      consumerAgent.id,
      "what is the launch date?",
    );
    await expect.poll(() => consumerService.getRun(secondConsumerRun.id).status).toBe("completed");

    const allowedCapsule = await consumerService.getCapsuleForRun(secondConsumerRun.id);
    expect(allowedCapsule?.evidence.length).toBe(1);
    expect(consumerRunner.requests[1]?.prompt).toContain("Launch date is September 14.");
  });
});
