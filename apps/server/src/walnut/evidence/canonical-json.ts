function canonicalize(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON only accepts finite numbers");
    }
    return JSON.stringify(value);
  }

  if (typeof value !== "object") {
    throw new TypeError("Canonical JSON only accepts JSON values");
  }

  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON does not accept cyclic values");
  }

  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    throw new TypeError("Canonical JSON does not accept objects with toJSON methods");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError("Canonical JSON does not accept array holes");
        }
        items.push(canonicalize(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON only accepts plain objects");
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Canonical JSON object keys must be strings");
    }

    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const serialized = canonicalize(
          (value as Record<string, unknown>)[key],
          ancestors,
        );
        return `${JSON.stringify(key)}:${serialized}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, new WeakSet<object>());
}
