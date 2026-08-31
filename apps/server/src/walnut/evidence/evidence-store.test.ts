import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Evidence, SourcePointer } from "../types.js";
import { EvidenceStore, FileEvidenceRepository } from "./evidence-store.js";
import { WorkspaceSourceResolver } from "./workspace-source.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  const now = new Date().toISOString();
  return {
    evidenceId: "ev_1",
    version: 1,
    subjectKey: null,
    predicate: null,
    claim: "Example claim.",
    producerAgentId: "agent-1",
    producerRunId: "run-1",
    sourcePointerId: "ptr_1",
    citationId: null,
    classification: "INTERNAL",
    requiredScopes: [],
    status: "ACTIVE",
    validFrom: null,
    validTo: null,
    recordedAt: now,
    txClosedAt: null,
    supersedesEvidenceId: null,
    derivedFromEvidenceIds: [],
    claimHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  };
}

describe("EvidenceStore", () => {
  it("getEvidence returns the highest version by default, and an exact version when requested", async () => {
    const dataDir = await makeTempDir("walnut-evidence-store-");
    const store = new EvidenceStore(dataDir);

    await store.appendEvidence(makeEvidence({ version: 1 }));
    await store.appendEvidence(makeEvidence({ version: 2, status: "SUPERSEDED" }));

    const latest = await store.getEvidence("ev_1");
    expect(latest?.version).toBe(2);
    expect(latest?.status).toBe("SUPERSEDED");

    const v1 = await store.getEvidence("ev_1", 1);
    expect(v1?.version).toBe(1);
    expect(v1?.status).toBe("ACTIVE");

    expect(await store.getEvidence("ev_unknown")).toBeNull();
  });

  it("closeEvidenceVersion fills a null txClosedAt exactly once, and rejects an unknown version", async () => {
    const dataDir = await makeTempDir("walnut-evidence-store-");
    const store = new EvidenceStore(dataDir);
    await store.appendEvidence(makeEvidence({ version: 1 }));

    await store.closeEvidenceVersion("ev_1", 1);
    const closed = await store.getEvidence("ev_1", 1);
    expect(closed?.txClosedAt).not.toBeNull();

    await expect(store.closeEvidenceVersion("ev_1", 1)).rejects.toThrow();
    await expect(store.closeEvidenceVersion("ev_1", 99)).rejects.toThrow();
  });

  it("listCurrentEvidence returns the highest version per evidenceId, across ALL statuses (including REVOKED)", async () => {
    const dataDir = await makeTempDir("walnut-evidence-store-");
    const store = new EvidenceStore(dataDir);

    await store.appendEvidence(makeEvidence({ evidenceId: "ev_a", version: 1 }));
    await store.appendEvidence(makeEvidence({ evidenceId: "ev_a", version: 2, status: "REVOKED" }));
    await store.appendEvidence(makeEvidence({ evidenceId: "ev_b", version: 1, status: "ACTIVE" }));

    const current = await store.listCurrentEvidence();
    expect(current).toHaveLength(2);
    const byId = new Map(current.map((item) => [item.evidenceId, item]));
    expect(byId.get("ev_a")).toMatchObject({ version: 2, status: "REVOKED" });
    expect(byId.get("ev_b")).toMatchObject({ version: 1, status: "ACTIVE" });
  });

  it("serializes concurrent transitions without duplicate or multiply-open versions", async () => {
    const dataDir = await makeTempDir("walnut-evidence-store-");
    const store = new EvidenceStore(dataDir);
    await store.appendEvidence(makeEvidence());

    const results = await Promise.all([
      store.transitionEvidence("ev_1", "REVOKED"),
      store.transitionEvidence("ev_1", "COMPROMISED"),
    ]);

    expect(results.map((result) => result.current.version).sort()).toEqual([2, 3]);
    const versions = await store.listAllVersions();
    expect(versions.map((version) => version.version)).toEqual([1, 2, 3]);
    expect(versions.filter((version) => version.txClosedAt === null)).toHaveLength(1);
    expect(versions[0]?.txClosedAt).toBe(versions[1]?.recordedAt);
    expect(versions[1]?.txClosedAt).toBe(versions[2]?.recordedAt);
  });
});

describe("FileEvidenceRepository.listCandidateEvidence", () => {
  it("returns the version that was current at knownAt instead of the latest version", async () => {
    const root = await makeTempDir("walnut-evidence-known-at-");
    const store = new EvidenceStore(path.join(root, "data"));
    const sources = new WorkspaceSourceResolver({
      resolveWorkspacePath: (id) => path.join(root, "workspaces", id),
    });
    const repository = new FileEvidenceRepository({ store, sources });

    await store.appendEvidence(
      makeEvidence({ recordedAt: "2026-01-01T00:00:00.000Z", txClosedAt: "2026-02-01T00:00:00.000Z" }),
    );
    await store.appendEvidence(
      makeEvidence({
        version: 2,
        status: "REVOKED",
        recordedAt: "2026-02-01T00:00:00.000Z",
      }),
    );

    const historical = await repository.listCandidateEvidence({
      agentId: "agent-1",
      knownAt: "2026-01-15T00:00:00.000Z",
    });
    expect(historical).toHaveLength(1);
    expect(historical[0]).toMatchObject({ evidenceId: "ev_1", version: 1, status: "ACTIVE" });
    const offsetHistorical = await repository.listCandidateEvidence({
      agentId: "agent-1",
      // This is 2026-01-31T16:00Z, still before the v2 boundary despite its Feb-01 local date.
      knownAt: "2026-02-01T00:00:00.000+08:00",
    });
    expect(offsetHistorical[0]).toMatchObject({ evidenceId: "ev_1", version: 1 });
    expect(await repository.listCandidateEvidence({ agentId: "agent-1" })).toMatchObject([
      { evidenceId: "ev_1", version: 2, status: "REVOKED" },
    ]);
  });
});

describe("FileEvidenceRepository.resolveSourceContent (INV-19 drift)", () => {
  it("reports drifted=true once the workspace file changes after the pointer was recorded", async () => {
    const root = await makeTempDir("walnut-evidence-repo-");
    const workspaceRoot = path.join(root, "workspaces");
    const agentId = "agent-1";
    const workspacePath = path.join(workspaceRoot, agentId);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, "note.txt"), "original content", "utf8");

    const dataDir = path.join(root, "data");
    const store = new EvidenceStore(dataDir);
    const sources = new WorkspaceSourceResolver({
      resolveWorkspacePath: (id) => path.join(workspaceRoot, id),
    });
    const repository = new FileEvidenceRepository({ store, sources });

    const firstRead = await sources.read(agentId, "note.txt");
    if (!firstRead.ok) throw new Error("setup failed to read the fixture file");

    const pointer: SourcePointer = {
      pointerId: "ptr_1",
      sourceId: `workspace://${agentId}/note.txt`,
      kind: "workspace_file",
      locator: { agentId, path: "note.txt" },
      contentHash: firstRead.currentHash,
      mediaType: null,
      charStart: 0,
      charEnd: 8,
      lineStart: 1,
      lineEnd: 1,
      observedAt: new Date().toISOString(),
      classification: "INTERNAL",
    };
    await store.appendPointer(pointer);

    const beforeEdit = await repository.resolveSourceContent("ptr_1");
    expect(beforeEdit).toMatchObject({ ok: true, drifted: false });

    await writeFile(path.join(workspacePath, "note.txt"), "edited content", "utf8");

    const afterEdit = await repository.resolveSourceContent("ptr_1");
    expect(afterEdit).toMatchObject({ ok: true, drifted: true });

    expect(await repository.resolveSourceContent("ptr_missing")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});
