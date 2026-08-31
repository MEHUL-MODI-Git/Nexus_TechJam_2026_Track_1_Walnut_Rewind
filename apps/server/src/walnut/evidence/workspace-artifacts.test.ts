import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceArtifactStore } from "./workspace-artifacts.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("WorkspaceArtifactStore", () => {
  it("persists a safe before/after diff and excludes control, secret, binary, large, and symlinked files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "walnut-artifacts-"));
    directories.push(root);
    const workspacePath = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    await mkdir(path.join(workspacePath, ".git"), { recursive: true });
    await mkdir(path.join(workspacePath, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(workspacePath, "modified.txt"), "before", "utf8");
    await writeFile(path.join(workspacePath, "deleted.txt"), "delete me", "utf8");
    await writeFile(path.join(workspacePath, "unchanged.txt"), "same", "utf8");
    await writeFile(path.join(workspacePath, ".env"), "TOKEN=secret", "utf8");
    await writeFile(path.join(workspacePath, ".git", "config"), "secret", "utf8");
    await writeFile(path.join(workspacePath, "node_modules", "pkg", "index.js"), "ignored", "utf8");
    await writeFile(path.join(workspacePath, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(workspacePath, "large.txt"), "x".repeat(1_048_577), "utf8");
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, path.join(workspacePath, "escape.txt"));

    const firstInstance = new WorkspaceArtifactStore(dataDir);
    await firstInstance.captureBefore({ runId: "run-1", agentId: "agent-1", workspacePath });

    await writeFile(path.join(workspacePath, "modified.txt"), "after", "utf8");
    await rm(path.join(workspacePath, "deleted.txt"));
    await writeFile(path.join(workspacePath, "created.txt"), "new", "utf8");

    // Re-open the store to prove the pending before manifest survives a process restart.
    const secondInstance = new WorkspaceArtifactStore(dataDir);
    const artifacts = await secondInstance.captureAfter({
      runId: "run-1",
      agentId: "agent-1",
      workspacePath,
      derivedFromEvidenceIds: ["ev_1"],
    });

    expect(artifacts.map((artifact) => [artifact.relativePath, artifact.state])).toEqual([
      ["created.txt", "CREATED"],
      ["deleted.txt", "DELETED"],
      ["modified.txt", "MODIFIED"],
    ]);
    expect(artifacts.every((artifact) => artifact.derivedFromEvidenceIds[0] === "ev_1")).toBe(true);
    expect(artifacts.every((artifact) => artifact.contentHashBefore !== artifact.contentHashAfter)).toBe(
      true,
    );
    expect(await secondInstance.listByRun("run-1")).toHaveLength(3);
    expect(JSON.stringify(await secondInstance.listAll())).not.toMatch(
      /\.env|\.git|node_modules|binary\.bin|large\.txt|escape\.txt/,
    );
  });
});
