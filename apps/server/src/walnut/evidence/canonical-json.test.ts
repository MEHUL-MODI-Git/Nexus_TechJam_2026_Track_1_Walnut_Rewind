import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const first = {
      z: [{ beta: 2, alpha: 1 }, "second"],
      a: { delta: true, gamma: null },
    };
    const reordered = {
      a: { gamma: null, delta: true },
      z: [{ alpha: 1, beta: 2 }, "second"],
    };

    expect(canonicalJson(first)).toBe(canonicalJson(reordered));
    expect(canonicalJson(first)).toBe(
      '{"a":{"delta":true,"gamma":null},"z":[{"alpha":1,"beta":2},"second"]}',
    );
  });

  it("uses JSON.stringify scalar escaping and number formatting", () => {
    expect(canonicalJson({ text: "line\n\u0000", negativeZero: -0 })).toBe(
      '{"negativeZero":0,"text":"line\\n\\u0000"}',
    );
  });

  it("accepts null-prototype objects and repeated non-cyclic references", () => {
    const shared = { value: 1 };
    const nullPrototype = Object.assign(Object.create(null) as object, {
      second: shared,
      first: shared,
    });

    expect(canonicalJson(nullPrototype)).toBe(
      '{"first":{"value":1},"second":{"value":1}}',
    );
  });

  it.each([
    ["undefined object value", { value: undefined }],
    ["undefined array value", [undefined]],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["bigint", 1n],
    ["function", () => undefined],
    ["symbol", Symbol("value")],
    ["Date", new Date("2026-08-27T00:00:00.000Z")],
    ["Map", new Map()],
    ["Set", new Set()],
    ["RegExp", /value/],
    ["typed array", new Uint8Array([1, 2])],
    ["class instance", new (class Example {})()],
    ["toJSON method", { value: 1, toJSON: () => ({ value: 1 }) }],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it("rejects an array hole", () => {
    const withHole = new Array<unknown>(1);
    expect(() => canonicalJson(withHole)).toThrow("array holes");
  });

  it("rejects cycles but permits repeated references", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("cyclic");

    const shared = { nested: true };
    expect(canonicalJson([shared, shared])).toBe(
      '[{"nested":true},{"nested":true}]',
    );
  });

  it("rejects symbol-keyed plain objects", () => {
    expect(() => canonicalJson({ [Symbol("secret")]: "value" })).toThrow(
      "keys must be strings",
    );
  });
});
