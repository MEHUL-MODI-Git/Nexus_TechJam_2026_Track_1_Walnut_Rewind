// Shared JSON-file-backed state (behaviour-preserving extraction of the identical
// clone-mutate-persist-swap queue duplicated across auth/grant-store.ts,
// context/agent-version-store.ts, context/clarification-store.ts, dependency/run-state.ts,
// dependency/reconciliation.ts's inline ReconciliationStore, and evidence/evidence-store.ts).
//
// Semantics reproduced exactly:
//   - `read()` mkdir's the file's parent directory (recursive) on first load, then reads the file;
//     ENOENT resolves to `empty()`; any other read/parse/validate error rethrows.
//   - `mutate()` clones the current (loaded) value, runs `fn` against the clone, persists the
//     clone (atomic tmp+rename, `JSON.stringify(data, null, 2) + "\n"`, mode 0o600), then swaps the
//     in-memory cache to the persisted clone.
//   - Concurrent `mutate()` calls are serialized through an internal promise queue; a mutation
//     error rejects the caller's own promise but never poisons the queue for subsequent calls
//     (`.catch(() => undefined)` on the queued link).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface JsonFileStateOptions<T> {
  filePath: string;
  empty(): T;
  // Throws on bad shape -- same contract as every store's inline validation.
  validate(parsed: unknown): T;
}

export class JsonFileState<T> {
  private readonly filePath: string;
  private readonly emptyValue: () => T;
  private readonly validateValue: (parsed: unknown) => T;
  private data: T | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: JsonFileStateOptions<T>) {
    this.filePath = options.filePath;
    this.emptyValue = options.empty;
    this.validateValue = options.validate;
  }

  async read(): Promise<T> {
    return this.ensureLoaded();
  }

  async mutate<R>(fn: (draft: T) => R): Promise<R> {
    let result!: R;
    const operation = this.queue.then(async () => {
      const current = await this.ensureLoaded();
      const next = structuredClone(current);
      result = fn(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async ensureLoaded(): Promise<T> {
    if (this.data !== null) return this.data;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.data = this.validateValue(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.data = this.emptyValue();
    }
    return this.data;
  }

  private async persist(data: T): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
