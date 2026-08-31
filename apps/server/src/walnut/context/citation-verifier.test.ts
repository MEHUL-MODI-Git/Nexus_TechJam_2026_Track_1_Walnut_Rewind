import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EvidenceRepository } from "../ports.js";
import type { Citation, Evidence, SourcePointer } from "../types.js";
import { CitationVerifierImpl, quoteHashOf } from "./citation-verifier.js";

type ResolveResult =
  | { ok: true; content: string; currentHash: string; drifted: boolean }
  | { ok: false; reason: "not_found" | "unsafe_path" | "unreadable" };

class StubEvidenceRepository implements EvidenceRepository {
  constructor(private readonly resolveResults: Map<string, ResolveResult>) {}

  async getEvidence(_evidenceId: string, _version?: number): Promise<Evidence | null> {
    throw new Error("not used in this test");
  }

  async listCandidateEvidence(_query: {
    agentId: string;
    knownAt?: string;
  }): Promise<Evidence[]> {
    throw new Error("not used in this test");
  }

  async getSourcePointer(_pointerId: string): Promise<SourcePointer | null> {
    throw new Error("not used in this test");
  }

  async resolveSourceContent(pointerId: string): Promise<ResolveResult> {
    const result = this.resolveResults.get(pointerId);
    if (!result) {
      throw new Error(`no stub configured for pointer ${pointerId}`);
    }
    return result;
  }

  async getCitation(_citationId: string): Promise<Citation | null> {
    throw new Error("not used in this test");
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makePointer(overrides: Partial<SourcePointer> = {}): SourcePointer {
  return {
    pointerId: "pointer-1",
    sourceId: "source-1",
    kind: "workspace_file",
    locator: { path: "notes.txt" },
    contentHash: "sha256:content-hash-v1",
    mediaType: "text/plain",
    charStart: null,
    charEnd: null,
    lineStart: null,
    lineEnd: null,
    observedAt: "2026-08-27T00:00:00.000Z",
    classification: "INTERNAL",
    ...overrides,
  };
}

function makeCitation(overrides: Partial<Citation> = {}): Citation {
  return {
    citationId: "citation-1",
    pointerId: "pointer-1",
    quotePreview: "The launch date",
    quoteHash: "sha256:placeholder",
    charStart: 0,
    charEnd: 10,
    lineStart: null,
    lineEnd: null,
    verification: "VERIFIED",
    verifiedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

function makeVerifier(resolveResults: Map<string, ResolveResult>): CitationVerifierImpl {
  const evidenceRepository = new StubEvidenceRepository(resolveResults);
  return new CitationVerifierImpl({ evidenceRepository });
}

describe("CitationVerifierImpl.verify", () => {
  const content = "The launch date is September 14, 2026.";
  const contentHash = `sha256:${sha256Hex(content)}`;

  it("case 1: VERIFIED for an exact slice with matching hashes", async () => {
    const pointer = makePointer({ contentHash });
    const verifier = makeVerifier(
      new Map([
        ["pointer-1", { ok: true, content, currentHash: contentHash, drifted: false }],
      ]),
    );

    const quote = "September 14, 2026";
    const charStart = content.indexOf(quote);
    const charEnd = charStart + quote.length;
    expect(content.slice(charStart, charEnd)).toBe(quote);

    const result = await verifier.verify({ quote, charStart, charEnd, pointer });

    expect(result.verification).toBe("VERIFIED");
    if (result.verification === "VERIFIED") {
      expect(result.quoteHash).toBe(quoteHashOf(quote));
    }
  });

  it("case 2: MISMATCH on off-by-one offsets, and detail does not contain the quote text", async () => {
    const pointer = makePointer({ contentHash });
    const verifier = makeVerifier(
      new Map([
        ["pointer-1", { ok: true, content, currentHash: contentHash, drifted: false }],
      ]),
    );

    const quote = "September 14, 2026";
    const charStart = content.indexOf(quote);
    const charEnd = charStart + quote.length;

    const result = await verifier.verify({
      quote,
      charStart: charStart + 1,
      charEnd: charEnd + 1,
      pointer,
    });

    expect(result.verification).toBe("MISMATCH");
    if (result.verification !== "VERIFIED") {
      expect(result.detail).not.toContain(quote);
    }
  });

  it("case 3: MISMATCH when the quote differs by trailing whitespace only", async () => {
    const pointer = makePointer({ contentHash });
    const verifier = makeVerifier(
      new Map([
        ["pointer-1", { ok: true, content, currentHash: contentHash, drifted: false }],
      ]),
    );

    const quote = "September 14, 2026";
    const charStart = content.indexOf(quote);
    const charEnd = charStart + quote.length;

    const result = await verifier.verify({
      quote: `${quote} `,
      charStart,
      charEnd,
      pointer,
    });

    expect(result.verification).toBe("MISMATCH");
  });

  it("case 4: MISMATCH when the quote differs by case only", async () => {
    const pointer = makePointer({ contentHash });
    const verifier = makeVerifier(
      new Map([
        ["pointer-1", { ok: true, content, currentHash: contentHash, drifted: false }],
      ]),
    );

    const quote = "September 14, 2026";
    const charStart = content.indexOf(quote);
    const charEnd = charStart + quote.length;

    const result = await verifier.verify({
      quote: quote.toLowerCase(),
      charStart,
      charEnd,
      pointer,
    });

    expect(result.verification).toBe("MISMATCH");
  });

  it("case 5: DRIFTED when currentHash differs from pointer.contentHash even if the slice matches", async () => {
    const pointer = makePointer({ contentHash: "sha256:stale-hash" });
    const verifier = makeVerifier(
      new Map([
        ["pointer-1", { ok: true, content, currentHash: contentHash, drifted: true }],
      ]),
    );

    const quote = "September 14, 2026";
    const charStart = content.indexOf(quote);
    const charEnd = charStart + quote.length;
    // The slice WOULD match if we got that far - drift must still take priority.
    expect(content.slice(charStart, charEnd)).toBe(quote);

    const result = await verifier.verify({ quote, charStart, charEnd, pointer });

    expect(result.verification).toBe("DRIFTED");
  });

  it("case 6: UNAVAILABLE when resolve fails, and detail carries the reason", async () => {
    const pointer = makePointer({ contentHash });
    const verifier = makeVerifier(
      new Map([["pointer-1", { ok: false, reason: "not_found" }]]),
    );

    const result = await verifier.verify({
      quote: "anything",
      charStart: 0,
      charEnd: 8,
      pointer,
    });

    expect(result.verification).toBe("UNAVAILABLE");
    if (result.verification !== "VERIFIED") {
      expect(result.detail).toContain("not_found");
    }
  });

  it("case 7a: decision order - resolve fails AND hash would differ -> UNAVAILABLE (order 1 before 2)", async () => {
    // pointer.contentHash is irrelevant here because resolve itself fails first.
    const pointer = makePointer({ contentHash: "sha256:whatever" });
    const verifier = makeVerifier(
      new Map([["pointer-1", { ok: false, reason: "unreadable" }]]),
    );

    const result = await verifier.verify({
      quote: "anything",
      charStart: 0,
      charEnd: 8,
      pointer,
    });

    expect(result.verification).toBe("UNAVAILABLE");
  });

  it("case 7b: decision order - drifted AND slice mismatch -> DRIFTED (order 2 before 3)", async () => {
    const pointer = makePointer({ contentHash: "sha256:stale-hash" });
    const verifier = makeVerifier(
      new Map([
        ["pointer-1", { ok: true, content, currentHash: contentHash, drifted: true }],
      ]),
    );

    // A quote that would ALSO mismatch the slice, so DRIFTED must win regardless.
    const result = await verifier.verify({
      quote: "this quote does not appear in content",
      charStart: 0,
      charEnd: 10,
      pointer,
    });

    expect(result.verification).toBe("DRIFTED");
  });

  it("case 8: unicode - JS slice() operates on UTF-16 code units; quoteHash is over UTF-8 bytes", async () => {
    const unicodeContent = "café costs €5";
    const unicodeHash = `sha256:${sha256Hex(unicodeContent)}`;
    const pointer = makePointer({ contentHash: unicodeHash });
    const verifier = makeVerifier(
      new Map([
        [
          "pointer-1",
          { ok: true, content: unicodeContent, currentHash: unicodeHash, drifted: false },
        ],
      ]),
    );

    const quote = "café";
    const charStart = 0;
    const charEnd = 4;
    expect(unicodeContent.slice(charStart, charEnd)).toBe(quote);

    const result = await verifier.verify({ quote, charStart, charEnd, pointer });

    expect(result.verification).toBe("VERIFIED");
    if (result.verification === "VERIFIED") {
      const expectedHash = `sha256:${createHash("sha256").update(Buffer.from(quote, "utf8")).digest("hex")}`;
      expect(result.quoteHash).toBe(expectedHash);
      expect(result.quoteHash).toBe(quoteHashOf(quote));
    }
  });
});

describe("CitationVerifierImpl.recheck", () => {
  const content = "The launch date is September 14, 2026.";
  const contentHash = `sha256:${sha256Hex(content)}`;
  const quote = "September 14, 2026";
  const charStart = content.indexOf(quote);
  const charEnd = charStart + quote.length;

  it("VERIFIED for a citation whose quoteHash matches the current slice", async () => {
    const pointer = makePointer({ contentHash });
    const verifier = makeVerifier(
      new Map([
        ["pointer-1", { ok: true, content, currentHash: contentHash, drifted: false }],
      ]),
    );
    const citation = makeCitation({
      pointerId: "pointer-1",
      charStart,
      charEnd,
      quoteHash: quoteHashOf(quote),
    });

    const result = await verifier.recheck({ citation, pointer });

    expect(result).toBe("VERIFIED");
  });

  it("MISMATCH when the stored quoteHash is for different text", async () => {
    const pointer = makePointer({ contentHash });
    const verifier = makeVerifier(
      new Map([
        ["pointer-1", { ok: true, content, currentHash: contentHash, drifted: false }],
      ]),
    );
    const citation = makeCitation({
      pointerId: "pointer-1",
      charStart,
      charEnd,
      quoteHash: quoteHashOf("some completely different text"),
    });

    const result = await verifier.recheck({ citation, pointer });

    expect(result).toBe("MISMATCH");
  });

  it("DRIFTED when the hash comparison fails", async () => {
    const pointer = makePointer({ contentHash: "sha256:stale-hash" });
    const verifier = makeVerifier(
      new Map([
        ["pointer-1", { ok: true, content, currentHash: contentHash, drifted: true }],
      ]),
    );
    const citation = makeCitation({
      pointerId: "pointer-1",
      charStart,
      charEnd,
      quoteHash: quoteHashOf(quote),
    });

    const result = await verifier.recheck({ citation, pointer });

    expect(result).toBe("DRIFTED");
  });

  it("UNAVAILABLE when citation.charStart is null (cannot re-slice)", async () => {
    const pointer = makePointer({ contentHash });
    const verifier = makeVerifier(
      new Map([
        ["pointer-1", { ok: true, content, currentHash: contentHash, drifted: false }],
      ]),
    );
    const citation = makeCitation({
      pointerId: "pointer-1",
      charStart: null,
      charEnd: null,
      quoteHash: quoteHashOf(quote),
    });

    const result = await verifier.recheck({ citation, pointer });

    expect(result).toBe("UNAVAILABLE");
  });
});
