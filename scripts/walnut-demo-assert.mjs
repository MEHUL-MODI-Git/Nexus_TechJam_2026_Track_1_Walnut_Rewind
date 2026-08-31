#!/usr/bin/env node

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const runId = option("--run-id");
const evidenceId = option("--evidence-id");
const baseUrl = option("--base-url", process.env.WALNUT_DEMO_BASE_URL ?? "http://localhost:3000");
const authToken = option("--auth-token", process.env.WALNUT_DEMO_AUTH_TOKEN ?? "");

if (!runId || !evidenceId) {
  process.stderr.write(
    "usage: walnut-demo-assert.mjs --run-id <uuid> --evidence-id <ev_id> [--base-url <url>]\n",
  );
  process.exit(1);
}

const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
const response = await fetch(`${baseUrl}/api/runs/${runId}/capsule`, { headers });
if (!response.ok) {
  process.stderr.write(`capsule request failed: HTTP ${response.status} ${await response.text()}\n`);
  process.exit(1);
}

const { capsule } = await response.json();
const reference = capsule.evidence.find((item) => item.evidenceId === evidenceId);
if (!reference) {
  process.stderr.write(
    `assertion failed: capsule ${capsule.capsuleId} does not contain ${evidenceId}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  JSON.stringify({
    ok: true,
    runId,
    capsuleId: capsule.capsuleId,
    capsuleHash: capsule.capsuleHash,
    evidenceId: reference.evidenceId,
    evidenceVersion: reference.evidenceVersion,
    authorizationDecisionId: reference.authorizationDecisionId,
  }) + "\n",
);
