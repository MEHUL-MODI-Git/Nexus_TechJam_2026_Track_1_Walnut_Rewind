// CitationVerifierImpl (spec 003 §B3) — HC-6: a citation is verified by exact byte match,
// `source[start:end] === quote`, never fuzzy, never normalized, regardless of model confidence
// (INV-5). This is the enforcement point the product's evidence thesis rests on.
//
// Decision order for `verify` (pinned, spec 003 §B3, first match wins):
//   1. resolveSourceContent(pointer.pointerId) fails                 -> UNAVAILABLE
//   2. resolved.currentHash !== pointer.contentHash                  -> DRIFTED   (INV-19)
//   3. content.slice(charStart, charEnd) !== quote (exact string ==) -> MISMATCH
//   4. otherwise                                                     -> VERIFIED
// `recheck` follows the same order; step 3 compares a freshly computed hash of the slice
// against the citation's stored `quoteHash` (the full original quote is never stored, only
// `quotePreview` + `quoteHash`).

import { createHash } from "node:crypto";
import type { CitationVerifier as CitationVerifierPort, EvidenceRepository } from "../ports.js";
import type { Citation, CitationVerification, SourcePointer } from "../types.js";

export function quoteHashOf(quote: string): string {
  return `sha256:${createHash("sha256").update(quote, "utf8").digest("hex")}`;
}

export class CitationVerifierImpl implements CitationVerifierPort {
  constructor(private readonly deps: { evidenceRepository: EvidenceRepository }) {}

  async verify(input: {
    quote: string;
    charStart: number;
    charEnd: number;
    pointer: SourcePointer;
  }): Promise<
    | { verification: "VERIFIED"; quoteHash: string }
    | { verification: "MISMATCH" | "DRIFTED" | "UNAVAILABLE"; detail: string }
  > {
    const resolved = await this.deps.evidenceRepository.resolveSourceContent(
      input.pointer.pointerId,
    );

    if (!resolved.ok) {
      return {
        verification: "UNAVAILABLE",
        detail: `source content unavailable: ${resolved.reason}`,
      };
    }

    if (resolved.currentHash !== input.pointer.contentHash) {
      return {
        verification: "DRIFTED",
        detail:
          `source content hash changed since the pointer was recorded ` +
          `(pointer.contentHash=${input.pointer.contentHash}, current=${resolved.currentHash})`,
      };
    }

    const slice = resolved.content.slice(input.charStart, input.charEnd);
    if (slice !== input.quote) {
      return {
        verification: "MISMATCH",
        detail:
          `quote did not exact-match content[${input.charStart}:${input.charEnd}] ` +
          `(slice length ${slice.length}, quote length ${input.quote.length})`,
      };
    }

    return { verification: "VERIFIED", quoteHash: quoteHashOf(input.quote) };
  }

  async recheck(input: {
    citation: Citation;
    pointer: SourcePointer;
  }): Promise<CitationVerification> {
    const { citation, pointer } = input;

    if (citation.charStart === null || citation.charEnd === null) {
      return "UNAVAILABLE";
    }

    const resolved = await this.deps.evidenceRepository.resolveSourceContent(pointer.pointerId);
    if (!resolved.ok) {
      return "UNAVAILABLE";
    }

    if (resolved.currentHash !== pointer.contentHash) {
      return "DRIFTED";
    }

    const slice = resolved.content.slice(citation.charStart, citation.charEnd);
    const sliceHash = quoteHashOf(slice);
    if (sliceHash !== citation.quoteHash) {
      return "MISMATCH";
    }

    return "VERIFIED";
  }
}
