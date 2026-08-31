// JSON-persisted store for AgentGrant records (spec 003 §B4: context/** owns
// APP_DATA_DIR/walnut/{grants,...}/). Atomic tmp+rename persistence, same pattern as
// ../../store.ts. Grant records are append-only except for the single permitted mutation:
// filling `txClosedAt` on revoke.

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentGrant, AgentId, GrantAction, GrantId, PrincipalId } from "../types.js";
import { JsonFileState } from "../shared/json-file-state.js";

interface GrantsFile {
  version: 1;
  grants: AgentGrant[];
}

const emptyGrantsFile = (): GrantsFile => ({ version: 1, grants: [] });

export interface IssueGrantInput {
  agentId: AgentId;
  principalId: PrincipalId | null;
  resourcePattern: string;
  action: GrantAction;
  validFrom: string;
  validTo: string | null;
  issuedBy: string;
  supersedesGrantId: GrantId | null;
}

// A grant with principalId === null is an AGENT grant (usable when grant.agentId ===
// input.agentId). A grant with principalId !== null is a PRINCIPAL grant (usable when
// grant.principalId === input.principalId AND (grant.agentId === "*" or grant.agentId ===
// input.agentId)). Matches spec 003 §B3 leg rules.
function isUsableBy(
  grant: AgentGrant,
  agentId: AgentId,
  principalId: PrincipalId | null,
): boolean {
  if (grant.principalId === null) {
    return grant.agentId === agentId;
  }
  if (principalId === null || grant.principalId !== principalId) {
    return false;
  }
  return grant.agentId === "*" || grant.agentId === agentId;
}

export class GrantStore {
  private readonly state: JsonFileState<GrantsFile>;

  constructor(dataDir: string) {
    this.state = new JsonFileState<GrantsFile>({
      filePath: path.join(dataDir, "walnut", "grants", "grants.json"),
      empty: emptyGrantsFile,
      validate: (parsed) => {
        const file = parsed as GrantsFile;
        if (file.version !== 1 || !Array.isArray(file.grants)) {
          throw new Error("Unsupported grants file format");
        }
        return file;
      },
    });
  }

  async issue(input: IssueGrantInput): Promise<AgentGrant> {
    return this.state.mutate((file) => {
      const grant: AgentGrant = {
        grantId: `grant_${randomUUID()}`,
        agentId: input.agentId,
        principalId: input.principalId,
        resourcePattern: input.resourcePattern,
        action: input.action,
        validFrom: input.validFrom,
        validTo: input.validTo,
        recordedAt: new Date().toISOString(),
        txClosedAt: null,
        issuedBy: input.issuedBy,
        supersedesGrantId: input.supersedesGrantId,
      };
      file.grants.push(grant);
      return grant;
    });
  }

  async revoke(grantId: GrantId): Promise<AgentGrant> {
    return this.state.mutate((file) => {
      const grant = file.grants.find((candidate) => candidate.grantId === grantId);
      if (!grant) {
        throw new Error(`Unknown grant: ${grantId}`);
      }
      if (grant.txClosedAt !== null) {
        throw new Error(`Grant already closed: ${grantId}`);
      }
      grant.txClosedAt = new Date().toISOString();
      return grant;
    });
  }

  async getById(grantId: GrantId): Promise<AgentGrant | null> {
    const file = await this.state.read();
    return file.grants.find((grant) => grant.grantId === grantId) ?? null;
  }

  // Validity is NOT filtered here — the evaluator needs expired/revoked grants too, to
  // distinguish GRANT_EXPIRED from AGENT_SCOPE_MISSING / PRINCIPAL_SCOPE_MISSING.
  async listFor(agentId: AgentId, principalId: PrincipalId | null): Promise<AgentGrant[]> {
    const file = await this.state.read();
    return file.grants.filter((grant) => isUsableBy(grant, agentId, principalId));
  }
}
