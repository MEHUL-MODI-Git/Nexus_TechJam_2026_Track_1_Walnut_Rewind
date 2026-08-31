// Walnut REST surface (P2-X1 + P3-D2/D4/D6/E1, docs/walnut/04-DATA-MODEL-API-CONTRACTS.md §19).
//
// Phase-2 routes: run overview, run evidence (+verify), run dependencies, evidence detail,
// revoke/compromise/supersede, grants list/issue/revoke, share.
// Phase-3 additions: evidence blast-radius, revoke/compromise now tag downstream Runs
// STALE/TAINTED via the blast radius, run reconcile, run history (known-at), run attestation,
// open clarifications, and the verify-tamper demo affordance. Export remains deliberately ABSENT
// -- no stub, no placeholder route. An absent route is honest; a stub pretends.
//
// All routes below register under the existing `/api/*` bearer-auth hook in app.ts — nothing
// here re-implements authentication.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../../errors.js";
import type { AgentService } from "../../agent-service.js";
import type { JsonStore } from "../../store.js";
import type { AuthorizationEvaluatorImpl } from "../auth/evaluator.js";
import type { GrantStore } from "../auth/grant-store.js";
import type { AgentVersionStoreImpl } from "../context/agent-version-store.js";
import type { CapsuleStoreImpl } from "../context/capsule-store.js";
import type { ClarificationStoreImpl } from "../context/clarification-store.js";
import type { ShareService } from "../context/share-service.js";
import { evidenceKnownAt } from "../context/temporal-resolver.js";
import { computeBlastRadius } from "../dependency/blast-radius.js";
import { projectGraph, type DependencyGraph, type ProjectionInput } from "../dependency/projector.js";
import type { ReconciliationRecordStore, ReconciliationService } from "../dependency/reconciliation.js";
import type { WalnutRunStateStore } from "../dependency/run-state.js";
import { canonicalJson } from "../evidence/canonical-json.js";
import type { EvidenceStore } from "../evidence/evidence-store.js";
import type { EvidenceWriteService } from "../evidence/evidence-write-service.js";
import type { EvidenceLedger } from "../evidence/ledger.js";
import type { Redactor } from "../evidence/redactor.js";
import type { WorkspaceArtifactStore } from "../evidence/workspace-artifacts.js";
import { appendRedactedEvent } from "../shared/ledger-events.js";
import type {
  BlastRadius,
  ContextCapsule,
  Evidence,
  RunAttestation,
  RuntimeEventRecord,
} from "../types.js";

export interface WalnutRouteDeps {
  store: JsonStore;
  evidenceStore: EvidenceStore;
  artifactStore: WorkspaceArtifactStore;
  capsuleStore: CapsuleStoreImpl;
  agentVersions: AgentVersionStoreImpl;
  grantStore: GrantStore;
  ledger: EvidenceLedger;
  writeService: EvidenceWriteService;
  shareService: ShareService;
  redactor: Redactor;
  // Added beyond the deps sketched for this task (route 4 needs decisions system-wide; the
  // evaluator is the only honest source, since it owns decisions.json) — see report deviations.
  evaluator: AuthorizationEvaluatorImpl;
  // P3-D2/D3/D4: the projector's ProjectionInput now requires run states + reconciliations.
  runStates: WalnutRunStateStore;
  reconciliations: ReconciliationRecordStore;
  // P3-D4/D6/E1: the reconcile route, the clarification-visibility route, and the attestation
  // route's routeReceipt field.
  reconcileService: ReconciliationService;
  clarifications: ClarificationStoreImpl;
  routeReceipt: () => Promise<RunAttestation["routeReceipt"]>;
  // P3-E1: the demo tamper-detection affordance needs the raw evidence-chain directory to write
  // its corrupted COPY into (it never touches a real chain file, HC-7) — the same
  // `<dataDir>/walnut/evidence/` convention EvidenceLedger itself uses internally.
  dataDir: string;
}

const runIdParams = z.object({ id: z.string().uuid() });
const agentIdParams = z.object({ id: z.string().uuid() });
const evidenceIdParams = z.object({ id: z.string().regex(/^ev_[A-Za-z0-9-]+$/) });
const grantParams = z.object({
  id: z.string().uuid(),
  grantId: z.string().regex(/^grant_[A-Za-z0-9-]+$/),
});
const shareParams = z.object({
  id: z.string().regex(/^ev_[A-Za-z0-9-]+$/),
  targetAgentId: z.string().uuid(),
});

const isoInstant = z.string().datetime({ offset: true });
const principalId = z.string().regex(/^(?:user|agent):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const evidenceQuery = z.object({ knownAt: isoInstant.optional() });
const historyQuery = z.object({ knownAt: isoInstant.optional() });
const verifyTamperBody = z.object({ corruptSequence: z.number().int().positive().optional() });

const reasonBody = z.object({ reason: z.string().trim().min(1).max(500) });
const supersedeBody = z.object({ replacementEvidenceId: z.string().min(1) });

const grantActionEnum = z.enum(["read", "consume", "share", "write", "external_write"]);
const issueGrantBody = z.object({
  resourcePattern: z.string().min(1),
  action: grantActionEnum,
  validTo: isoInstant.nullable().default(null),
  principalId: principalId.nullable().default(null),
});
const shareBody = z.object({
  fromAgentId: z.string().uuid(),
  principalId: principalId.nullable().default(null),
});

function isUnknownEvidenceError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Unknown evidence");
}

// Shared ProjectionInput assembly (doc 04 §13/§23) — the SAME live-store snapshot used by the
// dependencies route (route 4) and the new blast-radius route so the two never diverge on what
// "the graph" means. projectGraph itself stays pure; this is the composition-layer assembly.
async function buildLiveGraph(deps: WalnutRouteDeps): Promise<DependencyGraph> {
  const snapshot = deps.store.snapshot();
  const [
    agentVersions,
    capsules,
    evidence,
    decisions,
    pointers,
    runStateRecords,
    reconciliations,
    artifacts,
  ] = await Promise.all([
    deps.agentVersions.listAll(),
    deps.capsuleStore.listAll(),
    deps.evidenceStore.listAllVersions(),
    deps.evaluator.listAll(),
    deps.evidenceStore.listAllPointers(),
    deps.runStates.listAll(),
    deps.reconciliations.listAll(),
    deps.artifactStore.listAll(),
  ]);

  const input: ProjectionInput = {
    agents: snapshot.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status,
    })),
    runs: snapshot.runs.map((run) => ({ id: run.id, agentId: run.agentId, status: run.status })),
    agentVersions,
    capsules,
    evidence,
    decisions,
    pointers,
    runStates: runStateRecords.map((record) => ({
      runId: record.runId,
      state: record.state,
      history: record.history.map((entry) => ({
        state: entry.state,
        triggerEvidenceId: entry.triggerEvidenceId,
        byRunId: entry.byRunId,
      })),
    })),
    reconciliations,
    artifacts,
  };

  return projectGraph(input);
}

// doc 04 §23 walkthrough: compromise/revoke E17 -> traverse Cap24 -> mark Run91 TAINTED/STALE.
// Computes the blast radius from the trigger evidence over the CURRENT live graph (called AFTER
// the write-service transition, so the traversal starts from the same evidenceId the transition
// just moved -- the graph's evidence node for that id is unaffected by which version is current).
async function tagBlastRadius(
  deps: WalnutRouteDeps,
  evidenceId: string,
  kind: "revoked" | "compromised",
): Promise<BlastRadius> {
  const graph = await buildLiveGraph(deps);
  const blastRadius = computeBlastRadius(
    graph,
    { kind: "evidence", id: evidenceId },
    new Date().toISOString(),
  );
  const reason = `evidence ${evidenceId} ${kind}`;
  for (const runId of blastRadius.runIds) {
    if (kind === "compromised") {
      await deps.runStates.markTainted(runId, evidenceId, reason);
    } else {
      await deps.runStates.markStale(runId, evidenceId, reason);
    }
  }
  return blastRadius;
}

function isRuntimeEventRecord(value: unknown): value is RuntimeEventRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "status" in value &&
    typeof (value as { kind: unknown }).kind === "string" &&
    typeof (value as { status: unknown }).status === "string"
  );
}

async function buildAttestation(
  deps: WalnutRouteDeps,
  runId: string,
  capsule: ContextCapsule,
): Promise<RunAttestation> {
  const [chainEvents, head, chainVerification, walnutRunState, rawRouteReceipt, artifacts] = await Promise.all([
    deps.ledger.listEvents(runId),
    deps.ledger.head(runId),
    deps.ledger.verifyChain(runId),
    deps.runStates.get(runId),
    deps.routeReceipt(),
    deps.artifactStore.listByRun(runId),
  ]);
  const runtimeEvents = chainEvents.filter((event) => event.kind === "runtime.event");
  const commandCount = runtimeEvents.filter(
    (event) => isRuntimeEventRecord(event.safePayload) && event.safePayload.kind === "runtime.command",
  ).length;
  const failedRuntimeSteps = runtimeEvents.filter(
    (event) => isRuntimeEventRecord(event.safePayload) && event.safePayload.status === "failed",
  ).length;
  const runFailedEvents = chainEvents.filter((event) => event.kind === "run.failed").length;
  const redactionCount = chainEvents.reduce(
    (sum, event) => sum + event.redactionReceipt.replacementCount,
    0,
  );

  return {
    runId,
    capsuleId: capsule.capsuleId,
    capsuleHash: capsule.capsuleHash,
    chainHead: head?.eventHash ?? "0".repeat(64),
    chainVerified: chainVerification.ok,
    eventCount: chainVerification.eventCount,
    runtimeEventCount: runtimeEvents.length,
    evidenceConsumed: capsule.evidence.length,
    evidenceDenied: capsule.deniedEvidenceDecisionIds.length,
    commandCount,
    failedStepCount: failedRuntimeSteps + runFailedEvents,
    changedArtifacts: artifacts.map((artifact) => artifact.relativePath),
    redactionCount,
    walnutRunState,
    // Defense in depth: endpoint identifiers never cross the HTTP boundary even if an alternate
    // composition accidentally supplies one in its receipt callback.
    routeReceipt: { ...rawRouteReceipt, arkModel: null },
    generatedAt: new Date().toISOString(),
  };
}

// P3-E1 demo tamper affordance: mutate exactly one leaf value inside `payload` (recursing into
// the first object key / first array element so nested payloads are still touched at their first
// leaf) so the re-serialized record content differs from what its stored `eventHash` was computed
// over -- the minimal, honest way to make `verifyChain` recompute a mismatching hash without
// reconstructing the whole tamper machinery. Every branch changes SOMETHING, so this never
// silently no-ops into an unchanged payload.
function tamperOneCharacter(payload: unknown): unknown {
  if (typeof payload === "string") {
    return payload.length > 0 ? flipFirstCharacter(payload) : "x";
  }
  if (typeof payload === "number") {
    return payload + 1;
  }
  if (typeof payload === "boolean") {
    return !payload;
  }
  if (Array.isArray(payload)) {
    return payload.length > 0
      ? [tamperOneCharacter(payload[0]), ...payload.slice(1)]
      : ["tampered-for-demo"];
  }
  if (payload !== null && typeof payload === "object") {
    const entries = Object.entries(payload as Record<string, unknown>);
    if (entries.length === 0) {
      return { tamperedForDemo: true };
    }
    const [key, value] = entries[0] as [string, unknown];
    return { ...(payload as Record<string, unknown>), [key]: tamperOneCharacter(value) };
  }
  // null (or any other non-JSON leaf that reached here): there is no character to flip, so the
  // content change is structural instead -- still guarantees the recomputed hash differs.
  return { tamperedForDemo: true };
}

function flipFirstCharacter(value: string): string {
  const code = value.charCodeAt(0);
  const flipped = code === 0x7a ? 0x61 : code + 1;
  return String.fromCharCode(flipped) + value.slice(1);
}

export function registerWalnutRoutes(
  app: FastifyInstance,
  service: AgentService,
  deps: WalnutRouteDeps,
): void {
  // -- 1. Run overview ---------------------------------------------------------------------

  app.get("/api/runs/:id/walnut", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const run = service.getRun(id);
    const capsule = await service.getCapsuleForRun(id);
    const [chain, walnutRunState, graph, currentEvidence, reconciliations, attestation] =
      await Promise.all([
        deps.ledger.verifyChain(id),
        deps.runStates.get(id),
        buildLiveGraph(deps),
        deps.evidenceStore.listCurrentEvidence(),
        deps.reconciliations.listAll(),
        capsule === null ? Promise.resolve(null) : buildAttestation(deps, id, capsule),
      ]);
    const dependencyEdges = graph.edges.filter((edge) => edge.from === id || edge.to === id);
    const recoveryRecords = reconciliations.filter(
      (record) => record.staleRunId === id || record.replacementRunId === id,
    );

    return {
      run: { id: run.id, status: run.status },
      capsule:
        capsule === null
          ? null
          : {
              capsuleId: capsule.capsuleId,
              capsuleHash: capsule.capsuleHash,
              policyRevision: capsule.policyRevision,
              evidenceCount: capsule.evidence.length,
              deniedCount: capsule.deniedEvidenceDecisionIds.length,
              transactionCut: capsule.transactionCut,
            },
      chain,
      decisions: {
        allowed: capsule?.evidence.length ?? 0,
        denied: capsule?.deniedEvidenceDecisionIds.length ?? 0,
      },
      walnutRunState,
      attestation,
      evidenceSummary: {
        consumed: capsule?.evidence.length ?? 0,
        denied: capsule?.deniedEvidenceDecisionIds.length ?? 0,
        produced: currentEvidence.filter((evidence) => evidence.producerRunId === id).length,
      },
      dependencySummary: {
        directEdges: dependencyEdges.length,
        upstream: new Set(dependencyEdges.filter((edge) => edge.to === id).map((edge) => edge.from))
          .size,
        downstream: new Set(
          dependencyEdges.filter((edge) => edge.from === id).map((edge) => edge.to),
        ).size,
      },
      recoverySummary: {
        count: recoveryRecords.length,
        latest: recoveryRecords.at(-1) ?? null,
      },
      note: "Live Walnut state assembled from persisted capsule, ledger, graph, and recovery records.",
    };
  });

  // -- 2. Run evidence timeline -------------------------------------------------------------

  app.get("/api/runs/:id/evidence", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const query = evidenceQuery.parse(request.query);
    const knownAt =
      query.knownAt === undefined ? undefined : new Date(query.knownAt).toISOString();
    service.getRun(id);
    const capsule = await service.getCapsuleForRun(id);

    const allVersions = await deps.evidenceStore.listAllVersions();
    const versionsAtInstant =
      knownAt === undefined ? null : evidenceKnownAt(allVersions, knownAt);
    const historicalById = new Map(
      (versionsAtInstant ?? []).map((evidence) => [evidence.evidenceId, evidence]),
    );
    const exactByIdVersion = new Map(
      allVersions.map((evidence) => [`${evidence.evidenceId}@${evidence.version}`, evidence]),
    );
    const resolvedConsumed: Array<{
      ref: NonNullable<typeof capsule>["evidence"][number];
      evidence: Evidence;
    }> = [];
    if (capsule !== null) {
      for (const ref of capsule.evidence) {
        const evidence =
          knownAt === undefined
            ? exactByIdVersion.get(`${ref.evidenceId}@${ref.evidenceVersion}`) ?? null
            : historicalById.get(ref.evidenceId) ?? null;
        if (evidence !== null) {
          resolvedConsumed.push({ ref, evidence });
        }
      }
    }

    const candidateEvidence = versionsAtInstant ?? (await deps.evidenceStore.listCurrentEvidence());
    const produced = candidateEvidence.filter((evidence) => evidence.producerRunId === id);
    const deniedDecisionIds = capsule?.deniedEvidenceDecisionIds ?? [];
    const deniedDecisionIdSet = new Set(deniedDecisionIds);
    const deniedDecisions = (await deps.evaluator.listAll())
      .filter((decision) => deniedDecisionIdSet.has(decision.decisionId))
      .map((decision) => ({
        decision,
        evidence:
          exactByIdVersion.get(`${decision.evidenceId}@${decision.evidenceVersion}`) ?? null,
      }));

    return {
      consumed: resolvedConsumed,
      produced,
      deniedDecisionIds,
      deniedDecisions,
      knownAt: knownAt ?? null,
    };
  });

  // -- 3. Run evidence verify ----------------------------------------------------------------

  app.get("/api/runs/:id/evidence/verify", async (request) => {
    const { id } = runIdParams.parse(request.params);
    service.getRun(id);
    const [run, governance] = await Promise.all([
      deps.ledger.verifyChain(id),
      deps.ledger.verifyChain("_governance"),
    ]);
    return { run, governance };
  });

  // -- 3b. Run flight recorder ---------------------------------------------------------------

  app.get("/api/runs/:id/events", async (request) => {
    const { id } = runIdParams.parse(request.params);
    service.getRun(id);
    const [events, chain] = await Promise.all([
      deps.ledger.listEvents(id),
      deps.ledger.verifyChain(id),
    ]);
    return {
      chain,
      events: events.map((event) => ({
        eventId: event.eventId,
        sequence: event.sequence,
        kind: event.kind,
        actor: event.actor,
        occurredAt: event.occurredAt,
        safePayload: event.safePayload,
        payloadHash: event.payloadHash,
        eventHash: event.eventHash,
        redactionApplied: event.redactionReceipt.applied,
      })),
    };
  });

  // -- 4. Run dependencies --------------------------------------------------------------------

  app.get("/api/runs/:id/dependencies", async (request) => {
    const { id } = runIdParams.parse(request.params);
    service.getRun(id);
    const graph = await buildLiveGraph(deps);
    return { graph, focus: id };
  });

  // -- 4b. Evidence blast radius (P3-D2/E1, doc 04 §15/§23) --------------------------------------

  app.get("/api/evidence/:id/blast-radius", async (request, reply) => {
    const { id } = evidenceIdParams.parse(request.params);
    const current = await deps.evidenceStore.getEvidence(id);
    if (current === null) {
      return reply.code(404).send({ error: "Evidence not found" });
    }
    const graph = await buildLiveGraph(deps);
    const blastRadius = computeBlastRadius(graph, { kind: "evidence", id }, new Date().toISOString());
    return { blastRadius };
  });

  // -- 5. Evidence detail ----------------------------------------------------------------------

  app.get("/api/evidence/:id", async (request, reply) => {
    const { id } = evidenceIdParams.parse(request.params);
    const current = await deps.evidenceStore.getEvidence(id);
    if (current === null) {
      return reply.code(404).send({ error: "Evidence not found" });
    }
    const allVersions = await deps.evidenceStore.listAllVersions();
    const versions = allVersions
      .filter((version) => version.evidenceId === id)
      .sort((left, right) => left.version - right.version);
    const citation =
      current.citationId !== null ? await deps.evidenceStore.getCitation(current.citationId) : null;
    const pointer = await deps.evidenceStore.getPointer(current.sourcePointerId);

    return { current, versions, citation, pointer };
  });

  // -- 6. Revoke ---------------------------------------------------------------------------

  app.post("/api/evidence/:id/revoke", async (request, reply) => {
    const { id } = evidenceIdParams.parse(request.params);
    const body = reasonBody.parse(request.body);
    try {
      const evidence = await deps.writeService.revoke(id, body.reason);
      const blastRadius = await tagBlastRadius(deps, id, "revoked");
      return { evidence, blastRadius };
    } catch (error) {
      if (isUnknownEvidenceError(error)) {
        return reply.code(404).send({ error: "Evidence not found" });
      }
      throw error;
    }
  });

  // -- 7. Compromise -----------------------------------------------------------------------

  app.post("/api/evidence/:id/compromise", async (request, reply) => {
    const { id } = evidenceIdParams.parse(request.params);
    const body = reasonBody.parse(request.body);
    try {
      const evidence = await deps.writeService.compromise(id, body.reason);
      const blastRadius = await tagBlastRadius(deps, id, "compromised");
      return { evidence, blastRadius };
    } catch (error) {
      if (isUnknownEvidenceError(error)) {
        return reply.code(404).send({ error: "Evidence not found" });
      }
      throw error;
    }
  });

  // -- 8. Supersede ------------------------------------------------------------------------

  app.post("/api/evidence/:id/supersede", async (request) => {
    const { id } = evidenceIdParams.parse(request.params);
    const body = supersedeBody.parse(request.body);
    try {
      const { superseded, replacement } = await deps.writeService.supersede(
        id,
        body.replacementEvidenceId,
      );
      return { superseded, replacement };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(409, message);
    }
  });

  // -- 9. Grants: list ----------------------------------------------------------------------

  app.get("/api/agents/:id/grants", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    service.getAgent(id);
    const grants = await deps.grantStore.listFor(id, null);
    return { grants };
  });

  // -- 10. Grants: issue --------------------------------------------------------------------

  app.post("/api/agents/:id/grants", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    service.getAgent(id);
    const body = issueGrantBody.parse(request.body);
    const now = new Date().toISOString();

    const grant = await deps.grantStore.issue({
      agentId: id,
      principalId: body.principalId,
      resourcePattern: body.resourcePattern,
      action: body.action,
      validFrom: now,
      validTo: body.validTo === null ? null : new Date(body.validTo).toISOString(),
      issuedBy: "operator",
      supersedesGrantId: null,
    });

    await appendGovernanceEvent(deps, "grant.issued", "human", id, {
      grantId: grant.grantId,
      agentId: id,
      principalId: body.principalId,
      resourcePattern: body.resourcePattern,
      action: body.action,
    });

    return { grant };
  });

  // -- 11. Grants: revoke -------------------------------------------------------------------

  app.post("/api/agents/:id/grants/:grantId/revoke", async (request) => {
    const { id, grantId } = grantParams.parse(request.params);
    service.getAgent(id);
    try {
      const existing = await deps.grantStore.getById(grantId);
      if (existing === null || existing.agentId !== id) {
        throw new Error(`Grant ${grantId} does not belong to agent ${id}`);
      }
      const grant = await deps.grantStore.revoke(grantId);
      await appendGovernanceEvent(deps, "grant.revoked", "human", id, {
        grantId,
        agentId: id,
      });
      return { grant };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(409, message);
    }
  });

  // -- 12. Share evidence -------------------------------------------------------------------

  app.post("/api/evidence/:id/share/:targetAgentId", async (request, reply) => {
    const { id, targetAgentId } = shareParams.parse(request.params);
    const body = shareBody.parse(request.body);

    service.getAgent(body.fromAgentId);
    service.getAgent(targetAgentId);

    try {
      const result = await deps.shareService.share({
        evidenceId: id,
        fromAgentId: body.fromAgentId,
        toAgentId: targetAgentId,
        principalId: body.principalId,
      });
      return {
        result: result.result,
        reasonCode: result.reasonCode,
        senderDecisionId: result.senderDecision.decisionId,
        recipientDecisionId: result.recipientDecision?.decisionId ?? null,
        issuedGrantIds: result.issuedGrantIds,
      };
    } catch (error) {
      if (isUnknownEvidenceError(error)) {
        return reply.code(404).send({ error: "Evidence not found" });
      }
      throw error;
    }
  });

  // -- 13. Reconcile a stale/tainted Run (P3-D4, doc 04 §16) --------------------------------

  app.post("/api/runs/:id/reconcile", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const run = service.getRun(id);
    try {
      const reconciliation = await deps.reconcileService.reconcile(id, run.prompt, run.agentId);
      return { reconciliation };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(409, message);
    }
  });

  // -- 14. Run evidence history at a known-at instant (P3-D5/D6, doc 05 §11) ----------------

  app.get("/api/runs/:id/history", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const query = historyQuery.parse(request.query);
    service.getRun(id);
    const knownAt =
      query.knownAt === undefined
        ? new Date().toISOString()
        : new Date(query.knownAt).toISOString();

    const [allVersions, capsule, runState, stateHistory] = await Promise.all([
      deps.evidenceStore.listAllVersions(),
      service.getCapsuleForRun(id),
      deps.runStates.get(id),
      deps.runStates.history(id),
    ]);

    // Restrict to evidence this Run actually touched: consumed via its capsule, or produced by
    // it -- a known-at listing of every OTHER evidenceId in the deployment would answer a
    // different question than "this Run's history".
    const relevantEvidenceIds = new Set<string>();
    if (capsule !== null) {
      for (const ref of capsule.evidence) relevantEvidenceIds.add(ref.evidenceId);
    }
    for (const version of allVersions) {
      if (version.producerRunId === id) relevantEvidenceIds.add(version.evidenceId);
    }

    const evidence = evidenceKnownAt(allVersions, knownAt).filter((version) =>
      relevantEvidenceIds.has(version.evidenceId),
    );

    return { knownAt, evidence, runState, stateHistory };
  });

  // -- 15. Run attestation (P3-E1, doc 04 §18) ----------------------------------------------

  app.get("/api/runs/:id/attestation", async (request) => {
    const { id } = runIdParams.parse(request.params);
    service.getRun(id);
    const capsule = await service.getCapsuleForRun(id);
    if (capsule === null) {
      return { attestation: null, note: "run has no capsule" };
    }

    const attestation = await buildAttestation(deps, id, capsule);

    return {
      attestation,
      note: "changedArtifacts reports safe before/after workspace diffs captured for this run.",
    };
  });

  // -- 16. Open clarification requests (P3-C1 visibility) -----------------------------------

  app.get("/api/walnut/clarifications", async () => {
    return { open: await deps.clarifications.listOpen() };
  });

  // -- 17. Tamper-detection demo affordance (P3-E1) -----------------------------------------
  //
  // NEVER touches a real chain file (HC-7): without corruptSequence this is a plain verifyChain
  // read; with it, the corrupted content is written to a SEPARATE demo-only chain id
  // (`demo-corrupt-<runId>`) so the real per-run chain on disk is untouched and still verifies.

  app.post("/api/runs/:id/verify-tamper", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const body = verifyTamperBody.parse(request.body ?? {});
    service.getRun(id);

    if (body.corruptSequence === undefined) {
      return deps.ledger.verifyChain(id);
    }

    const original = await deps.ledger.verifyChain(id);
    const events = await deps.ledger.listEvents(id);
    const targetIndex = events.findIndex((event) => event.sequence === body.corruptSequence);
    if (targetIndex === -1) {
      throw new HttpError(400, `No ledger record at sequence ${body.corruptSequence} for run ${id}`);
    }

    const corruptedEvents = events.map((event, index) =>
      index === targetIndex ? { ...event, safePayload: tamperOneCharacter(event.safePayload) } : event,
    );

    const demoChainId = `demo-corrupt-${id}`;
    const demoPath = path.join(deps.dataDir, "walnut", "evidence", `${demoChainId}.ndjson`);
    await mkdir(path.dirname(demoPath), { recursive: true });
    await writeFile(
      demoPath,
      corruptedEvents.map((event) => canonicalJson(event)).join("\n") + "\n",
      "utf8",
    );

    const corrupted = await deps.ledger.verifyChain(demoChainId);
    return { original, corrupted };
  });
}

// Governance-chain event helper (runId: null) — same redact-then-append shape as
// evidence-write-service.ts's appendGovernanceEvent and share-service.ts's appendShareEvent,
// reused here for the two grant lifecycle events this task adds (`grant.issued`/`grant.revoked`).
async function appendGovernanceEvent(
  deps: WalnutRouteDeps,
  kind: "grant.issued" | "grant.revoked",
  actor: "human",
  agentId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await appendRedactedEvent(
    { ledger: deps.ledger, redactor: deps.redactor },
    {
      runId: null,
      agentId,
      capsuleId: null,
      kind,
      actor,
      occurredAt: new Date().toISOString(),
      payload,
      supersedesEventId: null,
    },
  );
}
