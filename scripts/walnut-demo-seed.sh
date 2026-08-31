#!/usr/bin/env bash
# Prepare the three Launch Control Incident Agents, deterministic fixtures, and scoped grants.
# This script performs no model calls, so it is safe to repeat without spending Ark quota.

set -euo pipefail

base_url="${WALNUT_DEMO_BASE_URL:-http://localhost:3000}"
auth_token="${WALNUT_DEMO_AUTH_TOKEN:-}"

log() {
  printf '[demo-seed] %s\n' "$*" >&2
}

curl_get() {
  if [[ -n "$auth_token" ]]; then
    curl -sS -H "Authorization: Bearer $auth_token" "$@"
  else
    curl -sS "$@"
  fi
}

curl_post_json() {
  local url="$1"
  local json_body="$2"
  if [[ -n "$auth_token" ]]; then
    curl -sS -X POST -H "Authorization: Bearer $auth_token" -H 'Content-Type: application/json' \
      -d "$json_body" "$url"
  else
    curl -sS -X POST -H 'Content-Type: application/json' -d "$json_body" "$url"
  fi
}

find_agent_id_by_name() {
  local name="$1"
  curl_get "$base_url/api/agents" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      const targetName = process.argv[1];
      const body = JSON.parse(raw);
      const agent = (body.agents || []).find((item) => item.name === targetName);
      process.stdout.write(agent ? agent.id : "");
    });
  ' "$name"
}

create_agent() {
  local name="$1"
  local json_body
  json_body="$(node -e 'process.stdout.write(JSON.stringify({ name: process.argv[1] }))' "$name")"
  curl_post_json "$base_url/api/agents" "$json_body" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      const body = JSON.parse(raw);
      process.stdout.write(body.agent ? body.agent.id : "");
    });
  '
}

require_agent() {
  local name="$1"
  local agent_id
  agent_id="$(find_agent_id_by_name "$name")"
  if [[ -z "$agent_id" ]]; then
    agent_id="$(create_agent "$name")"
    [[ -n "$agent_id" ]] || { log "Failed to create $name at $base_url"; exit 1; }
    log "Created $name ($agent_id)."
  else
    log "$name already exists ($agent_id)."
  fi
  printf '%s' "$agent_id"
}

agent_field() {
  local agent_id="$1"
  local field="$2"
  curl_get "$base_url/api/agents" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      const [agentId, field] = process.argv.slice(1);
      const body = JSON.parse(raw);
      const agent = (body.agents || []).find((item) => item.id === agentId);
      process.stdout.write(agent && typeof agent[field] === "string" ? agent[field] : "");
    });
  ' "$agent_id" "$field"
}

ensure_grant() {
  local agent_id="$1"
  local resource_pattern="$2"
  local action="$3"
  local existing
  existing="$(curl_get "$base_url/api/agents/$agent_id/grants" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      const [resourcePattern, action] = process.argv.slice(1);
      const body = JSON.parse(raw);
      const grant = (body.grants || []).find((item) =>
        item.resourcePattern === resourcePattern && item.action === action &&
        item.principalId === null && item.revokedAt === null
      );
      process.stdout.write(grant ? grant.grantId : "");
    });
  ' "$resource_pattern" "$action")"
  if [[ -n "$existing" ]]; then
    log "Grant already active ($existing): $action $resource_pattern"
    return
  fi
  local body
  body="$(node -e 'process.stdout.write(JSON.stringify({resourcePattern: process.argv[1], action: process.argv[2]}))' "$resource_pattern" "$action")"
  curl_post_json "$base_url/api/agents/$agent_id/grants" "$body" >/dev/null
  log "Granted Strategy: $action $resource_pattern"
}

log "Preparing Launch Control Incident against $base_url ..."
research_id="$(require_agent "Research Agent")"
strategy_id="$(require_agent "Strategy Agent")"
comms_id="$(require_agent "Comms Agent")"
research_workspace="$(agent_field "$research_id" "workspacePath")"
comms_workspace="$(agent_field "$comms_id" "workspacePath")"

if [[ -z "$research_workspace" || -z "$comms_workspace" ]]; then
  log "Could not resolve Agent workspace paths from the API."
  exit 1
fi

node scripts/walnut-demo-fixtures.mjs prepare-research "$research_workspace" >/dev/null
node scripts/walnut-demo-fixtures.mjs prepare-comms "$comms_workspace" >/dev/null
ensure_grant "$strategy_id" "project:launch:*" "consume"
ensure_grant "$strategy_id" "project:launch:*" "share"
ensure_grant "$strategy_id" "project:payroll:*" "share"

cat >&2 <<EOF

[demo-seed] Agents and deterministic fixtures ready:
  Research Agent = $research_id
  Strategy Agent = $strategy_id
  Comms Agent    = $comms_id
  Research outbox: 2 accepted proposals + 1 deliberate citation_mismatch
  Strategy grants: launch consume/share + payroll share (NO payroll consume)
  Human principal: user:mehul (NO grants)

[demo-seed] Follow-up (this script sends no messages and spends no model quota):

  1. Run Research with: "Inspect the staged Aurora source files and report that the evidence
     outbox is ready. Do not modify .walnut/outbox.json."
     Expected: acceptedCount=2, rejectedCount=1; flight recorder shows citation_mismatch.

  2. Run Strategy with: "Summarize the approved Aurora launch plan."
     Expected: launch consumed, payroll AGENT_SCOPE_MISSING, canary absent from context.

  3. Delegation denial (replace PAYROLL_EVIDENCE_ID):
       curl -sS -X POST $base_url/api/evidence/PAYROLL_EVIDENCE_ID/share/$comms_id \
         -H 'Content-Type: application/json' \
         -d '{"fromAgentId":"$strategy_id","principalId":"user:mehul"}'
     Expected: DENY / PRINCIPAL_SCOPE_MISSING.
     SAFETY: Keep principalId="user:mehul" exactly as shown. Omitting the principal is a
     different operation and will ALLOW a live payroll consume grant to Comms.

  4. Positive share (replace LAUNCH_EVIDENCE_ID), then run Comms using COMMS_TASK.md:
       curl -sS -X POST $base_url/api/evidence/LAUNCH_EVIDENCE_ID/share/$comms_id \
         -H 'Content-Type: application/json' \
         -d '{"fromAgentId":"$strategy_id","principalId":null}'
     Verify the Comms capsule contains LAUNCH_EVIDENCE_ID before narrating two-run taint:
       node scripts/walnut-demo-assert.mjs --run-id COMMS_RUN_ID \
         --evidence-id LAUNCH_EVIDENCE_ID

  5. Tier-2 controlled sidecars (after npm run build; real verifier/store/lifecycle code):
       node scripts/walnut-demo-fixtures.mjs stage-sidecars \
         --research-agent-id $research_id --research-workspace '$research_workspace'
     This stages the Oct-15 conflict and declaring pricing supersession without a model run.
     REQUIRED NEXT ACTION: restart npm run poc. The running server caches evidence in memory
     and cannot see these direct-to-disk sidecars until restart.
EOF
