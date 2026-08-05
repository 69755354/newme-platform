import { createHmac, createHash, randomUUID } from "node:crypto";

export const AGENT_GATEWAY_POLICIES = Object.freeze({
  "agent.policy.describe": Object.freeze({ riskLevel: "L0", capability: "shared.operations.read", accessMode: "read", adapter: "disabled" }),
  "agent.tenant.summary": Object.freeze({ riskLevel: "L1", capability: "shared.operations.read", accessMode: "read", adapter: "disabled" }),
  "agent.draft.create": Object.freeze({ riskLevel: "L2", capability: "shared.work.write", accessMode: "write", adapter: "disabled" }),
  "agent.external.send.request": Object.freeze({ riskLevel: "L3", capability: "shared.approvals.request", accessMode: "write", adapter: "disabled" }),
  "agent.authorization.change": Object.freeze({ riskLevel: "L4", capability: null, accessMode: "write", adapter: "disabled" }),
});

const COMMAND_PATTERN = /^[a-z][a-z0-9_.-]{2,95}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const CREDENTIAL_TTL_SECONDS = 300;

export class AgentGatewayError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "AgentGatewayError";
    this.code = code;
    this.status = status;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalizeAgentGatewayPayload(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeAgentGatewayPayload).join(",")}]`;
  if (!isPlainObject(value)) throw new AgentGatewayError("agent_payload_invalid");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeAgentGatewayPayload(value[key])}`).join(",")}}`;
}

// PostgreSQL jsonb renders objects in length-then-byte key order, with a
// space after object separators. The gateway stores JSONB but verifies a
// SHA-256 supplied by the server route, so the hash input must match the
// database representation exactly. Keep this separate from the compact
// canonical form used for HMAC/idempotency bindings.
function comparePostgresJsonbKeys(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length - rightBytes.length || Buffer.compare(leftBytes, rightBytes);
}

export function serializeAgentGatewayPayloadForPostgres(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new AgentGatewayError("agent_payload_invalid");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeAgentGatewayPayloadForPostgres).join(", ")}]`;
  if (!isPlainObject(value)) throw new AgentGatewayError("agent_payload_invalid");
  return `{${Object.keys(value).sort(comparePostgresJsonbKeys).map((key) =>
    `${JSON.stringify(key)}: ${serializeAgentGatewayPayloadForPostgres(value[key])}`).join(", ")}}`;
}

function requireSigningKey(value) {
  if (typeof value !== "string" || value.length < 32) {
    throw new AgentGatewayError("agent_gateway_signing_unavailable", 503);
  }
  return value;
}
function hmacHex(key, value) { return createHmac("sha256", key).update(value).digest("hex"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export function buildAgentGatewayDispatch({ actorUserId, organizationId, input, now = new Date(), signingKey = process.env.AGENT_GATEWAY_EVENT_SIGNING_KEY }) {
  if (!UUID_PATTERN.test(actorUserId) || !UUID_PATTERN.test(organizationId)) {
    throw new AgentGatewayError("agent_gateway_context_invalid", 403);
  }
  if (!isPlainObject(input) || Object.keys(input).length !== 2
    || typeof input.command !== "string" || !COMMAND_PATTERN.test(input.command)
    || !isPlainObject(input.payload)) throw new AgentGatewayError("agent_gateway_request_invalid");
  const policy = AGENT_GATEWAY_POLICIES[input.command];
  if (!policy) throw new AgentGatewayError("agent_command_not_allowlisted", 403);
  const payloadCanonical = canonicalizeAgentGatewayPayload(input.payload);
  if (Buffer.byteLength(payloadCanonical, "utf8") > MAX_PAYLOAD_BYTES) throw new AgentGatewayError("agent_payload_too_large");
  const key = requireSigningKey(signingKey);
  const payloadSha256 = sha256(serializeAgentGatewayPayloadForPostgres(input.payload));
  const correlationId = randomUUID();
  const idempotencyKey = `agt_${hmacHex(key, canonicalizeAgentGatewayPayload({ actorUserId, organizationId, commandKey: input.command, payloadSha256 })).slice(0, 56)}`;
  const credentialExpiresAt = new Date(now.getTime() + CREDENTIAL_TTL_SECONDS * 1000).toISOString();
  // Mint only an opaque short-lived delegation credential. Its raw value is
  // deliberately discarded: disabled adapters cannot receive it and storage
  // retains only a non-reversible fingerprint.
  const credentialToken = hmacHex(key, canonicalizeAgentGatewayPayload({
    actorUserId, organizationId, commandKey: input.command, correlationId, credentialExpiresAt,
  }));
  const credentialFingerprint = sha256(credentialToken);
  const eventSignature = hmacHex(key, canonicalizeAgentGatewayPayload({
    actorUserId, organizationId, commandKey: input.command, riskLevel: policy.riskLevel,
    requiredCapability: policy.capability, accessMode: policy.accessMode, channel: "server_agent_gateway",
    correlationId, idempotencyKey, payloadSha256, credentialFingerprint, credentialExpiresAt,
  }));
  return Object.freeze({
    actorUserId, organizationId, commandKey: input.command, riskLevel: policy.riskLevel,
    requiredCapability: policy.capability, accessMode: policy.accessMode, channel: "server_agent_gateway",
    correlationId, idempotencyKey, payload: input.payload, payloadSha256, eventSignature,
    credentialFingerprint, credentialExpiresAt,
  });
}
