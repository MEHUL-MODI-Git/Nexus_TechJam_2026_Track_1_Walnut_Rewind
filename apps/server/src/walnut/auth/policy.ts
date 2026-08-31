// Policy source for the authorization evaluator (spec 003 §B3). Injectable — tests pin their
// own WalnutPolicy instance; `defaultPolicy` is the default wiring for the app.

import { createHash } from "node:crypto";
import type { Classification } from "../types.js";
import { canonicalJson } from "../evidence/canonical-json.js";

export interface WalnutPolicy {
  revision: number;
  denyAgentIds: string[];
  classificationCeilings: Record<string, Classification>;
}

// Empty deny list, empty ceilings map — every agent defaults to a RESTRICTED ceiling (no ceiling).
export const defaultPolicy: WalnutPolicy = {
  revision: 1,
  denyAgentIds: [],
  classificationCeilings: {},
};

export function policyHash(policy: WalnutPolicy): string {
  const digest = createHash("sha256").update(canonicalJson(policy), "utf8").digest("hex");
  return `sha256:${digest}`;
}

export default defaultPolicy;
