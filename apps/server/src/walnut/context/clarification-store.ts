// JSON-persisted store for ClarificationRequest records (spec 003 §B4: context/** owns
// APP_DATA_DIR/walnut/{capsules,decisions,grants,clarifications}/). Atomic tmp+rename
// persistence, same house pattern as ../auth/grant-store.ts. Append-only except for the single
// permitted mutation: filling `resolvedAt` on resolve(). Minting (requestId, question, options,
// ...) happens in ContextBrokerImpl, never here — this store only persists and queries.

import path from "node:path";
import { JsonFileState } from "../shared/json-file-state.js";
import type { ClarificationRequest, ClarificationRequestId } from "../types.js";

interface ClarificationsFile {
  version: 1;
  requests: ClarificationRequest[];
}

const emptyClarificationsFile = (): ClarificationsFile => ({ version: 1, requests: [] });

export class ClarificationStoreImpl {
  private readonly state: JsonFileState<ClarificationsFile>;

  constructor(dataDir: string) {
    this.state = new JsonFileState<ClarificationsFile>({
      filePath: path.join(dataDir, "walnut", "clarifications", "clarifications.json"),
      empty: emptyClarificationsFile,
      validate: (parsed) => {
        const file = parsed as ClarificationsFile;
        if (file.version !== 1 || !Array.isArray(file.requests)) {
          throw new Error("Unsupported clarifications file format");
        }
        return file;
      },
    });
  }

  async save(request: ClarificationRequest): Promise<void> {
    await this.state.mutate((file) => {
      const duplicate = file.requests.some(
        (existing) => existing.requestId === request.requestId,
      );
      if (duplicate) {
        throw new Error(`Duplicate clarification request: ${request.requestId}`);
      }
      file.requests.push(request);
    });
  }

  async getById(requestId: ClarificationRequestId): Promise<ClarificationRequest | null> {
    const file = await this.state.read();
    return file.requests.find((request) => request.requestId === requestId) ?? null;
  }

  async listOpen(): Promise<ClarificationRequest[]> {
    const file = await this.state.read();
    return file.requests.filter((request) => request.resolvedAt === null);
  }

  async resolve(requestId: ClarificationRequestId, at: string): Promise<ClarificationRequest> {
    return this.state.mutate((file) => {
      const request = file.requests.find((candidate) => candidate.requestId === requestId);
      if (!request) {
        throw new Error(`Unknown clarification request: ${requestId}`);
      }
      if (request.resolvedAt !== null) {
        throw new Error(`Clarification request already resolved: ${requestId}`);
      }
      request.resolvedAt = at;
      return request;
    });
  }
}
