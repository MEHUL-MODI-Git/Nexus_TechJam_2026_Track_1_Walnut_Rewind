import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  ContainerCodexRunner,
  buildContainerRunArgs,
  containerName,
} from "./container-codex-runner.js";
import type { RunnerRequest, RuntimeEventSink } from "./types.js";

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
        runId: "run-test",
        principalId: null,
        agentVersionId: "av_test",
        contextCapsuleId: "cap_test",
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain("type=bind,src=/tmp/codex-home,dst=/codex-home");
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
        runId: "run-test",
        principalId: null,
        agentVersionId: "av_test",
        contextCapsuleId: "cap_test",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });
});

describe("ContainerCodexRunner sink wiring", () => {
  const temporaryDirectories: string[] = [];
  const FAKE_JSONL_LINES = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-fake-container" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Hello from the fake container engine." },
    }),
  ];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  // Stands in for both the container engine binary AND the `codex` process it would run inside
  // the container — buildContainerRunArgs' flags are irrelevant to this fake, which unconditionally
  // emits fixed JSONL to stdout and exits 0, exactly as if a container had run Codex successfully.
  async function makeFakeContainerEngine(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "walnut-fake-engine-"));
    temporaryDirectories.push(root);
    const scriptPath = path.join(root, "fake-engine");
    const script = ["#!/usr/bin/env bash", ...FAKE_JSONL_LINES.map((line) => `echo '${line}'`), "exit 0", ""].join(
      "\n",
    );
    await writeFile(scriptPath, script, { encoding: "utf8", mode: 0o755 });
    return scriptPath;
  }

  function makeRequest(overrides: Partial<RunnerRequest> = {}): RunnerRequest {
    return {
      agentId: "agent-fake",
      workspacePath: tmpdir(),
      prompt: "say hello",
      threadId: null,
      runId: "run-fake",
      principalId: null,
      agentVersionId: "av_fake",
      contextCapsuleId: "cap_fake",
      ...overrides,
    };
  }

  it("feeds every raw JSONL stdout line to the attached sink, in order, before run() resolves", async () => {
    const containerEngine = await makeFakeContainerEngine();
    const codexHome = await mkdtemp(path.join(tmpdir(), "walnut-codex-home-"));
    temporaryDirectories.push(codexHome);
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: codexHome,
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: containerEngine,
    });

    const received: unknown[] = [];
    let acceptStarted = 0;
    let acceptSettled = 0;
    const sink: RuntimeEventSink = {
      async accept(input) {
        acceptStarted += 1;
        received.push(input.rawEvent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        acceptSettled += 1;
      },
    };

    const runner = new ContainerCodexRunner(config, sink);
    const result = await runner.run(makeRequest());

    expect(result.output).toBe("Hello from the fake container engine.");
    expect(received).toEqual(FAKE_JSONL_LINES);
    expect(acceptSettled).toBe(acceptStarted);
    expect(acceptSettled).toBe(FAKE_JSONL_LINES.length);
  });

  it("runs without a sink attached (sink defaults to null) exactly as before", async () => {
    const containerEngine = await makeFakeContainerEngine();
    const codexHome = await mkdtemp(path.join(tmpdir(), "walnut-codex-home-"));
    temporaryDirectories.push(codexHome);
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: codexHome,
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: containerEngine,
    });

    const runner = new ContainerCodexRunner(config);
    const result = await runner.run(makeRequest());
    expect(result.output).toBe("Hello from the fake container engine.");
    expect(result.threadId).toBe("thread-fake-container");
  });
});
