import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CitationVerifierImpl } from "../context/citation-verifier.js";
import { EvidenceStore, FileEvidenceRepository } from "./evidence-store.js";
import { EvidenceWriteServiceImpl } from "./evidence-write-service.js";
import { EvidenceLedger } from "./ledger.js";
import { processOutbox } from "./outbox.js";
import { Redactor } from "./redactor.js";
import { WorkspaceSourceResolver } from "./workspace-source.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const SOURCE_CONTENT = "Preface.\nLaunch date is September 14.\nTrailer.\n";
const QUOTE = "Launch date is September 14.";
const SOURCE_PATH = "launch-plan.txt";

async function makeHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "walnut-outbox-"));
  directories.push(root);
  const dataDir = path.join(root, "data");
  const workspaceRoot = path.join(root, "workspaces");
  const agentId = "agent-1";
  const runId = "run-1";
  const workspacePath = path.join(workspaceRoot, agentId);
  await mkdir(workspacePath, { recursive: true });
  await writeFile(path.join(workspacePath, SOURCE_PATH), SOURCE_CONTENT, "utf8");

  const store = new EvidenceStore(dataDir);
  const sources = new WorkspaceSourceResolver({
    resolveWorkspacePath: (id) => path.join(workspaceRoot, id),
  });
  const evidenceRepository = new FileEvidenceRepository({ store, sources });
  const verifier = new CitationVerifierImpl({ evidenceRepository });
  const ledger = new EvidenceLedger(dataDir);
  const redactor = new Redactor({ environment: {} });
  const writeService = new EvidenceWriteServiceImpl({ store, sources, verifier, ledger, redactor });

  return { root, dataDir, workspacePath, agentId, runId, writeService };
}

async function writeOutbox(workspacePath: string, content: string): Promise<void> {
  await mkdir(path.join(workspacePath, ".walnut"), { recursive: true });
  await writeFile(path.join(workspacePath, ".walnut", "outbox.json"), content, "utf8");
}

function validOutboxEntry(): Record<string, unknown> {
  const charStart = SOURCE_CONTENT.indexOf(QUOTE);
  const charEnd = charStart + QUOTE.length;
  return {
    claim: "Launch date is September 14.",
    classification: "INTERNAL",
    requiredScopes: ["project:launch:read"],
    source: { path: SOURCE_PATH, quote: QUOTE, charStart, charEnd },
    derivedFromEvidenceIds: [],
  };
}

describe("processOutbox", () => {
  it("returns an empty result when the outbox file is missing", async () => {
    const { workspacePath, agentId, runId, writeService } = await makeHarness();
    const result = await processOutbox({ workspacePath, agentId, runId, writeService });
    expect(result).toEqual({ accepted: [], rejected: [] });
  });

  it("accepts a valid outbox and renames the file so a restart never double-ingests", async () => {
    const { workspacePath, agentId, runId, writeService } = await makeHarness();
    await writeOutbox(workspacePath, JSON.stringify({ evidence: [validOutboxEntry()] }));

    const result = await processOutbox({ workspacePath, agentId, runId, writeService });
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0]?.status).toBe("ACTIVE");

    const files = await readdir(path.join(workspacePath, ".walnut"));
    expect(files).toEqual([`outbox.processed-${runId}.json`]);
  });

  it("accepts one valid entry and rejects one invalid entry, by index, and still renames the file", async () => {
    const { workspacePath, agentId, runId, writeService } = await makeHarness();
    await writeOutbox(
      workspacePath,
      JSON.stringify({
        evidence: [validOutboxEntry(), { claim: "", classification: "NOT_A_CLASSIFICATION" }],
      }),
    );

    const result = await processOutbox({ workspacePath, agentId, runId, writeService });
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({ index: 1, reason: "schema_invalid" });

    const files = await readdir(path.join(workspacePath, ".walnut"));
    expect(files).toEqual([`outbox.processed-${runId}.json`]);
  });

  it("rejects malformed JSON at index -1 and leaves the file in place", async () => {
    const { workspacePath, agentId, runId, writeService } = await makeHarness();
    await writeOutbox(workspacePath, "{not valid json");

    const result = await processOutbox({ workspacePath, agentId, runId, writeService });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { index: -1, reason: "schema_invalid", detail: expect.any(String) },
    ]);

    const files = await readdir(path.join(workspacePath, ".walnut"));
    expect(files).toEqual(["outbox.json"]);
  });

  it("rejects a top-level shape that is not { evidence: [...] } at index -1 and leaves the file in place", async () => {
    const { workspacePath, agentId, runId, writeService } = await makeHarness();
    await writeOutbox(workspacePath, JSON.stringify({ notEvidence: [] }));

    const result = await processOutbox({ workspacePath, agentId, runId, writeService });
    expect(result.rejected).toEqual([
      { index: -1, reason: "schema_invalid", detail: expect.any(String) },
    ]);

    const files = await readdir(path.join(workspacePath, ".walnut"));
    expect(files).toEqual(["outbox.json"]);
  });
});
