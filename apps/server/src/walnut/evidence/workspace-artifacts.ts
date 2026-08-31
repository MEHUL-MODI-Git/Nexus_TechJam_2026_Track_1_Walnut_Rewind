import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { JsonFileState } from "../shared/json-file-state.js";
import { sha256Prefixed } from "../shared/hash.js";
import type { ArtifactRecord, EvidenceId } from "../types.js";
import {
  isWorkspaceEvidencePathAllowed,
  looksBinary,
  MAX_WORKSPACE_EVIDENCE_BYTES,
} from "./workspace-source.js";

type WorkspaceManifest = Record<string, string>;

interface PendingManifest {
  runId: string;
  agentId: string;
  workspacePath: string;
  before: WorkspaceManifest;
  capturedAt: string;
}

interface ArtifactStoreFile {
  version: 1;
  pending: PendingManifest[];
  artifacts: ArtifactRecord[];
}

const emptyStore = (): ArtifactStoreFile => ({ version: 1, pending: [], artifacts: [] });

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export async function captureWorkspaceManifest(workspacePath: string): Promise<WorkspaceManifest> {
  const root = await realpath(workspacePath);
  const manifest: WorkspaceManifest = Object.create(null) as WorkspaceManifest;

  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (!isWorkspaceEvidencePathAllowed(relativePath) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const [metadata, resolvedPath] = await Promise.all([lstat(absolutePath), realpath(absolutePath)]);
        if (
          !metadata.isFile() ||
          metadata.size > MAX_WORKSPACE_EVIDENCE_BYTES ||
          !isInside(root, resolvedPath)
        ) {
          continue;
        }
        const content = await readFile(resolvedPath);
        if (looksBinary(content)) continue;
        manifest[relativePath] = sha256Prefixed(content);
      } catch {
        // A file can disappear while a runner is mutating the workspace. It will be represented
        // by the stable before/after snapshots when present; transient unreadable entries are not
        // evidence and must not abort the whole Run.
      }
    }
  }

  await visit(root);
  return manifest;
}

export class WorkspaceArtifactStore {
  private readonly state: JsonFileState<ArtifactStoreFile>;

  constructor(dataDir: string) {
    this.state = new JsonFileState<ArtifactStoreFile>({
      filePath: path.join(dataDir, "walnut", "evidence", "artifacts.json"),
      empty: emptyStore,
      validate: (parsed) => {
        const file = parsed as ArtifactStoreFile;
        if (file.version !== 1 || !Array.isArray(file.pending) || !Array.isArray(file.artifacts)) {
          throw new Error("Unsupported artifact store file format");
        }
        return file;
      },
    });
  }

  async captureBefore(input: {
    runId: string;
    agentId: string;
    workspacePath: string;
  }): Promise<void> {
    const before = await captureWorkspaceManifest(input.workspacePath);
    await this.state.mutate((file) => {
      if (file.pending.some((item) => item.runId === input.runId)) {
        throw new Error(`Before manifest already captured for run ${input.runId}`);
      }
      file.pending.push({ ...input, before, capturedAt: new Date().toISOString() });
    });
  }

  async captureAfter(input: {
    runId: string;
    agentId: string;
    workspacePath: string;
    derivedFromEvidenceIds: EvidenceId[];
  }): Promise<ArtifactRecord[]> {
    const after = await captureWorkspaceManifest(input.workspacePath);
    return this.state.mutate((file) => {
      const pendingIndex = file.pending.findIndex((item) => item.runId === input.runId);
      const pending = file.pending[pendingIndex];
      if (pending === undefined) {
        throw new Error(`Before manifest not found for run ${input.runId}`);
      }
      if (pending.agentId !== input.agentId || pending.workspacePath !== input.workspacePath) {
        throw new Error(`Manifest identity mismatch for run ${input.runId}`);
      }

      const paths = [...new Set([...Object.keys(pending.before), ...Object.keys(after)])].sort();
      const recordedAt = new Date().toISOString();
      const artifacts: ArtifactRecord[] = [];
      for (const relativePath of paths) {
        const contentHashBefore = pending.before[relativePath] ?? null;
        const contentHashAfter = after[relativePath] ?? null;
        if (contentHashBefore === contentHashAfter) continue;
        artifacts.push({
          artifactId: `art_${randomUUID()}`,
          runId: input.runId,
          agentId: input.agentId,
          relativePath,
          state:
            contentHashBefore === null
              ? "CREATED"
              : contentHashAfter === null
                ? "DELETED"
                : "MODIFIED",
          contentHashBefore,
          contentHashAfter,
          classification: "INTERNAL",
          recordedAt,
          derivedFromEvidenceIds: [...input.derivedFromEvidenceIds],
        });
      }
      file.pending.splice(pendingIndex, 1);
      file.artifacts.push(...artifacts);
      return artifacts;
    });
  }

  async listByRun(runId: string): Promise<ArtifactRecord[]> {
    const file = await this.state.read();
    return structuredClone(file.artifacts.filter((artifact) => artifact.runId === runId));
  }

  async listAll(): Promise<ArtifactRecord[]> {
    const file = await this.state.read();
    return structuredClone(file.artifacts);
  }
}
