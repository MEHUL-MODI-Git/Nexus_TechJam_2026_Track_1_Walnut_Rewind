#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function defaultDataDirectory() {
  if (process.env.WALNUT_DEMO_DATA_DIR) return process.env.WALNUT_DEMO_DATA_DIR;
  if (process.env.APP_DATA_DIR) return process.env.APP_DATA_DIR;
  if (process.env.LOCAL_POC_DATA_ROOT) {
    return path.join(process.env.LOCAL_POC_DATA_ROOT, "data");
  }
  return process.platform === "darwin"
    ? path.join(os.homedir(), ".volc-agent-launchpad", "data")
    : path.join(repositoryRoot, ".local", "data");
}

function fail(message) {
  process.stderr.write(`[demo-fixtures] ${message}\n`);
  process.exitCode = 1;
}

function sourceRange(content, quote) {
  const charStart = content.indexOf(quote);
  if (charStart < 0) throw new Error(`Quote not found in fixture source: ${quote}`);
  return { charStart, charEnd: charStart + quote.length };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function prepareResearch(workspacePath) {
  const walnutDirectory = path.join(workspacePath, ".walnut");
  const walnutFiles = await readdir(walnutDirectory).catch(() => []);
  if (
    !walnutFiles.includes("outbox.json") &&
    walnutFiles.some((name) => name.startsWith("outbox.processed-") && name.endsWith(".json"))
  ) {
    throw new Error(
      "Research already has a processed demo outbox; reset its .walnut directory before reseeding",
    );
  }
  const launchContent = [
    "Aurora launch control brief",
    "Approved launch date: October 1.",
    "Region: Southeast Asia.",
    "",
  ].join("\n");
  const payrollContent = [
    "Restricted launch staffing note",
    "WALNUT_CANARY_DENIED_PAYROLL_93c1e7",
    "Payroll adjustment pool: SGD 240,000.",
    "",
  ].join("\n");
  const launchQuote = "Approved launch date: October 1.";
  const payrollQuote = "WALNUT_CANARY_DENIED_PAYROLL_93c1e7";
  const badQuote = "Approved launch date: October 15.";
  const launchRange = sourceRange(launchContent, launchQuote);
  const payrollRange = sourceRange(payrollContent, payrollQuote);

  await mkdir(workspacePath, { recursive: true });
  await Promise.all([
    writeFile(path.join(workspacePath, "launch-plan.txt"), launchContent, "utf8"),
    writeFile(path.join(workspacePath, "payroll-note.txt"), payrollContent, "utf8"),
  ]);
  await writeJson(path.join(walnutDirectory, "outbox.json"), {
    evidence: [
      {
        claim: "Aurora is approved to launch on October 1.",
        classification: "INTERNAL",
        requiredScopes: ["project:launch:read"],
        source: { path: "launch-plan.txt", quote: launchQuote, ...launchRange },
        derivedFromEvidenceIds: [],
        subjectKey: "project:aurora",
        predicate: "launch_date",
        validFrom: "2026-10-01T00:00:00.000Z",
        validTo: null,
        supersedesEvidenceId: null,
      },
      {
        claim: "WALNUT_CANARY_DENIED_PAYROLL_93c1e7 — payroll adjustment pool is restricted.",
        classification: "RESTRICTED",
        requiredScopes: ["project:payroll:read"],
        source: { path: "payroll-note.txt", quote: payrollQuote, ...payrollRange },
        derivedFromEvidenceIds: [],
        subjectKey: "project:aurora",
        predicate: "payroll_adjustment",
        validFrom: null,
        validTo: null,
        supersedesEvidenceId: null,
      },
      {
        claim: "Aurora is approved to launch on October 15.",
        classification: "INTERNAL",
        requiredScopes: ["project:launch:read"],
        source: {
          path: "launch-plan.txt",
          quote: badQuote,
          charStart: launchRange.charStart,
          charEnd: launchRange.charStart + badQuote.length,
        },
        derivedFromEvidenceIds: [],
        subjectKey: "project:aurora-bad-anchor",
        predicate: "launch_date",
        validFrom: null,
        validTo: null,
        supersedesEvidenceId: null,
      },
    ],
  });

  process.stdout.write(
    JSON.stringify({
      prepared: "research",
      workspacePath,
      acceptedExpected: 2,
      rejectedExpected: 1,
      rejectionReason: "citation_mismatch",
    }) + "\n",
  );
}

async function prepareComms(workspacePath) {
  const task = [
    "# Aurora communications task",
    "",
    "Use only the launch evidence present in your Walnut context capsule.",
    "Write `announcement.md` with the approved date and region.",
    "Do not infer or mention payroll information.",
    "",
  ].join("\n");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(path.join(workspacePath, "COMMS_TASK.md"), task, "utf8");
  process.stdout.write(JSON.stringify({ prepared: "comms", workspacePath }) + "\n");
}

async function stageSidecars({ dataDirectory, researchAgentId, researchWorkspace }) {
  const [
    { EvidenceStore, FileEvidenceRepository },
    { EvidenceWriteServiceImpl },
    { EvidenceLedger },
    { WorkspaceSourceResolver },
    { Redactor },
    { CitationVerifierImpl },
  ] = await Promise.all([
    import(path.join(repositoryRoot, "apps/server/dist/walnut/evidence/evidence-store.js")),
    import(path.join(repositoryRoot, "apps/server/dist/walnut/evidence/evidence-write-service.js")),
    import(path.join(repositoryRoot, "apps/server/dist/walnut/evidence/ledger.js")),
    import(path.join(repositoryRoot, "apps/server/dist/walnut/evidence/workspace-source.js")),
    import(path.join(repositoryRoot, "apps/server/dist/walnut/evidence/redactor.js")),
    import(path.join(repositoryRoot, "apps/server/dist/walnut/context/citation-verifier.js")),
  ]);

  const store = new EvidenceStore(dataDirectory);
  const sources = new WorkspaceSourceResolver({
    resolveWorkspacePath: (agentId) => {
      if (agentId !== researchAgentId) throw new Error(`Unknown fixture agent: ${agentId}`);
      return researchWorkspace;
    },
  });
  const repository = new FileEvidenceRepository({ store, sources });
  const service = new EvidenceWriteServiceImpl({
    store,
    sources,
    verifier: new CitationVerifierImpl({ evidenceRepository: repository }),
    ledger: new EvidenceLedger(dataDirectory),
    redactor: new Redactor({ environment: {} }),
  });
  const fixtureRunId = randomUUID();
  const dateSlipContent = "Aurora launch control update\nApproved launch date: October 15.\n";
  const dateSlipQuote = "Approved launch date: October 15.";
  const pricingContent = [
    "Aurora launch pricing",
    "Original launch price: SGD 79.",
    "Corrected launch price: SGD 69.",
    "",
  ].join("\n");
  const originalPriceQuote = "Original launch price: SGD 79.";
  const correctedPriceQuote = "Corrected launch price: SGD 69.";
  await Promise.all([
    writeFile(path.join(researchWorkspace, "date-slip.txt"), dateSlipContent, "utf8"),
    writeFile(path.join(researchWorkspace, "pricing-update.txt"), pricingContent, "utf8"),
  ]);

  const create = async (input) => {
    const result = await service.createEvidence({
      producerAgentId: researchAgentId,
      producerRunId: fixtureRunId,
      classification: "INTERNAL",
      requiredScopes: ["project:launch:read"],
      derivedFromEvidenceIds: [],
      validTo: null,
      ...input,
    });
    if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
    return result.evidence;
  };

  const conflict = await create({
    claim: "Aurora is now scheduled to launch on October 15.",
    subjectKey: "project:aurora",
    predicate: "launch_date",
    source: { path: "date-slip.txt", quote: dateSlipQuote, ...sourceRange(dateSlipContent, dateSlipQuote) },
    supersedesEvidenceId: null,
    validFrom: "2026-10-15T00:00:00.000Z",
  });
  const pricingOriginal = await create({
    claim: "Aurora launch price is SGD 79.",
    subjectKey: "project:aurora",
    predicate: "launch_price",
    source: { path: "pricing-update.txt", quote: originalPriceQuote, ...sourceRange(pricingContent, originalPriceQuote) },
    supersedesEvidenceId: null,
    validFrom: null,
  });
  const pricingReplacement = await create({
    claim: "Aurora launch price is SGD 69.",
    subjectKey: "project:aurora",
    predicate: "launch_price",
    source: { path: "pricing-update.txt", quote: correctedPriceQuote, ...sourceRange(pricingContent, correctedPriceQuote) },
    supersedesEvidenceId: pricingOriginal.evidenceId,
    validFrom: null,
  });
  const transition = await service.supersede(
    pricingOriginal.evidenceId,
    pricingReplacement.evidenceId,
  );

  process.stdout.write(
    JSON.stringify({
      prepared: "sidecars",
      controlledFixture: true,
      restartRequired: true,
      nextAction: "Restart npm run poc before reading or using these staged records.",
      fixtureRunId,
      conflictEvidenceId: conflict.evidenceId,
      supersededPricingEvidenceId: transition.superseded.evidenceId,
      replacementPricingEvidenceId: transition.replacement.evidenceId,
    }) + "\n",
  );
  process.stderr.write(
    "[demo-fixtures] IMPORTANT: sidecars were written directly to disk. Restart npm run poc now; " +
      "a running server keeps its current evidence store in memory.\n",
  );
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const command = process.argv[2];
try {
  if (command === "prepare-research") {
    const workspacePath = process.argv[3];
    if (!workspacePath) throw new Error("prepare-research requires <workspace-path>");
    await prepareResearch(path.resolve(workspacePath));
  } else if (command === "prepare-comms") {
    const workspacePath = process.argv[3];
    if (!workspacePath) throw new Error("prepare-comms requires <workspace-path>");
    await prepareComms(path.resolve(workspacePath));
  } else if (command === "stage-sidecars") {
    const researchAgentId = option("--research-agent-id");
    const researchWorkspace = option("--research-workspace");
    const dataDirectory = option(
      "--data-directory",
      defaultDataDirectory(),
    );
    if (!researchAgentId || !researchWorkspace) {
      throw new Error(
        "stage-sidecars requires --research-agent-id <id> --research-workspace <path>",
      );
    }
    await stageSidecars({
      dataDirectory: path.resolve(dataDirectory),
      researchAgentId,
      researchWorkspace: path.resolve(researchWorkspace),
    });
  } else {
    throw new Error(
      "usage: walnut-demo-fixtures.mjs prepare-research <workspace> | prepare-comms <workspace> | stage-sidecars --research-agent-id <id> --research-workspace <path> [--data-directory <path>]",
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
