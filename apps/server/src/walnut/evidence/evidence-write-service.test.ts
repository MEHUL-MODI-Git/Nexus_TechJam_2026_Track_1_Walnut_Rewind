import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CitationVerifierImpl } from "../context/citation-verifier.js";
import type { LedgerEvent } from "../types.js";
import { EvidenceStore, FileEvidenceRepository } from "./evidence-store.js";
import type { CreateEvidenceInput } from "./evidence-write-service.js";
import { EvidenceWriteServiceImpl } from "./evidence-write-service.js";
import { EvidenceLedger } from "./ledger.js";
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

function baseInput(overrides: Partial<CreateEvidenceInput> = {}): CreateEvidenceInput {
  const charStart = SOURCE_CONTENT.indexOf(QUOTE);
  const charEnd = charStart + QUOTE.length;
  return {
    claim: "Launch date is September 14.",
    subjectKey: null,
    predicate: null,
    producerAgentId: "agent-1",
    producerRunId: "run-1",
    classification: "INTERNAL",
    requiredScopes: ["project:launch:read"],
    source: { path: SOURCE_PATH, quote: QUOTE, charStart, charEnd },
    derivedFromEvidenceIds: [],
    supersedesEvidenceId: null,
    validFrom: null,
    validTo: null,
    ...overrides,
  };
}

async function readChain(dataDir: string, chainId: string): Promise<LedgerEvent[]> {
  const raw = await readFile(path.join(dataDir, "walnut", "evidence", `${chainId}.ndjson`), "utf8");
  return raw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as LedgerEvent);
}

async function makeHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "walnut-evidence-write-"));
  directories.push(root);
  const dataDir = path.join(root, "data");
  const workspaceRoot = path.join(root, "workspaces");
  const agentId = "agent-1";
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

  return { root, dataDir, workspaceRoot, workspacePath, agentId, store, ledger, writeService };
}

describe("EvidenceWriteServiceImpl.createEvidence", () => {
  it("creates ACTIVE evidence with a VERIFIED citation, correct line bounds, and an evidence.created event on the producer Run's chain", async () => {
    const { dataDir, store, ledger, writeService } = await makeHarness();

    const result = await writeService.createEvidence(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.evidence.status).toBe("ACTIVE");
    expect(result.evidence.version).toBe(1);
    expect(result.evidence.claimHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const pointer = await store.getPointer(result.evidence.sourcePointerId);
    expect(pointer?.lineStart).toBe(2);
    expect(pointer?.lineEnd).toBe(2);
    expect(pointer?.kind).toBe("workspace_file");

    const citation = await store.getCitation(result.evidence.citationId as string);
    expect(citation?.verification).toBe("VERIFIED");

    const verification = await ledger.verifyChain("run-1");
    expect(verification).toMatchObject({ ok: true, eventCount: 1 });

    const chain = await readChain(dataDir, "run-1");
    expect(chain.map((event) => event.kind)).toEqual(["evidence.created"]);
  });

  it("rejects an off-by-one quote as citation_mismatch and appends no evidence or citation (the pointer stays as a harmless orphan)", async () => {
    const { dataDir, store, writeService } = await makeHarness();

    const input = baseInput();
    const offByOne = {
      ...input,
      source: { ...input.source, charEnd: input.source.charEnd - 1 },
    };
    const result = await writeService.createEvidence(offByOne);
    expect(result).toMatchObject({ ok: false, reason: "citation_mismatch" });
    expect(await store.listCurrentEvidence()).toEqual([]);

    const raw = await readFile(path.join(dataDir, "walnut", "evidence", "evidence-store.json"), "utf8");
    const parsed = JSON.parse(raw) as { pointers: unknown[]; citations: unknown[]; evidence: unknown[] };
    expect(parsed.pointers).toHaveLength(1);
    expect(parsed.citations).toHaveLength(0);
    expect(parsed.evidence).toHaveLength(0);
  });

  it("rejects an escaping path and a dotenv path as unsafe_path", async () => {
    const { workspacePath, writeService } = await makeHarness();

    const escapeResult = await writeService.createEvidence(
      baseInput({ source: { path: "../escape.txt", quote: QUOTE, charStart: 0, charEnd: QUOTE.length } }),
    );
    expect(escapeResult).toMatchObject({ ok: false, reason: "unsafe_path" });

    await writeFile(path.join(workspacePath, ".env"), "SECRET=super-secret-value\n", "utf8");
    const envResult = await writeService.createEvidence(
      baseInput({
        source: { path: ".env", quote: "SECRET=super-secret-value", charStart: 0, charEnd: 25 },
      }),
    );
    expect(envResult).toMatchObject({ ok: false, reason: "unsafe_path" });
  });

  it("rejects excluded directories, binary files, and oversized files before provenance reads", async () => {
    const { workspacePath, writeService } = await makeHarness();
    const unsafeFiles: Array<{ path: string; content: string | Buffer }> = [
      { path: ".git/config", content: "[remote]\nurl=secret\n" },
      { path: ".codex/auth.json", content: '{"token":"secret"}\n' },
      { path: "node_modules/pkg/index.js", content: "module.exports = 1\n" },
      { path: ".walnut/private.txt", content: "internal middleware data\n" },
      { path: "binary.bin", content: Buffer.from([0, 1, 2, 3, 255]) },
      { path: "large.txt", content: "x".repeat(1_048_577) },
    ];

    for (const fixture of unsafeFiles) {
      await mkdir(path.dirname(path.join(workspacePath, fixture.path)), { recursive: true });
      await writeFile(path.join(workspacePath, fixture.path), fixture.content);
      const result = await writeService.createEvidence(
        baseInput({
          source: { path: fixture.path, quote: "x", charStart: 0, charEnd: 1 },
        }),
      );
      expect(result, fixture.path).toMatchObject({ ok: false, reason: "unsafe_path" });
    }
  });

  it("enforces INV-6 classification monotonicity against derived contributors", async () => {
    const { writeService } = await makeHarness();

    const contributor = await writeService.createEvidence(baseInput({ classification: "CONFIDENTIAL" }));
    expect(contributor.ok).toBe(true);
    if (!contributor.ok) return;

    const weaker = await writeService.createEvidence(
      baseInput({
        classification: "INTERNAL",
        derivedFromEvidenceIds: [contributor.evidence.evidenceId],
        producerRunId: "run-2",
      }),
    );
    expect(weaker).toMatchObject({ ok: false, reason: "classification_violation" });

    const equalOrStronger = await writeService.createEvidence(
      baseInput({
        classification: "RESTRICTED",
        derivedFromEvidenceIds: [contributor.evidence.evidenceId],
        producerRunId: "run-3",
      }),
    );
    expect(equalOrStronger.ok).toBe(true);
  });

  it("rejects an unknown derivedFromEvidenceIds entry as schema_invalid", async () => {
    const { writeService } = await makeHarness();

    const result = await writeService.createEvidence(
      baseInput({ derivedFromEvidenceIds: ["ev_does_not_exist"] }),
    );
    expect(result).toMatchObject({ ok: false, reason: "schema_invalid" });
  });

  it("never persists the claim text of a rejected evidence proposal", async () => {
    const { dataDir, writeService } = await makeHarness();
    const secretClaim = "WALNUT_TEST_PLANTED_SECRET_do-not-persist";

    const input = baseInput({ claim: secretClaim });
    const offByOne = { ...input, source: { ...input.source, charEnd: input.source.charEnd - 1 } };
    const result = await writeService.createEvidence(offByOne);
    expect(result.ok).toBe(false);

    const raw = await readFile(path.join(dataDir, "walnut", "evidence", "evidence-store.json"), "utf8");
    expect(raw.includes(secretClaim)).toBe(false);
  });

  it("fails closed when the creation audit event cannot be appended", async () => {
    const { store, ledger, writeService } = await makeHarness();
    ledger.append = async () => {
      throw new Error("simulated ledger failure");
    };

    await expect(writeService.createEvidence(baseInput())).rejects.toThrow(
      "simulated ledger failure",
    );

    const versions = await store.listAllVersions();
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ version: 1, status: "ACTIVE" });
    expect(versions[0]?.txClosedAt).not.toBeNull();
    expect(versions[1]).toMatchObject({ version: 2, status: "COMPROMISED", txClosedAt: null });
    expect((await store.listCurrentEvidence()).some((item) => item.status === "ACTIVE")).toBe(
      false,
    );
  });
});

describe("EvidenceWriteServiceImpl lifecycle (supersede/revoke/compromise)", () => {
  it("supersedes evidence via the two-record protocol", async () => {
    const { dataDir, store, ledger, writeService } = await makeHarness();

    const original = await writeService.createEvidence(baseInput());
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    const replacementResult = await writeService.createEvidence(
      baseInput({
        claim: "Launch date is September 21.",
        producerRunId: "run-2",
        supersedesEvidenceId: original.evidence.evidenceId,
      }),
    );
    expect(replacementResult.ok).toBe(true);
    if (!replacementResult.ok) return;
    const replacement = replacementResult.evidence;
    expect(replacement.status).toBe("ACTIVE");
    expect(replacement.supersedesEvidenceId).toBe(original.evidence.evidenceId);

    const { superseded, replacement: returnedReplacement } = await writeService.supersede(
      original.evidence.evidenceId,
      replacement.evidenceId,
    );
    expect(superseded.status).toBe("SUPERSEDED");
    expect(superseded.version).toBe(2);
    expect(returnedReplacement.evidenceId).toBe(replacement.evidenceId);

    const closedV1 = await store.getEvidence(original.evidence.evidenceId, 1);
    expect(closedV1?.txClosedAt).not.toBeNull();

    const governanceVerification = await ledger.verifyChain("_governance");
    expect(governanceVerification.ok).toBe(true);

    const governanceChain = await readChain(dataDir, "_governance");
    expect(governanceChain.some((event) => event.kind === "evidence.superseded")).toBe(true);
  });

  it("throws when supersede() targets an evidence that is not currently ACTIVE", async () => {
    const { writeService } = await makeHarness();

    const original = await writeService.createEvidence(baseInput());
    if (!original.ok) throw new Error("setup failed");
    const replacementResult = await writeService.createEvidence(
      baseInput({ producerRunId: "run-2", supersedesEvidenceId: original.evidence.evidenceId }),
    );
    if (!replacementResult.ok) throw new Error("setup failed");

    // Revoke the original through the OTHER lifecycle path — it is no longer ACTIVE, so
    // supersede() must reject even though the replacement's own supersedesEvidenceId is correct.
    await writeService.revoke(original.evidence.evidenceId, "no longer trusted");

    await expect(
      writeService.supersede(original.evidence.evidenceId, replacementResult.evidence.evidenceId),
    ).rejects.toThrow();
  });

  it("revoke() and compromise() append a new version each and a governance event carrying the reason", async () => {
    const { dataDir, writeService } = await makeHarness();

    const created = await writeService.createEvidence(baseInput());
    if (!created.ok) throw new Error("setup failed");

    const revoked = await writeService.revoke(created.evidence.evidenceId, "source retracted");
    expect(revoked.status).toBe("REVOKED");
    expect(revoked.version).toBe(2);

    const compromised = await writeService.compromise(created.evidence.evidenceId, "tampering suspected");
    expect(compromised.status).toBe("COMPROMISED");
    expect(compromised.version).toBe(3);

    const governanceChain = await readChain(dataDir, "_governance");
    const revokedEvent = governanceChain.find((event) => event.kind === "evidence.revoked");
    const compromisedEvent = governanceChain.find((event) => event.kind === "evidence.compromised");
    expect((revokedEvent?.safePayload as { reason?: string } | undefined)?.reason).toBe(
      "source retracted",
    );
    expect((compromisedEvent?.safePayload as { reason?: string } | undefined)?.reason).toBe(
      "tampering suspected",
    );
  });
});
