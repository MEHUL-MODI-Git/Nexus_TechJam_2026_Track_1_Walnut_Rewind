import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { CodexRunner, buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";
import type { RunnerRequest, RuntimeEventSink } from "./types.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
        runId: "run-test",
        principalId: null,
        agentVersionId: "av_test",
        contextCapsuleId: "cap_test",
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
        runId: "run-test",
        principalId: null,
        agentVersionId: "av_test",
        contextCapsuleId: "cap_test",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });
});

describe("CodexRunner sink wiring", () => {
  const temporaryDirectories: string[] = [];
  const FAKE_JSONL_LINES = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-fake" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Hello from the fake Codex binary." },
    }),
  ];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function makeFakeCodexBin(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "walnut-fake-codex-"));
    temporaryDirectories.push(root);
    const scriptPath = path.join(root, "fake-codex");
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
    const codexBin = await makeFakeCodexBin();
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_BIN: codexBin,
      CODEX_HOME: await mkdtemp(path.join(tmpdir(), "walnut-codex-home-")),
    });
    temporaryDirectories.push(config.codexHome);

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

    const runner = new CodexRunner(config, sink);
    const result = await runner.run(makeRequest());

    expect(result.output).toBe("Hello from the fake Codex binary.");
    expect(received).toEqual(FAKE_JSONL_LINES);
    // INV-13/14: every accept() call queued by the consumer must have fully settled — not just
    // started — before run() returns its result.
    expect(acceptSettled).toBe(acceptStarted);
    expect(acceptSettled).toBe(FAKE_JSONL_LINES.length);
  });

  it("runs without a sink attached (sink defaults to null) exactly as before", async () => {
    const codexBin = await makeFakeCodexBin();
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_BIN: codexBin,
      CODEX_HOME: await mkdtemp(path.join(tmpdir(), "walnut-codex-home-")),
    });
    temporaryDirectories.push(config.codexHome);

    const runner = new CodexRunner(config);
    const result = await runner.run(makeRequest());
    expect(result.output).toBe("Hello from the fake Codex binary.");
    expect(result.threadId).toBe("thread-fake");
  });
});
