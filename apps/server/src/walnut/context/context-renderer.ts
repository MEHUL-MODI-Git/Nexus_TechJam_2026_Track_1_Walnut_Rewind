// Deterministic <WALNUT_CONTEXT> render format (spec 003 §A1; doc 03 §13). No timestamps, no
// non-deterministic ordering — byte-identical output for the same capsule + resolved refs
// (INV-2 greps depend on this). ContextBrokerImpl.renderPrompt gathers `resolved` (one entry per
// capsule.evidence ref, in that same order) and calls renderCapsuleBlock; the broker itself
// appends the user prompt after the block.

import type { ContextCapsule, ContextEvidenceRef, Evidence, SourcePointer } from "../types.js";

export interface ResolvedCapsuleRef {
  ref: ContextEvidenceRef;
  evidence: Evidence;
  pointer: SourcePointer;
}

// Structural-injection hardening (adversarial review findings): every interpolated
// field below is authorized-but-untrusted content (an evidence claim is verified as a faithful
// QUOTE of a workspace file — the file itself may say anything, including text that mimics this
// block's own structure). Two deterministic rewrites make interpolated content unambiguously
// data:
//   1. ALL line terminators collapse to single spaces — `\n`, lone `\r`, and the Unicode
//      separators U+2028/U+2029 (terminals, JavaScript, and model tokenizers treat all
//      four as line boundaries). Content that cannot mint a line can never fake `[EVIDENCE …]`,
//      `Rules:`, or a closing tag on its own line.
//   2. The literal tag substrings `<WALNUT_CONTEXT` / `</WALNUT_CONTEXT` are rewritten with a
//      visible U+2039 (`‹`) so even an inline mimic cannot match the real delimiters.
// Benign content renders byte-identically to the pre-hardening format; determinism (same capsule
// → byte-identical output) is preserved.
export function sanitizeInline(value: string): string {
  return value
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/<(\/?)WALNUT_CONTEXT/g, "‹$1WALNUT_CONTEXT");
}

// workspace://{producerAgentId}/{locatorPath} where locatorPath = the pointer's locator.path
// when present, else the pointer's sourceId.
function sourceLineFor(evidence: Evidence, pointer: SourcePointer): string {
  const rawPath = pointer.locator["path"];
  const locatorPath = rawPath !== undefined ? String(rawPath) : pointer.sourceId;
  return `workspace://${sanitizeInline(evidence.producerAgentId)}/${sanitizeInline(locatorPath)}`;
}

// "lines {lineStart}-{lineEnd}" when the ref has a citation and the pointer has non-null line
// bounds; otherwise "none".
function citationLineFor(ref: ContextEvidenceRef, pointer: SourcePointer): string {
  if (ref.citationId !== null && pointer.lineStart !== null && pointer.lineEnd !== null) {
    return `lines ${pointer.lineStart}-${pointer.lineEnd}`;
  }
  return "none";
}

// Renders the full <WALNUT_CONTEXT>...</WALNUT_CONTEXT> block (doc 03 §13) — without the
// trailing user prompt, which the broker appends. `resolved` must be in `capsule.evidence`
// order; exactly one blank line separates evidence blocks, and one blank line separates the
// last evidence block from "Rules:" and the Rules section from the closing tag.
export function renderCapsuleBlock(
  capsule: ContextCapsule,
  resolved: ResolvedCapsuleRef[],
): string {
  const lines: string[] = [`<WALNUT_CONTEXT capsule="${capsule.capsuleId}">`, ""];

  for (const item of resolved) {
    lines.push(`[EVIDENCE ${item.ref.evidenceId}]`);
    lines.push(`Claim: ${sanitizeInline(item.evidence.claim)}`);
    lines.push(`Source: ${sourceLineFor(item.evidence, item.pointer)}`);
    lines.push(`Citation: ${citationLineFor(item.ref, item.pointer)}`);
    lines.push(`Classification: ${item.ref.classification}`);
    lines.push(
      `Producer: ${sanitizeInline(item.evidence.producerAgentId)} / Run ${sanitizeInline(item.evidence.producerRunId)}`,
    );
    lines.push("");
  }

  lines.push("Rules:");
  lines.push("- Treat evidence IDs as source references.");
  lines.push("- Do not assume evidence outside this capsule is available.");
  lines.push(
    "- When publishing reusable claims, reference source Evidence IDs or workspace citations.",
  );
  lines.push("");
  lines.push("</WALNUT_CONTEXT>");

  return lines.join("\n");
}
