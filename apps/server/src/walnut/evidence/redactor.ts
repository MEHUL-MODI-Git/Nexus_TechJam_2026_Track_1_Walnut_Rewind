export const REDACTION_MARKER = "[REDACTED]";
export const REDACTOR_VERSION = "walnut-redactor-v1";

export type RedactionCategory =
  | "credential"
  | "bearer_token"
  | "private_key"
  | "env_value"
  | "high_entropy"
  | "secret_filename";

export interface RedactionResult {
  safeValue: unknown;
  categories: RedactionCategory[];
  replacementCount: number;
}

export interface RedactorOptions {
  environment?: NodeJS.ProcessEnv;
  knownSecretValues?: Iterable<string>;
  canaryValues?: Iterable<string>;
}

const CATEGORY_ORDER: readonly RedactionCategory[] = [
  "credential",
  "bearer_token",
  "private_key",
  "env_value",
  "high_entropy",
  "secret_filename",
];

const SENSITIVE_ENVIRONMENT_NAME =
  /(?:API[_-]?KEY|AUTH|BEARER|CREDENTIAL|PASSWORD|PRIVATE[_-]?KEY|SECRET|TOKEN|ARK_MODEL)/i;

interface RedactionState {
  categories: Set<RedactionCategory>;
  replacementCount: number;
}

interface ReplacementRule {
  category: RedactionCategory;
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

// Walnut-minted identifiers (spec 001 §2 prefix table + randomUUID) are structurally non-secret
// and must survive redaction — ledger payloads reference decisions/evidence/grants by these ids,
// and redacting them destroys audit traceability (found via P2-C3's evidence.shared events).
// This exempts ONLY the high-entropy heuristic: a walnut-id-shaped string that matches a known
// secret value or any other category still redacts.
const WALNUT_ID_PATTERN =
  /^(?:art|auth|av|cap|cit|clar|ev|grant|levt|ptr|rec|revt)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksHighEntropy(value: string): boolean {
  if (value.length < 32 || /^[a-f0-9]{64}$/i.test(value)) return false;
  if (WALNUT_ID_PATTERN.test(value)) return false;
  const classCount = [/[a-z]/, /[A-Z]/, /\d/, /[._~+/=-]/].filter((pattern) =>
    pattern.test(value),
  ).length;
  return classCount >= 3 && shannonEntropy(value) >= 4;
}

function sensitiveEnvironmentValues(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment)
    .filter(([name, value]) =>
      Boolean(value && value.length >= 4 && SENSITIVE_ENVIRONMENT_NAME.test(name)),
    )
    .map(([, value]) => value as string);
}

function uniqueUsableValues(values: Iterable<string>): string[] {
  return [...new Set(values)]
    .filter((value) => value.length >= 4 && value !== REDACTION_MARKER)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

export class Redactor {
  private readonly knownSecretValues: readonly string[];
  private readonly canaryValues: readonly string[];

  constructor(options: RedactorOptions = {}) {
    const environment = options.environment ?? process.env;
    this.knownSecretValues = uniqueUsableValues([
      ...sensitiveEnvironmentValues(environment),
      ...(options.knownSecretValues ?? []),
    ]);
    this.canaryValues = uniqueUsableValues(options.canaryValues ?? []);
  }

  redact(value: unknown): RedactionResult {
    const state: RedactionState = {
      categories: new Set<RedactionCategory>(),
      replacementCount: 0,
    };
    const safeValue = this.redactValue(value, state, new WeakSet<object>());
    return {
      safeValue,
      categories: CATEGORY_ORDER.filter((category) => state.categories.has(category)),
      replacementCount: state.replacementCount,
    };
  }

  private redactValue(
    value: unknown,
    state: RedactionState,
    ancestors: WeakSet<object>,
  ): unknown {
    if (typeof value === "string") return this.redactString(value, state);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("Redactor only accepts JSON values");
      return value;
    }
    if (typeof value !== "object") {
      throw new TypeError("Redactor only accepts JSON values");
    }
    if (ancestors.has(value)) throw new TypeError("Redactor does not accept cyclic values");
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      throw new TypeError("Redactor does not accept objects with toJSON methods");
    }

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const safeArray: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(value, index)) {
            throw new TypeError("Redactor does not accept array holes");
          }
          safeArray.push(this.redactValue(value[index], state, ancestors));
        }
        return safeArray;
      }

      const prototype = Object.getPrototypeOf(value) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Redactor only accepts plain objects");
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError("Redactor object keys must be strings");
      }

      const safeObject: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;
      for (const [rawKey, rawValue] of Object.entries(value)) {
        const safeKey = this.redactString(rawKey, state);
        if (Object.prototype.hasOwnProperty.call(safeObject, safeKey)) {
          throw new Error("Redaction produced duplicate object keys");
        }
        safeObject[safeKey] = this.redactValue(rawValue, state, ancestors);
      }
      return safeObject;
    } finally {
      ancestors.delete(value);
    }
  }

  private redactString(input: string, state: RedactionState): string {
    let output = input;
    const rules: ReplacementRule[] = [
      {
        category: "private_key",
        pattern:
          /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
        replacement: REDACTION_MARKER,
      },
      {
        category: "bearer_token",
        pattern: /\bAuthorization\s*:\s*Bearer\s+[^\s"']+/gi,
        replacement: `Authorization: Bearer ${REDACTION_MARKER}`,
      },
      {
        category: "credential",
        pattern: /\bARK_API_KEY\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi,
        replacement: `ARK_API_KEY=${REDACTION_MARKER}`,
      },
      {
        category: "credential",
        pattern:
          /\b(?:sk-(?:proj-)?|ghp_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{12,}\b/g,
        replacement: REDACTION_MARKER,
      },
      {
        category: "env_value",
        pattern:
          /(^|[\r\n])([ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/g,
        replacement: (_match, boundary, assignment) =>
          `${boundary}${assignment}${REDACTION_MARKER}`,
      },
    ];

    for (const rule of rules) {
      output = output.replace(rule.pattern, (...arguments_) => {
        const match = arguments_[0] as string;
        const replacement =
          typeof rule.replacement === "string"
            ? rule.replacement
            : rule.replacement(
                match,
                ...(arguments_.slice(1, -2) as string[]),
              );
        if (replacement === match) return match;
        state.categories.add(rule.category);
        state.replacementCount += 1;
        return replacement;
      });
    }

    output = this.replaceKnownValues(
      output,
      this.canaryValues,
      "credential",
      state,
    );
    output = this.replaceKnownValues(
      output,
      this.knownSecretValues,
      "env_value",
      state,
    );

    return output.replace(/[A-Za-z0-9][A-Za-z0-9._~+/=-]{31,}/g, (candidate) => {
      if (!looksHighEntropy(candidate)) return candidate;
      state.categories.add("high_entropy");
      state.replacementCount += 1;
      return REDACTION_MARKER;
    });
  }

  private replaceKnownValues(
    input: string,
    values: readonly string[],
    category: RedactionCategory,
    state: RedactionState,
  ): string {
    let output = input;
    for (const value of values) {
      const pattern = new RegExp(escapeRegExp(value), "g");
      output = output.replace(pattern, () => {
        state.categories.add(category);
        state.replacementCount += 1;
        return REDACTION_MARKER;
      });
    }
    return output;
  }
}
