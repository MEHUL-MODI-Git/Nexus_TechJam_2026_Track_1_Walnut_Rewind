import type { AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import type { AgentRunner, RuntimeEventSink } from "./types.js";

export function createRunner(
  config: AppConfig,
  sink: RuntimeEventSink | null = null,
): AgentRunner {
  return config.runtimeProvider === "container"
    ? new ContainerCodexRunner(config, sink)
    : new CodexRunner(config, sink);
}
