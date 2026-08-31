// Shared type guard (behaviour-preserving extraction of the identical local `isPlainObject`
// definitions previously duplicated in evidence/codex-event-adapter.ts and
// evidence/runtime-event-sink.ts).

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
