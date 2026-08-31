import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  RunnerResult,
  UpdateAgentInput,
} from "./types.js";
import type {
  AgentVersionResolver,
  CapsuleStore,
  ContextBroker,
} from "./walnut/ports.js";
import type { EvidenceLedger } from "./walnut/evidence/ledger.js";
import type { Redactor } from "./walnut/evidence/redactor.js";
import type { WorkspaceArtifactStore } from "./walnut/evidence/workspace-artifacts.js";
import { sha256Prefixed } from "./walnut/shared/hash.js";
import {
  appendRedactedEvent,
  notAppliedReceipt,
  receiptFrom,
} from "./walnut/shared/ledger-events.js";
import type { ContextCapsule } from "./walnut/types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export interface WalnutServiceDeps {
  broker: ContextBroker;
  versions: AgentVersionResolver;
  capsules: CapsuleStore;
  ledger: EvidenceLedger;
  redactor: Redactor;
  artifacts: WorkspaceArtifactStore | null;
  // P2-E2 wiring: reads and ingests a completed Run's workspace outbox (doc 03 §14). null in any
  // composition that has not wired evidence ingestion yet (there is none left in production, but
  // tests are free to pass null when a case does not need it).
  processRunOutbox:
    | ((input: { workspacePath: string; agentId: string; runId: string }) => Promise<{
        acceptedCount: number;
        rejectedCount: number;
        rejections: Array<{ index: number; reason: string; detail: string }>;
      }>)
    | null;
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly walnut: WalnutServiceDeps,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getCapsuleForRun(runId: string): Promise<ContextCapsule | null> {
    return this.walnut.capsules.getByRunId(runId);
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      // Never return the configured endpoint ID to a browser client (HC-4).
      arkModel: null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }

      // spec 003 §A5 / A2 step 1: resolve (and, if the agent's config changed, mint) the
      // AgentVersion this Run pins, before authorization or the runner ever see the Run.
      const agentVersion = await this.walnut.versions.resolve(agentAtStart);

      await this.walnut.ledger.append({
        runId: run.id,
        agentId: agentAtStart.id,
        capsuleId: null,
        kind: "run.requested",
        actor: "middleware",
        occurredAt: now(),
        safePayload: {
          runId: run.id,
          agentId: agentAtStart.id,
          agentVersionId: agentVersion.versionId,
          // Hash-only: the prompt may carry a user secret, so it is never itself persisted
          // (HC-4/HC-8) — only its hash is chained.
          promptHash: sha256Prefixed(run.prompt),
        },
        redactionReceipt: notAppliedReceipt(),
        supersedesEventId: null,
      });

      const buildResult = await this.walnut.broker.build({
        run,
        agent: agentAtStart,
        agentVersionId: agentVersion.versionId,
        onBehalfOfPrincipalId: null,
        userPrompt: run.prompt,
      });

      if (buildResult.kind === "denied") {
        await this.walnut.ledger.append({
          runId: run.id,
          agentId: agentAtStart.id,
          capsuleId: null,
          kind: "run.failed",
          actor: "middleware",
          occurredAt: now(),
          safePayload: { reasonCode: buildResult.reasonCode, message: buildResult.message },
          redactionReceipt: notAppliedReceipt(),
          supersedesEventId: null,
        });
        const completedAt = now();
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          const agent = database.agents.find((item) => item.id === agentAtStart.id);
          if (storedRun) {
            storedRun.status = "failed";
            storedRun.error = buildResult.message;
            storedRun.completedAt = completedAt;
          }
          // A policy denial is a run-level refusal, not an agent malfunction — the agent goes
          // back to "ready", never "error" (spec 003 §A2).
          if (agent && agent.status !== "stopped") {
            agent.status = "ready";
            agent.lastError = null;
            agent.updatedAt = completedAt;
          }
        });
        return;
      }

      if (buildResult.kind === "clarification_required") {
        // Complete the Run as failed with the typed question text in run.error (spec 003 §A1).
        // Since P3-C1 the broker has already persisted the full typed ClarificationRequest
        // before returning this union member — it is queryable at /api/walnut/clarifications;
        // this path adds no ledger event of its own.
        const completedAt = now();
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          const agent = database.agents.find((item) => item.id === agentAtStart.id);
          if (storedRun) {
            storedRun.status = "failed";
            storedRun.error = buildResult.request.question;
            storedRun.completedAt = completedAt;
          }
          if (agent && agent.status !== "stopped") {
            agent.status = "ready";
            agent.lastError = null;
            agent.updatedAt = completedAt;
          }
        });
        return;
      }

      // kind === "ok": the capsule is already finalized, hashed and persisted by the broker.
      const capsule = buildResult.capsule;
      await this.walnut.ledger.append({
        runId: run.id,
        agentId: agentAtStart.id,
        capsuleId: capsule.capsuleId,
        kind: "capsule.finalized",
        actor: "middleware",
        occurredAt: now(),
        safePayload: capsule,
        redactionReceipt: notAppliedReceipt(),
        supersedesEventId: null,
      });

      const renderedPrompt = await this.walnut.broker.renderPrompt(run.prompt, capsule);

      if (this.walnut.artifacts !== null) {
        await this.walnut.artifacts.captureBefore({
          runId: run.id,
          agentId: agentAtStart.id,
          workspacePath: agentAtStart.workspacePath,
        });
      }

      let result: RunnerResult;
      try {
        result = await this.runner.run({
          agentId: agentAtStart.id,
          workspacePath: agentAtStart.workspacePath,
          prompt: renderedPrompt,
          threadId: agentAtStart.codexThreadId,
          runId: run.id,
          principalId: null,
          agentVersionId: agentVersion.versionId,
          contextCapsuleId: capsule.capsuleId,
        });
      } catch (runnerError) {
        // Preserve the runner's original failure even if best-effort diff capture also fails.
        await this.captureArtifactDiff(agentAtStart, run, capsule).catch(() => undefined);
        throw runnerError;
      }
      await this.captureArtifactDiff(agentAtStart, run, capsule);

      // P2-E2: ingest the Run's workspace outbox (doc 03 §14) BEFORE the run is persisted as
      // completed (ordering fix, relay 2026-08-27): a consumer that polls run.status ===
      // "completed" must be able to rely on the run's published evidence already being visible —
      // the SECURITY-DEPS lockfile bump shifted timings enough to expose the old
      // completed-then-ingest race in the e2e. Chain order is unchanged (evidence.created /
      // outbox_processed still precede run.completed); only the store-status flip moves last.
      // Outbox failures must never fail an otherwise-successful Run.
      if (this.walnut.processRunOutbox) {
        try {
          const outboxResult = await this.walnut.processRunOutbox({
            workspacePath: agentAtStart.workspacePath,
            agentId: agentAtStart.id,
            runId: run.id,
          });
          for (const rejection of outboxResult.rejections) {
            await appendRedactedEvent(
              { ledger: this.walnut.ledger, redactor: this.walnut.redactor },
              {
                runId: run.id,
                agentId: agentAtStart.id,
                capsuleId: capsule.capsuleId,
                kind: "evidence.proposal_rejected",
                actor: "middleware",
                occurredAt: now(),
                payload: {
                  proposalIndex: rejection.index,
                  reason: rejection.reason,
                  detail: rejection.detail,
                },
                supersedesEventId: null,
              },
            );
          }
          if (outboxResult.acceptedCount + outboxResult.rejectedCount > 0) {
            await this.walnut.ledger.append({
              runId: run.id,
              agentId: agentAtStart.id,
              capsuleId: capsule.capsuleId,
              kind: "evidence.outbox_processed",
              actor: "middleware",
              occurredAt: now(),
              safePayload: {
                acceptedCount: outboxResult.acceptedCount,
                rejectedCount: outboxResult.rejectedCount,
              },
              redactionReceipt: notAppliedReceipt(),
              supersedesEventId: null,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const redactedMessage = this.walnut.redactor.redact(message);
          await this.walnut.ledger.append({
            runId: run.id,
            agentId: agentAtStart.id,
            capsuleId: capsule.capsuleId,
            kind: "evidence.outbox_failed",
            actor: "middleware",
            occurredAt: now(),
            safePayload: { message: redactedMessage.safeValue },
            redactionReceipt: receiptFrom(redactedMessage),
            supersedesEventId: null,
          });
        }
      }

      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });

      await this.walnut.ledger.append({
        runId: run.id,
        agentId: agentAtStart.id,
        capsuleId: capsule.capsuleId,
        kind: "run.completed",
        actor: "middleware",
        occurredAt: completedAt,
        // Never the output text itself — only its length (HC-4/HC-8).
        safePayload: { outputLength: result.output.length, threadId: result.threadId },
        redactionReceipt: notAppliedReceipt(),
        supersedesEventId: null,
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      // Runner failures can echo commands, paths, credentials, or provider details. Persist and
      // serve only the same redacted value that enters the audit chain.
      const redactedMessage = this.walnut.redactor.redact(message);
      const safeMessage =
        typeof redactedMessage.safeValue === "string"
          ? redactedMessage.safeValue
          : "[REDACTED]";
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = safeMessage;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : safeMessage;
          agent.updatedAt = completedAt;
        }
      });

      // The error message may echo attacker- or environment-controlled text (a failed shell
      // command, a rejected path); redact it through the same Redactor as runtime evidence
      // before it is chained (HC-4).
      await this.walnut.ledger.append({
        runId: run.id,
        agentId: agentAtStart.id,
        capsuleId: null,
        kind: cancelled ? "run.cancelled" : "run.failed",
        actor: "middleware",
        occurredAt: completedAt,
        safePayload: { message: safeMessage },
        redactionReceipt: receiptFrom(redactedMessage),
        supersedesEventId: null,
      });
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async captureArtifactDiff(
    agent: Agent,
    run: AgentRun,
    capsule: ContextCapsule,
  ): Promise<void> {
    if (this.walnut.artifacts === null) return;
    const artifacts = await this.walnut.artifacts.captureAfter({
      runId: run.id,
      agentId: agent.id,
      workspacePath: agent.workspacePath,
      derivedFromEvidenceIds: capsule.evidence.map((item) => item.evidenceId),
    });
    if (artifacts.length === 0) return;

    await appendRedactedEvent(
      { ledger: this.walnut.ledger, redactor: this.walnut.redactor },
      {
        runId: run.id,
        agentId: agent.id,
        capsuleId: capsule.capsuleId,
        kind: "artifact.diff",
        actor: "middleware",
        occurredAt: now(),
        payload: { artifacts },
        supersedesEventId: null,
      },
    );
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
