// Shared SHA-256 helpers (behaviour-preserving extraction of the identical local `sha256Hex`
// definitions previously duplicated across evidence/ledger.ts, evidence/evidence-write-service.ts,
// evidence/runtime-event-sink.ts, evidence/workspace-source.ts, and upstream agent-service.ts).
// Byte-for-byte identical to every definition it replaces: `.update(value, "utf8")` for a string,
// raw `.update(value)` for a Buffer.

import { createHash } from "node:crypto";

export function sha256Hex(value: string | Buffer): string {
  const hash = createHash("sha256");
  if (typeof value === "string") {
    hash.update(value, "utf8");
  } else {
    hash.update(value);
  }
  return hash.digest("hex");
}

export function sha256Prefixed(value: string | Buffer): string {
  return `sha256:${sha256Hex(value)}`;
}
