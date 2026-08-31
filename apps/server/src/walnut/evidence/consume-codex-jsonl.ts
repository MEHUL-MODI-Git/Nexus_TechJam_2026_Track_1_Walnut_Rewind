// Shared line-buffering and sink fan-out for Codex JSONL stdout streams (overlay P1-E2/E3). Both
// runners previously duplicated split-on-newline / keep-trailing-partial logic inline; this
// module owns it once. For every complete line, the runner's own `onLine` callback runs
// synchronously (unchanged `parseCodexEventLine` behaviour), and — when a sink is attached — the
// raw line is queued onto a per-consumer sequential promise chain so ledger appends are
// order-preserving (INV-14) and never interleave across chunks. `done()` must be awaited before
// `run()` returns so a broken ledger chain fails the Run loudly (INV-13); a rejection anywhere in
// the queue propagates out of `done()` and short-circuits any events still queued behind it.

import type { RunnerRequest, RuntimeEventSink } from "../../types.js";

export interface CodexJsonlConsumerOptions {
  request: RunnerRequest;
  provider: "local-process" | "container";
  sink: RuntimeEventSink | null;
  onLine(line: string): void;
}

export interface CodexJsonlConsumer {
  consumeChunk(chunk: string): void;
  flush(): void;
  done(): Promise<void>;
}

export function createCodexJsonlConsumer(options: CodexJsonlConsumerOptions): CodexJsonlConsumer {
  const { request, provider, sink, onLine } = options;
  let buffer = "";
  let queue: Promise<void> = Promise.resolve();

  function handleLine(line: string): void {
    onLine(line);
    // Whitespace-only lines are stream noise, not events — forwarding them would chain a
    // spurious parse_failure record (the pre-extraction runners skipped them via stdout.trim()).
    if (sink !== null && line.trim().length > 0) {
      queue = queue.then(() =>
        sink.accept({
          runId: request.runId,
          agentId: request.agentId,
          provider,
          rawEvent: line,
          receivedAt: new Date().toISOString(),
        }),
      );
    }
  }

  return {
    consumeChunk(chunk: string): void {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    },
    flush(): void {
      if (buffer.length > 0) {
        const trailing = buffer;
        buffer = "";
        handleLine(trailing);
      }
    },
    done(): Promise<void> {
      return queue;
    },
  };
}
