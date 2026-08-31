// High-value end-to-end test (docs/walnut/06-IMPLEMENTATION-TEST-DEMO-PLAN.md §8, P3-T1).
//
// Wires the REAL walnut plane (auth, context, evidence, dependency) around ONE fake AgentRunner
// that emits a realistic Codex JSONL sequence (command started -> command failed -> file change
// -> agent message -> turn completed) through the injected RuntimeEventSink, and that plants a
// producer-only workspace outbox proposing two evidence records: one INTERNAL launch-date fact
// (grantable) and one CONFIDENTIAL payroll fact carrying a canary literal (never grantable in
// this test). It then walks the full thesis in order: authorize -> render -> chain -> project ->
// compromise -> blast-radius -> taint -> reconcile -> re-authorize-honestly.
//
// Sequential `it`s share state built once in `beforeAll` (vitest runs `it`s within a `describe`
// serially by default) rather than one giant `it`, so each invariant gets its own named,
// independently-reportable assertion.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { Agent, AgentRun, AgentRunner, RunnerRequest, RunnerResult, RuntimeEventSink } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { AuthorizationEvaluatorImpl } from "./auth/evaluator.js";
import { GrantStore } from "./auth/grant-store.js";
import type { WalnutPolicy } from "./auth/policy.js";
import { AgentVersionStoreImpl } from "./context/agent-version-store.js";
import { CapsuleStoreImpl } from "./context/capsule-store.js";
import { CitationVerifierImpl } from "./context/citation-verifier.js";
import { ClarificationStoreImpl } from "./context/clarification-store.js";
import { ContextBrokerImpl } from "./context/context-broker.js";
import { computeBlastRadius } from "./dependency/blast-radius.js";
import type { ProjectionInput } from "./dependency/projector.js";
import { projectGraph } from "./dependency/projector.js";
import { ReconciliationServiceImpl, ReconciliationStore } from "./dependency/reconciliation.js";
import { WalnutRunStateStore } from "./dependency/run-state.js";
import { EvidenceStore, FileEvidenceRepository } from "./evidence/evidence-store.js";
import { EvidenceWriteServiceImpl } from "./evidence/evidence-write-service.js";
import { EvidenceLedger } from "./evidence/ledger.js";
import { processOutbox } from "./evidence/outbox.js";
import { Redactor } from "./evidence/redactor.js";
import { WalnutRuntimeEventSink } from "./evidence/runtime-event-sink.js";
import { WorkspaceArtifactStore } from "./evidence/workspace-artifacts.js";
import { WorkspaceSourceResolver } from "./evidence/workspace-source.js";
import type { LedgerEvent, RuntimeEventRecord } from "./types.js";

// -- Planted canaries (HC-4) -----------------------------------------------------------------
//
// PLANTED_SECRET is short of the generic 32-char high-entropy sweep threshold in redactor.ts on
// purpose -- that is exactly why it must be passed to the Redactor as a knownSecretValue, and
// exactly why this test is the one that proves that wiring rather than relying on the generic
// heuristic. PAYROLL_CANARY is deliberately NOT registered with the redactor: its absence from
// the consumer's rendered prompt/capsule/chain must be enforced by AUTHORIZATION (INV-1/INV-2),
// not incidentally by redaction.
const PLANTED_SECRET = "E2E_SECRET_ARK_KEY_abc123xyz789";
const PAYROLL_CANARY = "WALNUT_CANARY_DENIED_PAYROLL_93c1e7";

function jsonl(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

// Fake Codex runner: on every call it replays a fixed, realistic JSONL sequence through the
// injected sink (command started -> command failed -> file change -> agent message -> turn
// completed), sequentially and awaited (mirrors createCodexJsonlConsumer's ordering guarantee,
// INV-13/INV-14). Only on the FIRST call does it additionally seed the producer's workspace with
// a source file and a two-entry outbox (doc 06 §8's "Fake Runtime emits" + "Setup" sections).
class FakeRunner implements AgentRunner {
  public readonly requests: RunnerRequest[] = [];
  private callCount = 0;

  constructor(private readonly sink: RuntimeEventSink) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(request);
    const isFirstCall = this.callCount === 0;
    this.callCount += 1;

    const command = `npm test -- ${PLANTED_SECRET}`;
    const lines = [
      jsonl({
        type: "item.started",
        item: { id: "cmd1", type: "command_execution", command, status: "in_progress" },
      }),
      jsonl({
        type: "item.completed",
        item: {
          id: "cmd1",
          type: "command_execution",
          command,
          aggregated_output: `FAIL launch-strategy.test.ts\n${PLANTED_SECRET}\n1 failing`,
          exit_code: 1,
          status: "completed",
        },
      }),
      jsonl({
        type: "item.completed",
        item: { id: "fc1", type: "file_change", status: "completed" },
      }),
      jsonl({
        type: "item.completed",
        item: { id: "msg1", type: "agent_message", text: "Launch analysis written. FINAL" },
      }),
      jsonl({ type: "turn.completed", usage: { input_tokens: 128, output_tokens: 32 } }),
    ];

    for (const line of lines) {
      await this.sink.accept({
        runId: request.runId,
        agentId: request.agentId,
        provider: "local-process",
        rawEvent: line,
        receivedAt: new Date().toISOString(),
      });
    }

    await writeFile(
      path.join(request.workspacePath, "launch-strategy.md"),
      "# Launch Strategy\n\nFINAL\n",
      "utf8",
    );

    if (isFirstCall) {
      const launchContent = "Launch date is September 14.\n";
      const launchQuote = "Launch date is September 14.";
      const launchStart = launchContent.indexOf(launchQuote);
      const launchEnd = launchStart + launchQuote.length;
      await writeFile(path.join(request.workspacePath, "launch-plan.txt"), launchContent, "utf8");

      const payrollQuote = `Payroll ledger reference ${PAYROLL_CANARY} is restricted.`;
      const payrollContent = `Preamble.\n${payrollQuote}\nTrailer.\n`;
      const payrollStart = payrollContent.indexOf(payrollQuote);
      const payrollEnd = payrollStart + payrollQuote.length;
      await writeFile(path.join(request.workspacePath, "payroll-notes.txt"), payrollContent, "utf8");

      await mkdir(path.join(request.workspacePath, ".walnut"), { recursive: true });
      await writeFile(
        path.join(request.workspacePath, ".walnut", "outbox.json"),
        JSON.stringify({
          evidence: [
            {
              claim: "Launch date is September 14.",
              classification: "INTERNAL",
              requiredScopes: ["project:launch:read"],
              source: {
                path: "launch-plan.txt",
                quote: launchQuote,
                charStart: launchStart,
                charEnd: launchEnd,
              },
              derivedFromEvidenceIds: [],
            },
            {
              claim: payrollQuote,
              classification: "CONFIDENTIAL",
              requiredScopes: ["payroll:read"],
              source: {
                path: "payroll-notes.txt",
                quote: payrollQuote,
                charStart: payrollStart,
                charEnd: payrollEnd,
              },
              derivedFromEvidenceIds: [],
            },
          ],
        }),
        "utf8",
      );
    }

    return {
      output: "FINAL",
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 128, outputTokens: 32 },
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

async function readRunChain(dataDir: string, runId: string): Promise<LedgerEvent[]> {
  const raw = await readFile(path.join(dataDir, "walnut", "evidence", `${runId}.ndjson`), "utf8");
  return raw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as LedgerEvent);
}

describe("walnut end-to-end (doc 06 §8)", () => {
  let root: string;
  let dataDir: string;
  let service: AgentService;
  let store: JsonStore;
  let grantStore: GrantStore;
  let versionStore: AgentVersionStoreImpl;
  let capsuleStore: CapsuleStoreImpl;
  let evidenceStore: EvidenceStore;
  let artifactStore: WorkspaceArtifactStore;
  let evaluator: AuthorizationEvaluatorImpl;
  let ledger: EvidenceLedger;
  let evidenceWriteService: EvidenceWriteServiceImpl;
  let runStateStore: WalnutRunStateStore;
  let reconciliationStore: ReconciliationStore;
  let reconciliationService: ReconciliationServiceImpl;
  let runner: FakeRunner;

  let researchAgent: Agent;
  let strategyAgent: Agent;
  let producerRun: AgentRun;
  let consumerRun: AgentRun;
  let replacementRunId: string;
  let launchEvidenceId: string;
  let payrollEvidenceId: string;

  const CONSUMER_PROMPT = "what is the launch date?";

  async function buildProjectionInput(): Promise<ProjectionInput> {
    const snapshot = store.snapshot();
    const runStateRecords = await runStateStore.listAll();
    return {
      agents: snapshot.agents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status })),
      runs: snapshot.runs.map((run) => ({ id: run.id, agentId: run.agentId, status: run.status })),
      agentVersions: await versionStore.listAll(),
      capsules: await capsuleStore.listAll(),
      evidence: await evidenceStore.listAllVersions(),
      decisions: await evaluator.listAll(),
      pointers: await evidenceStore.listAllPointers(),
      runStates: runStateRecords.map((record) => ({
        runId: record.runId,
        state: record.state,
        history: record.history.map((entry) => ({
          state: entry.state,
          triggerEvidenceId: entry.triggerEvidenceId,
          byRunId: entry.byRunId,
        })),
      })),
      reconciliations: await reconciliationStore.listAll(),
      artifacts: await artifactStore.listAll(),
    };
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "walnut-e2e-"));
    dataDir = path.join(root, "data");

    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: dataDir,
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });

    const policy: WalnutPolicy = { revision: 7, denyAgentIds: [], classificationCeilings: {} };

    grantStore = new GrantStore(config.dataDirectory);
    evaluator = new AuthorizationEvaluatorImpl({ grantStore, policy, dataDir: config.dataDirectory });
    capsuleStore = new CapsuleStoreImpl(config.dataDirectory);
    versionStore = new AgentVersionStoreImpl(config.dataDirectory);
    ledger = new EvidenceLedger(config.dataDirectory);
    const redactor = new Redactor({ environment: {}, knownSecretValues: [PLANTED_SECRET] });

    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    evidenceStore = new EvidenceStore(config.dataDirectory);
    artifactStore = new WorkspaceArtifactStore(config.dataDirectory);
    const workspaceSources = new WorkspaceSourceResolver({
      resolveWorkspacePath: (agentId) => workspaces.workspacePath(agentId),
    });
    const evidenceRepository = new FileEvidenceRepository({ store: evidenceStore, sources: workspaceSources });
    const citationVerifier = new CitationVerifierImpl({ evidenceRepository });
    evidenceWriteService = new EvidenceWriteServiceImpl({
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
      clarifications: new ClarificationStoreImpl(config.dataDirectory),
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

    runStateStore = new WalnutRunStateStore(config.dataDirectory);
    reconciliationStore = new ReconciliationStore(config.dataDirectory);

    const sink = new WalnutRuntimeEventSink({ ledger, redactor });
    runner = new FakeRunner(sink);

    store = new JsonStore(path.join(dataDir, "db.json"));
    service = new AgentService(config, store, workspaces, runner, {
      broker,
      versions: versionStore,
      capsules: capsuleStore,
      ledger,
      redactor,
      artifacts: artifactStore,
      processRunOutbox,
    });
    await service.initialize();

    reconciliationService = new ReconciliationServiceImpl({
      runStates: runStateStore,
      capsules: capsuleStore,
      ledger,
      redactor,
      store: reconciliationStore,
      startRun: async (agentId, prompt) => {
        const { run } = await service.sendMessage(agentId, prompt);
        return { runId: run.id };
      },
    });

    researchAgent = await service.createAgent({ name: "Research Agent" });
    strategyAgent = await service.createAgent({ name: "Strategy Agent" });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("1. producer run: both outbox evidence records are ACTIVE with VERIFIED citations (INV-4/INV-5)", async () => {
    const { run } = await service.sendMessage(researchAgent.id, "publish the launch date and payroll note");
    producerRun = run;
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const allVersions = await evidenceStore.listAllVersions();
    const producedHere = allVersions.filter((evidence) => evidence.producerRunId === producerRun.id);
    expect(producedHere).toHaveLength(2);

    const launch = producedHere.find((evidence) => evidence.claim === "Launch date is September 14.");
    const payroll = producedHere.find((evidence) => evidence.claim.includes(PAYROLL_CANARY));
    expect(launch).toBeDefined();
    expect(payroll).toBeDefined();
    launchEvidenceId = launch!.evidenceId;
    payrollEvidenceId = payroll!.evidenceId;

    for (const evidence of [launch!, payroll!]) {
      expect(evidence.status).toBe("ACTIVE");
      expect(evidence.citationId).not.toBeNull();
      const citation = await evidenceStore.getCitation(evidence.citationId as string);
      expect(citation?.verification).toBe("VERIFIED");
    }
  });

  it("2. grants: Strategy Agent gets project:launch:* consume, and nothing for payroll (INV-1 setup)", async () => {
    await grantStore.issue({
      agentId: strategyAgent.id,
      principalId: null,
      resourcePattern: "project:launch:*",
      action: "consume",
      validFrom: new Date(0).toISOString(),
      validTo: null,
      issuedBy: "test",
      supersedesGrantId: null,
    });

    const grants = await grantStore.listFor(strategyAgent.id, null);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.resourcePattern).toBe("project:launch:*");
  });

  it("3. consumer run: capsule contains exactly the launch evidence ALLOW, payroll DENY with a recorded decision id (INV-1)", async () => {
    const { run } = await service.sendMessage(strategyAgent.id, CONSUMER_PROMPT);
    consumerRun = run;
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const capsule = await service.getCapsuleForRun(consumerRun.id);
    expect(capsule).not.toBeNull();
    expect(capsule!.evidence).toHaveLength(1);
    expect(capsule!.evidence[0]?.evidenceId).toBe(launchEvidenceId);
    expect(capsule!.deniedEvidenceDecisionIds).toHaveLength(1);

    const decisions = await evaluator.listAll();
    const deniedDecision = decisions.find(
      (decision) => decision.decisionId === capsule!.deniedEvidenceDecisionIds[0],
    );
    expect(deniedDecision?.evidenceId).toBe(payrollEvidenceId);
    expect(deniedDecision?.result).toBe("DENY");
    expect(deniedDecision?.reasonCode).toBe("AGENT_SCOPE_MISSING");

    const allowedDecision = decisions.find(
      (decision) => decision.decisionId === capsule!.evidence[0]?.authorizationDecisionId,
    );
    expect(allowedDecision?.result).toBe("ALLOW");
  });

  it("3a. the rendered prompt captured by the runner carries the launch claim and never the payroll canary (INV-2a)", () => {
    const consumerRequest = runner.requests.at(-1);
    expect(consumerRequest?.runId).toBe(consumerRun.id);
    expect(consumerRequest?.prompt).toContain("Launch date is September 14.");
    expect(consumerRequest?.prompt.includes(PAYROLL_CANARY)).toBe(false);
  });

  it("3b. the persisted capsule file's raw bytes never contain the payroll canary (INV-2b)", async () => {
    const capsule = await service.getCapsuleForRun(consumerRun.id);
    const raw = await readFile(
      path.join(dataDir, "walnut", "capsules", `${capsule!.capsuleId}.json`),
      "utf8",
    );
    expect(raw.includes(PAYROLL_CANARY)).toBe(false);
  });

  it("3c. the consumer run's raw ledger chain bytes lack the payroll canary (INV-2c) and the planted secret (INV-16)", async () => {
    const raw = await readFile(path.join(dataDir, "walnut", "evidence", `${consumerRun.id}.ndjson`), "utf8");
    expect(raw.includes(PAYROLL_CANARY)).toBe(false);
    expect(raw.includes(PLANTED_SECRET)).toBe(false);
  });

  it("4. the consumer run's runtime.event records appear in the exact send order (INV-13/INV-14); failed command and file_change are visible", async () => {
    const chain = await readRunChain(dataDir, consumerRun.id);
    const runtimeEvents = chain
      .filter((event) => event.kind === "runtime.event")
      .map((event) => event.safePayload as RuntimeEventRecord);

    expect(runtimeEvents.map((event) => [event.kind, event.runtimeItemId, event.status])).toEqual([
      ["runtime.command", "cmd1", "started"],
      ["runtime.command", "cmd1", "failed"],
      ["runtime.file_change", "fc1", "completed"],
      ["runtime.message", "msg1", "completed"],
      ["runtime.turn", null, "completed"],
    ]);
  });

  it("5. both runs' ledger chains and the governance chain verify (INV-15)", async () => {
    expect(await ledger.verifyChain(producerRun.id)).toMatchObject({ ok: true });
    expect(await ledger.verifyChain(consumerRun.id)).toMatchObject({ ok: true });
    expect(await ledger.verifyChain("_governance")).toMatchObject({ ok: true });
  });

  it("6. the dependency projection includes source/evidence/capsule/run nodes and is deterministic (INV-11)", async () => {
    const input = await buildProjectionInput();
    const graph1 = projectGraph(input);
    const graph2 = projectGraph(input);
    expect(graph2).toEqual(graph1);

    const nodeIds = new Set(graph1.nodes.map((node) => node.id));
    expect(nodeIds.has(researchAgent.id)).toBe(true);
    expect(nodeIds.has(strategyAgent.id)).toBe(true);
    expect(nodeIds.has(producerRun.id)).toBe(true);
    expect(nodeIds.has(consumerRun.id)).toBe(true);
    expect(nodeIds.has(launchEvidenceId)).toBe(true);
    expect(nodeIds.has(payrollEvidenceId)).toBe(true);

    expect(graph1.nodes.filter((node) => node.type === "source").length).toBeGreaterThanOrEqual(2);
    expect(graph1.nodes.filter((node) => node.type === "context_capsule").length).toBeGreaterThanOrEqual(2);
  });

  it("7. compromising the launch evidence mints a COMPROMISED v2, keeps v1 queryable (INV-9), and its blast radius contains the consumer run exactly once (INV-12)", async () => {
    const originalVersion = await evidenceStore.getEvidence(launchEvidenceId, 1);
    expect(originalVersion?.status).toBe("ACTIVE");

    const compromised = await evidenceWriteService.compromise(launchEvidenceId, "source integrity incident");
    expect(compromised.status).toBe("COMPROMISED");
    expect(compromised.version).toBe(2);

    const stillQueryableV1 = await evidenceStore.getEvidence(launchEvidenceId, 1);
    expect(stillQueryableV1?.status).toBe("ACTIVE");
    expect(stillQueryableV1?.txClosedAt).not.toBeNull();

    const input = await buildProjectionInput();
    const graph = projectGraph(input);
    const radius = computeBlastRadius(
      graph,
      { kind: "evidence", id: launchEvidenceId },
      new Date().toISOString(),
    );
    expect(radius.runIds.filter((runId) => runId === consumerRun.id)).toHaveLength(1);

    await runStateStore.markTainted(consumerRun.id, launchEvidenceId, "blast radius from compromised evidence");
    expect(await runStateStore.get(consumerRun.id)).toBe("TAINTED");
  });

  it("8. reconciling the tainted run creates a completed replacement, marks the old run RECOVERED (INV-10), and never mutates its JsonStore record", async () => {
    const beforeRecord = structuredClone(store.snapshot().runs.find((run) => run.id === consumerRun.id));
    expect(beforeRecord).toBeDefined();

    const record = await reconciliationService.reconcile(consumerRun.id, CONSUMER_PROMPT, strategyAgent.id);
    expect(record.result).toBe("COMPLETED");
    replacementRunId = record.replacementRunId;

    await expect.poll(() => service.getRun(replacementRunId).status).toBe("completed");

    expect(await runStateStore.get(consumerRun.id)).toBe("RECOVERED");
    const history = await runStateStore.history(consumerRun.id);
    expect(history.at(-1)).toMatchObject({ state: "RECOVERED", byRunId: replacementRunId });

    const afterRecord = store.snapshot().runs.find((run) => run.id === consumerRun.id);
    expect(afterRecord).toEqual(beforeRecord);

    const input = await buildProjectionInput();
    const graph = projectGraph(input);
    expect(
      graph.edges.some(
        (edge) => edge.type === "RECOVERED_BY" && edge.from === consumerRun.id && edge.to === replacementRunId,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) => edge.type === "TAINTS" && edge.from === launchEvidenceId && edge.to === consumerRun.id,
      ),
    ).toBe(true);
  });

  it("9. the replacement run's capsule honestly excludes the compromised evidence via DENY EVIDENCE_COMPROMISED (INV-8)", async () => {
    const capsule = await service.getCapsuleForRun(replacementRunId);
    expect(capsule).not.toBeNull();
    expect(capsule!.evidence.some((ref) => ref.evidenceId === launchEvidenceId)).toBe(false);

    const decisions = await evaluator.listAll();
    const deniedDecisionIds = new Set(capsule!.deniedEvidenceDecisionIds);
    const compromisedDecision = decisions.find(
      (decision) => deniedDecisionIds.has(decision.decisionId) && decision.evidenceId === launchEvidenceId,
    );
    expect(compromisedDecision?.result).toBe("DENY");
    expect(compromisedDecision?.reasonCode).toBe("EVIDENCE_COMPROMISED");
  });
});
