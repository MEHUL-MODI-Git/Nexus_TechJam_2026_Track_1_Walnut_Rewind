import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import type { ContextCapsule } from "./walnut/types.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

function makeCapsuleServiceStub(capsulesByRunId: Map<string, ContextCapsule>): AgentService {
  return {
    listAgents: () => [],
    systemInfo: async () => ({}),
    getCapsuleForRun: async (runId: string) => capsulesByRunId.get(runId) ?? null,
  } as unknown as AgentService;
}

function makeCapsule(overrides: Partial<ContextCapsule> = {}): ContextCapsule {
  return {
    schemaVersion: 1,
    capsuleId: "cap_test",
    runId: "run-test",
    agentId: "agent-test",
    agentVersionId: "av_test",
    agentPrincipalId: "agent:agent-test",
    onBehalfOfPrincipalId: null,
    policyRevision: 1,
    policyHash: `sha256:${"a".repeat(64)}`,
    evidence: [],
    deniedEvidenceDecisionIds: [],
    createdAt: "2026-08-27T00:00:00.000Z",
    transactionCut: "ledger:0",
    capsuleHash: `sha256:${"b".repeat(64)}`,
    ...overrides,
  };
}

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});

describe("Capsule route (spec 003 §A4)", () => {
  it("returns 404 with the documented error body for a run with no capsule", async () => {
    const runId = randomUUID();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      makeCapsuleServiceStub(new Map()),
    );

    const response = await app.inject({ method: "GET", url: `/api/runs/${runId}/capsule` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "No capsule for this run" });
    await app.close();
  });

  it("returns 200 with the capsule for a run that has one, inside the bearer-token auth scope", async () => {
    const runId = randomUUID();
    const capsule = makeCapsule({ runId });
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      makeCapsuleServiceStub(new Map([[runId, capsule]])),
    );

    const denied = await app.inject({ method: "GET", url: `/api/runs/${runId}/capsule` });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/capsule`,
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ capsule });
    await app.close();
  });
});
