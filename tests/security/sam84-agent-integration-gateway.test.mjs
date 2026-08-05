import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AGENT_GATEWAY_POLICIES,
  AgentGatewayError,
  buildAgentGatewayDispatch,
  serializeAgentGatewayPayloadForPostgres,
} from "../../src/lib/agent-gateway-core.mjs";
import { createHash } from "node:crypto";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const actor = "11111111-1111-4111-8111-111111111111";
const organization = "22222222-2222-4222-8222-222222222222";
const key = "sam84-test-signing-key-at-least-thirty-two-characters";
const fixedNow = new Date("2026-08-06T00:00:00.000Z");

function dispatch(command, payload = { subject: "synthetic" }) {
  return buildAgentGatewayDispatch({
    actorUserId: actor, organizationId: organization, input: { command, payload },
    now: fixedNow, signingKey: key,
  });
}

test("SAM-84 policy is a closed L0-L4 allowlist and every external adapter is disabled", () => {
  assert.deepEqual(Object.keys(AGENT_GATEWAY_POLICIES), [
    "agent.policy.describe", "agent.tenant.summary", "agent.draft.create",
    "agent.external.send.request", "agent.authorization.change",
  ]);
  assert.deepEqual(Object.values(AGENT_GATEWAY_POLICIES).map((policy) => policy.riskLevel), ["L0", "L1", "L2", "L3", "L4"]);
  assert.ok(Object.values(AGENT_GATEWAY_POLICIES).every((policy) => policy.adapter === "disabled"));
  assert.equal(AGENT_GATEWAY_POLICIES["agent.authorization.change"].capability, null);
});

test("SAM-84 server constructs authoritative context, signature and five-minute credential fingerprint", () => {
  const first = dispatch("agent.tenant.summary", { b: 2, a: 1 });
  const replay = dispatch("agent.tenant.summary", { a: 1, b: 2 });
  assert.equal(first.actorUserId, actor);
  assert.equal(first.organizationId, organization);
  assert.equal(first.channel, "server_agent_gateway");
  assert.match(first.correlationId, /^[0-9a-f-]{36}$/);
  assert.match(first.idempotencyKey, /^agt_[0-9a-f]{56}$/);
  assert.equal(first.idempotencyKey, replay.idempotencyKey, "canonical equal payloads must replay idempotently");
  assert.match(first.eventSignature, /^[0-9a-f]{64}$/);
  assert.match(first.credentialFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(first.credentialExpiresAt, "2026-08-06T00:05:00.000Z");
  assert.notEqual(first.correlationId, replay.correlationId);
  assert.notEqual(first.eventSignature, replay.eventSignature);
});

test("SAM-84 hashes the exact PostgreSQL JSONB text representation", () => {
  const payload = { z: [true, null, { bb: "synthetic", a: 1 }], aa: { b: 2, a: "x" } };
  const postgresText = '{"z": [true, null, {"a": 1, "bb": "synthetic"}], "aa": {"a": "x", "b": 2}}';
  assert.equal(serializeAgentGatewayPayloadForPostgres(payload), postgresText);
  const result = dispatch("agent.tenant.summary", payload);
  assert.equal(result.payloadSha256, createHash("sha256").update(postgresText).digest("hex"));
  assert.throws(
    () => serializeAgentGatewayPayloadForPostgres({ value: Number.NaN }),
    (error) => error instanceof AgentGatewayError && error.code === "agent_payload_invalid",
  );
});

test("SAM-84 rejects client authority, unknown commands, oversized payloads and missing signing key", () => {
  assert.throws(
    () => buildAgentGatewayDispatch({ actorUserId: actor, organizationId: organization, input: {
      command: "agent.tenant.summary", payload: {}, actor_user_id: actor,
    }, now: fixedNow, signingKey: key }),
    (error) => error instanceof AgentGatewayError && error.code === "agent_gateway_request_invalid",
  );
  assert.throws(
    () => dispatch("agent.webhook.send"),
    (error) => error instanceof AgentGatewayError && error.code === "agent_command_not_allowlisted",
  );
  assert.throws(
    () => dispatch("agent.draft.create", { text: "x".repeat(16 * 1024 + 1) }),
    (error) => error instanceof AgentGatewayError && error.code === "agent_payload_too_large",
  );
  assert.throws(
    () => buildAgentGatewayDispatch({ actorUserId: actor, organizationId: organization, input: {
      command: "agent.policy.describe", payload: {},
    }, now: fixedNow, signingKey: "too-short" }),
    (error) => error instanceof AgentGatewayError && error.code === "agent_gateway_signing_unavailable",
  );
});

test("SAM-84 database boundary is server-only, signed, immutable and L3 approval-bound", async () => {
  const [migration, rollback, route] = await Promise.all([
    read("supabase/migrations/20260806000000_sam84_controlled_agent_integration_gateway.sql"),
    read("supabase/rollback/20260806000000_sam84_controlled_agent_integration_gateway_rollback.sql"),
    read("src/app/api/agent/commands/route.ts"),
  ]);
  for (const marker of [
    "agent_gateway_commands", "agent_gateway_events", "agent_gateway_adapter_registry",
    "agent_gateway_l3_approval_required", "agent_gateway_l4_denied",
    "agent_gateway_short_lived_credential", "v4_dispatch_agent_gateway_command",
    "agent_gateway_server_role_required", "v4_actor_has_capability",
    "command.approval_bound", "command.denied", "adapter_state = 'disabled'",
  ]) assert.ok(migration.includes(marker), `missing migration marker ${marker}`);
  assert.match(migration, /REVOKE ALL ON TABLE public\.agent_gateway_commands, public\.agent_gateway_events,[\s\S]+FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.v4_dispatch_agent_gateway_command[\s\S]+TO service_role/);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION public\.v4_dispatch_agent_gateway_command[\s\S]+TO authenticated/);
  assert.match(rollback, /sam84_agent_gateway_rollback_requires_staging_or_test/);
  assert.match(rollback, /sam84_agent_gateway_rollback_evidence_present/);
  assert.match(route, /getRequestAuthContext\(request\)/);
  assert.match(route, /getRequestedOrganizationId\(request\)/);
  assert.match(route, /buildAgentGatewayDispatch/);
  assert.match(route, /supabaseAdmin\.rpc\([\s\S]*v4_dispatch_agent_gateway_command/);
  assert.doesNotMatch(route, /\.from\(/);
  assert.doesNotMatch(route, /SUPABASE_SERVICE_ROLE_KEY/);
});
