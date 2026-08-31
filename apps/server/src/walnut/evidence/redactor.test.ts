import { describe, expect, it } from "vitest";
import { REDACTION_MARKER, Redactor } from "./redactor.js";

const ARK_CANARY = "walnut-test-ark-canary-value-8Qv3xK2m";
const BEARER_CANARY = "walnut.test.bearer.canary.9Zp4yN7w";
const ENV_CANARY = "walnut-test-env-canary-value-6Hs8cR1q";
const PEM_CANARY = [
  "-----BEGIN PRIVATE KEY-----",
  "walnut-test-private-key-canary-4Fj7mT2s",
  "-----END PRIVATE KEY-----",
].join("\n");

describe("Redactor", () => {
  it("removes the four planted INV-16 canaries from a nested payload", () => {
    const redactor = new Redactor({
      environment: { WALNUT_TEST_SECRET: ENV_CANARY },
    });
    const rawPayload = {
      ark: `ARK_API_KEY=${ARK_CANARY}`,
      request: { authorization: `Authorization: Bearer ${BEARER_CANARY}` },
      privateKey: PEM_CANARY,
      environment: ["SAFE=value", `WALNUT_TEST_SECRET=${ENV_CANARY}`],
    };

    const result = redactor.redact(rawPayload);
    const persistedCandidate = JSON.stringify(result.safeValue);

    for (const canary of [ARK_CANARY, BEARER_CANARY, ENV_CANARY, PEM_CANARY]) {
      expect(persistedCandidate).not.toContain(canary);
    }
    expect(result.categories).toEqual([
      "credential",
      "bearer_token",
      "private_key",
      "env_value",
    ]);
    expect(result.replacementCount).toBe(5);
  });

  it("redacts common API-key prefixes and conservative high-entropy tokens", () => {
    const redactor = new Redactor({ environment: {} });
    const prefixedCanary = `ghp_${"A1b2".repeat(6)}`;
    const entropyCanary = "Ab9_xY7-pQ2+Lm4.Nv8=Rs6_Tk3-Zc5-Wd1";

    const result = redactor.redact({ prefixedCanary, entropyCanary });

    expect(result.safeValue).toEqual({
      prefixedCanary: REDACTION_MARKER,
      entropyCanary: REDACTION_MARKER,
    });
    expect(result.categories).toEqual(["credential", "high_entropy"]);
  });

  it("redacts known values in both object keys and values without mutating input", () => {
    const known = "known-secret-value-W7q3";
    const redactor = new Redactor({
      environment: {},
      knownSecretValues: [known],
    });
    const raw = { [`key-${known}`]: { value: known } };

    const result = redactor.redact(raw);

    expect(result.safeValue).toEqual({
      [`key-${REDACTION_MARKER}`]: { value: REDACTION_MARKER },
    });
    expect(raw).toEqual({ [`key-${known}`]: { value: known } });
    expect(result.replacementCount).toBe(2);
  });

  it("redacts explicitly planted canary values", () => {
    const canary = "walnut-explicit-canary-5Dx9qL3v";
    const redactor = new Redactor({ environment: {}, canaryValues: [canary] });

    expect(redactor.redact(`before:${canary}:after`)).toEqual({
      safeValue: `before:${REDACTION_MARKER}:after`,
      categories: ["credential"],
      replacementCount: 1,
    });
  });

  it("keeps ordinary values and SHA-256 hashes intact", () => {
    const redactor = new Redactor({ environment: {} });
    const hash = "a3".repeat(32);
    const raw = { status: "completed", hash, count: 2, nullable: null };

    expect(redactor.redact(raw)).toEqual({
      safeValue: raw,
      categories: [],
      replacementCount: 0,
    });
  });

  it.each([
    ["undefined", { unsafe: undefined }],
    ["non-finite number", Number.NaN],
    ["Date", new Date("2026-08-27T00:00:00.000Z")],
    ["function", () => undefined],
  ])("throws on non-JSON %s so the caller can emit hash-only failure", (_label, value) => {
    expect(() => new Redactor({ environment: {} }).redact(value)).toThrow(TypeError);
  });

  it("rejects holes and cycles but permits repeated references", () => {
    const redactor = new Redactor({ environment: {} });
    const withHole = new Array<unknown>(1);
    expect(() => redactor.redact(withHole)).toThrow("array holes");

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => redactor.redact(cyclic)).toThrow("cyclic");

    const shared = { value: "safe" };
    expect(redactor.redact([shared, shared]).safeValue).toEqual([shared, shared]);
  });

  it("throws rather than overwrite when redacted keys collide", () => {
    const redactor = new Redactor({
      environment: {},
      knownSecretValues: ["known-secret-left", "known-secret-right"],
    });
    const raw = {
      "key-known-secret-left": 1,
      "key-known-secret-right": 2,
    };

    expect(() => redactor.redact(raw)).toThrow("duplicate object keys");
  });

  it("never high-entropy-redacts walnut-minted ids, but other categories still apply to them", () => {
    const redactor = new Redactor({ environment: {} });
    // Walnut-minted ids (spec 001 §2 prefixes + uuid) are audit references, not secrets —
    // ledger payloads must keep them resolvable (found via P2-C3 evidence.shared events).
    const payload = {
      senderDecisionId: "auth_9f8b7c6d-4e3a-42b1-9c0d-1a2b3c4d5e6f",
      evidenceId: "ev_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      grantId: "grant_ffeeddcc-bbaa-4998-8776-655443322110",
    };
    expect(redactor.redact(payload).safeValue).toEqual(payload);

    // A genuinely high-entropy token of the same length still redacts.
    const secretish = { token: "aB3xQ9-dE5fKw2-Gh7iZp4-Jk9lRt6-Mn1oVs8" };
    const result = redactor.redact(secretish);
    expect(result.replacementCount).toBeGreaterThan(0);
    expect(JSON.stringify(result.safeValue)).not.toContain("aB3xQ9");

    // And a walnut-id-shaped string that IS a known secret value still redacts (the exemption
    // is scoped to the high-entropy heuristic only).
    const knowing = new Redactor({
      environment: {},
      knownSecretValues: ["auth_9f8b7c6d-4e3a-42b1-9c0d-1a2b3c4d5e6f"],
    });
    expect(JSON.stringify(knowing.redact(payload).safeValue)).not.toContain(
      "auth_9f8b7c6d-4e3a-42b1-9c0d-1a2b3c4d5e6f",
    );
  });
});
