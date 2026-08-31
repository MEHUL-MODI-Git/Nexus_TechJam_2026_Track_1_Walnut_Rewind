import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { AuthorizationEvaluatorImpl } from "./walnut/auth/evaluator.js";
import { GrantStore } from "./walnut/auth/grant-store.js";
import { defaultPolicy } from "./walnut/auth/policy.js";
import { AgentVersionStoreImpl } from "./walnut/context/agent-version-store.js";
import { CapsuleStoreImpl } from "./walnut/context/capsule-store.js";
import { CitationVerifierImpl } from "./walnut/context/citation-verifier.js";
import { ClarificationStoreImpl } from "./walnut/context/clarification-store.js";
import { ContextBrokerImpl } from "./walnut/context/context-broker.js";
import { ShareServiceImpl } from "./walnut/context/share-service.js";
import { ReconciliationServiceImpl, ReconciliationStore } from "./walnut/dependency/reconciliation.js";
import { WalnutRunStateStore } from "./walnut/dependency/run-state.js";
import { EvidenceStore, FileEvidenceRepository } from "./walnut/evidence/evidence-store.js";
import { EvidenceWriteServiceImpl } from "./walnut/evidence/evidence-write-service.js";
import { EvidenceLedger } from "./walnut/evidence/ledger.js";
import { processOutbox } from "./walnut/evidence/outbox.js";
import { Redactor } from "./walnut/evidence/redactor.js";
import { WalnutRuntimeEventSink } from "./walnut/evidence/runtime-event-sink.js";
import { WorkspaceArtifactStore } from "./walnut/evidence/workspace-artifacts.js";
import { WorkspaceSourceResolver } from "./walnut/evidence/workspace-source.js";
import type { WalnutRouteDeps } from "./walnut/routes/walnut-routes.js";
import type { RunAttestation } from "./walnut/types.js";
import { WorkspaceManager } from "./workspace.js";

const execFileAsync = promisify(execFile);

const config = loadConfig();
await writeCodexConfig(config);

// -- Walnut composition root -------------------------------------------------------------
// P2-E1/P2-E2/P2-E3: the real evidence plane (EvidenceStore, WorkspaceSourceResolver,
// FileEvidenceRepository, EvidenceWriteServiceImpl, outbox ingestion) replaces the Phase-1
// empty-repository stand-in (removed).

const redactor = new Redactor({
  environment: process.env,
  knownSecretValues: [config.arkApiKey, config.arkModel, config.authToken].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  ),
});
const ledger = new EvidenceLedger(config.dataDirectory);
const runtimeSink = new WalnutRuntimeEventSink({ ledger, redactor });

const workspaces = new WorkspaceManager(config.workspaceRoot);

const grantStore = new GrantStore(config.dataDirectory);
const evaluator = new AuthorizationEvaluatorImpl({
  grantStore,
  policy: defaultPolicy,
  dataDir: config.dataDirectory,
});
const agentVersions = new AgentVersionStoreImpl(config.dataDirectory);
const capsuleStore = new CapsuleStoreImpl(config.dataDirectory);

const evidenceStore = new EvidenceStore(config.dataDirectory);
const artifactStore = new WorkspaceArtifactStore(config.dataDirectory);
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

const clarificationStore = new ClarificationStoreImpl(config.dataDirectory);
const runStates = new WalnutRunStateStore(config.dataDirectory);
const reconciliationStore = new ReconciliationStore(config.dataDirectory);

const contextBroker = new ContextBrokerImpl({
  evidenceRepository,
  evaluator,
  capsuleStore,
  policy: defaultPolicy,
  getGovernanceHead: async () => (await ledger.verifyChain("_governance")).eventCount,
  clarifications: clarificationStore,
});

// P2-X1: the Walnut REST surface consumes ShareServiceImpl (P2-C3) directly, ahead of any other
// composition-root wiring for it — this is the first caller.
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
    writeService: evidenceWriteService,
  });
  return {
    acceptedCount: result.accepted.length,
    rejectedCount: result.rejected.length,
    rejections: result.rejected,
  };
};

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const runner = createRunner(config, runtimeSink);
const service = new AgentService(config, store, workspaces, runner, {
  broker: contextBroker,
  versions: agentVersions,
  capsules: capsuleStore,
  ledger,
  redactor,
  artifacts: artifactStore,
  processRunOutbox,
});
await service.initialize();

// P3-D4: the reconciliation service starts its replacement Run through the same
// AgentService.sendMessage path every other Run takes -- constructed AFTER `service` on purpose
// (circular dependency: reconcile needs `service`, `service` does not need reconcile).
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

// P3-E1: RunAttestation's routeReceipt. codexVersion is resolved once (execFile is not free) and
// cached for the process lifetime; a version-check failure degrades to the honest "unavailable"
// string rather than failing the attestation route.
let cachedCodexVersion: string | null = null;
async function resolveCodexVersion(): Promise<string> {
  if (cachedCodexVersion !== null) return cachedCodexVersion;
  try {
    const { stdout } = await execFileAsync(config.codexBin, ["--version"]);
    const firstLine = stdout.split("\n")[0]?.trim() ?? "";
    cachedCodexVersion = firstLine.length > 0 ? firstLine : "unavailable";
  } catch {
    cachedCodexVersion = "unavailable";
  }
  return cachedCodexVersion;
}

const routeReceipt = async (): Promise<RunAttestation["routeReceipt"]> => ({
  // ModelArk endpoint identifiers are configured secrets under HC-4. The receipt confirms the
  // route without disclosing that value to the browser or demo output.
  arkModel: null,
  codexVersion: await resolveCodexVersion(),
  runtimeProvider: config.runtimeProvider,
  runtimeImage: config.runtimeProvider === "container" ? config.containerRuntimeImage : null,
  sandboxMode: config.codexSandboxMode,
});

const walnutRouteDeps: WalnutRouteDeps = {
  store,
  evidenceStore,
  artifactStore,
  capsuleStore,
  agentVersions,
  grantStore,
  ledger,
  writeService: evidenceWriteService,
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

const app = await createApp(config, service, walnutRouteDeps);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
