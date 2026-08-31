// CapsuleStoreImpl (spec 003 §A3) — one JSON file per capsule under
// APP_DATA_DIR/walnut/capsules/<capsuleId>.json, atomic tmp+rename. INV-7: completed capsules
// are immutable — save() rejects if the capsule file already exists. A runId maps to at most
// one capsule in v1 (spec 003 §A3: "one capsule per run"); an index.json (runId -> capsuleId,
// itself atomic tmp+rename) enforces that a second capsule for the same runId is rejected too.

import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapsuleStore } from "../ports.js";
import type { ContextCapsule } from "../types.js";

const CAPSULE_ID_PATTERN = /^cap_[A-Za-z0-9-]+$/;

interface IndexFile {
  version: 1;
  byRunId: Record<string, string>;
}

const emptyIndexFile = (): IndexFile => ({ version: 1, byRunId: {} });

function assertSafeCapsuleId(capsuleId: string): void {
  if (!CAPSULE_ID_PATTERN.test(capsuleId)) {
    throw new Error(`Unsafe capsule id: ${capsuleId}`);
  }
}

export class CapsuleStoreImpl implements CapsuleStore {
  private readonly capsulesDir: string;
  private readonly indexPath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.capsulesDir = path.join(this.dataDir, "walnut", "capsules");
    this.indexPath = path.join(this.capsulesDir, "index.json");
  }

  async save(capsule: ContextCapsule): Promise<void> {
    assertSafeCapsuleId(capsule.capsuleId);

    const operation = this.queue.then(async () => {
      await mkdir(this.capsulesDir, { recursive: true });

      const capsulePath = this.pathFor(capsule.capsuleId);
      if (await this.exists(capsulePath)) {
        throw new Error(`Capsule already exists: ${capsule.capsuleId}`);
      }

      const index = await this.readIndex();
      if (index.byRunId[capsule.runId] !== undefined) {
        throw new Error(`Run already has a capsule: ${capsule.runId}`);
      }

      await this.writeJson(capsulePath, capsule);

      const nextIndex: IndexFile = {
        version: 1,
        byRunId: { ...index.byRunId, [capsule.runId]: capsule.capsuleId },
      };
      await this.writeJson(this.indexPath, nextIndex);
    });

    this.queue = operation.catch(() => undefined);
    await operation;
  }

  async getById(capsuleId: string): Promise<ContextCapsule | null> {
    assertSafeCapsuleId(capsuleId);
    try {
      const raw = await readFile(this.pathFor(capsuleId), "utf8");
      return JSON.parse(raw) as ContextCapsule;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async getByRunId(runId: string): Promise<ContextCapsule | null> {
    const index = await this.readIndex();
    const capsuleId = index.byRunId[runId];
    if (capsuleId === undefined) return null;
    return this.getById(capsuleId);
  }

  // Read-all accessor (P2-X1): every persisted capsule across every run — additive, no behaviour
  // change to save()/getById()/getByRunId(). Consumed by the dependency projector, which needs
  // every capsule to project USED_CAPSULE/CONTAINS_EVIDENCE/AUTHORIZED_BY edges system-wide.
  async listAll(): Promise<ContextCapsule[]> {
    await mkdir(this.capsulesDir, { recursive: true });
    const entries = await readdir(this.capsulesDir);
    const capsules: ContextCapsule[] = [];
    for (const entry of entries) {
      if (entry === "index.json" || !entry.endsWith(".json")) continue;
      const raw = await readFile(path.join(this.capsulesDir, entry), "utf8");
      capsules.push(JSON.parse(raw) as ContextCapsule);
    }
    return capsules;
  }

  private pathFor(capsuleId: string): string {
    return path.join(this.capsulesDir, `${capsuleId}.json`);
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async readIndex(): Promise<IndexFile> {
    await mkdir(this.capsulesDir, { recursive: true });
    try {
      const raw = await readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as IndexFile;
      if (parsed.version !== 1 || typeof parsed.byRunId !== "object" || parsed.byRunId === null) {
        throw new Error("Unsupported capsule index format");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return emptyIndexFile();
    }
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    const temporaryPath = `${filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  }
}
