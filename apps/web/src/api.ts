import type { Agent, AgentRun, Message, SystemInfo } from "./types";
import type {
  AttestationResponse,
  ClarificationsResponse,
  DependenciesResponse,
  HistoryResponse,
  ReconcileResponse,
  RevokeCompromiseResponse,
  RunEvidenceResponse,
  RunEventsResponse,
  RunWalnutOverview,
  VerifyResponse,
} from "./walnut/types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  walnutOverview: (runId: string) =>
    request<RunWalnutOverview>("/api/runs/" + runId + "/walnut"),
  walnutEvidence: (runId: string) =>
    request<RunEvidenceResponse>("/api/runs/" + runId + "/evidence"),
  walnutEvents: (runId: string) =>
    request<RunEventsResponse>("/api/runs/" + runId + "/events"),
  walnutVerify: (runId: string) =>
    request<VerifyResponse>("/api/runs/" + runId + "/evidence/verify"),
  walnutDependencies: (runId: string) =>
    request<DependenciesResponse>("/api/runs/" + runId + "/dependencies"),
  walnutHistory: (runId: string, knownAt?: string) =>
    request<HistoryResponse>(
      "/api/runs/" +
        runId +
        "/history" +
        (knownAt ? "?knownAt=" + encodeURIComponent(knownAt) : ""),
    ),
  walnutAttestation: (runId: string) =>
    request<AttestationResponse>("/api/runs/" + runId + "/attestation"),
  walnutClarifications: () =>
    request<ClarificationsResponse>("/api/walnut/clarifications"),
  reconcile: (runId: string) =>
    request<ReconcileResponse>("/api/runs/" + runId + "/reconcile", { method: "POST" }),
  revokeEvidence: (evidenceId: string, reason: string) =>
    request<RevokeCompromiseResponse>("/api/evidence/" + evidenceId + "/revoke", {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  compromiseEvidence: (evidenceId: string, reason: string) =>
    request<RevokeCompromiseResponse>("/api/evidence/" + evidenceId + "/compromise", {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
};
