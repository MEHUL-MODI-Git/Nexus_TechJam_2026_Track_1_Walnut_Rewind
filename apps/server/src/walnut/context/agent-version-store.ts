// AgentVersionStoreImpl (spec 003 §A5) — resolves the current AgentVersion for an upstream
// Agent, minting a new version only when its version-relevant config changed. JSON-persisted,
// atomic tmp+rename, same clone-mutate-persist-swap queue pattern as ../auth/grant-store.ts.
// AgentVersion records are append-only except for the single permitted mutation: filling
// `txClosedAt` on the prior version when a new one is minted.

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { canonicalJson } from "../evidence/canonical-json.js";
import type { AgentVersionResolver } from "../ports.js";
import { JsonFileState } from "../shared/json-file-state.js";
import type { AgentVersion } from "../types.js";
import type { Agent } from "../../types.js";

interface VersionsFile {
  version: 1;
  versions: AgentVersion[];
}

const emptyVersionsFile = (): VersionsFile => ({ version: 1, versions: [] });

function computeConfigHash(agent: Agent): string {
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        name: agent.name,
        description: agent.description,
        workspaceInstructions: agent.instructions,
      }),
      "utf8",
    )
    .digest("hex");
  return `sha256:${digest}`;
}

// The latest stored version for an agent is the one with the highest `version` number — under
// normal operation this coincides with the single record whose `txClosedAt` is still null.
function latestVersionFor(versions: AgentVersion[], agentId: string): AgentVersion | null {
  let latest: AgentVersion | null = null;
  for (const candidate of versions) {
    if (candidate.agentId !== agentId) continue;
    if (latest === null || candidate.version > latest.version) {
      latest = candidate;
    }
  }
  return latest;
}

export class AgentVersionStoreImpl implements AgentVersionResolver {
  private readonly state: JsonFileState<VersionsFile>;

  constructor(dataDir: string) {
    this.state = new JsonFileState<VersionsFile>({
      filePath: path.join(dataDir, "walnut", "agent-versions", "versions.json"),
      empty: emptyVersionsFile,
      validate: (parsed) => {
        const file = parsed as VersionsFile;
        if (file.version !== 1 || !Array.isArray(file.versions)) {
          throw new Error("Unsupported agent-versions file format");
        }
        return file;
      },
    });
  }

  async resolve(agent: Agent): Promise<AgentVersion> {
    return this.state.mutate((file) => {
      const configHash = computeConfigHash(agent);
      const existing = latestVersionFor(file.versions, agent.id);

      if (existing !== null && existing.configHash === configHash) {
        return existing;
      }

      const now = new Date().toISOString();
      if (existing !== null) {
        existing.txClosedAt = now;
      }

      const next: AgentVersion = {
        versionId: `av_${randomUUID()}`,
        agentId: agent.id,
        version: existing !== null ? existing.version + 1 : 1,
        name: agent.name,
        description: agent.description,
        workspaceInstructions: agent.instructions,
        configHash,
        validFrom: now,
        validTo: null,
        recordedAt: now,
        txClosedAt: null,
        supersedesVersionId: existing !== null ? existing.versionId : null,
      };

      file.versions.push(next);
      return next;
    });
  }

  // Read-all accessor (P2-X1): every stored AgentVersion, across every Agent and every historical
  // (closed) version — additive, no behaviour change to resolve(). Consumed by the dependency
  // projector, which needs the full version history, not just the current one per Agent.
  async listAll(): Promise<AgentVersion[]> {
    const file = await this.state.read();
    return structuredClone(file.versions);
  }
}
