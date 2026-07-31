import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

export const SAM52_SCHEMA_VERSION = 1;
export const SAM52_MAX_BODY_BYTES = 64 * 1024;
export const SAM52_MAX_ATTEMPTS = 3;
export const SAM52_REPLAY_TTL_MS = 10 * 60 * 1000;
export const SAM52_MAX_REPLAY_ENTRIES = 2048;
export const SAM52_HERMES_TIMEOUT_MS = 5000;

const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const EVENT_ID = /^[0-9a-f]{32}$/i;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const LEVELS = new Set(["fatal", "error", "warning"]);
const ENVIRONMENTS = new Set(["production", "staging", "development"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const TOP_LEVEL_KEYS = new Set(["action", "actor", "data", "installation"]);
const DATA_KEYS = new Set(["event", "triggered_rule"]);

export class Sam52BridgeError extends Error {
  constructor(code, status, message = code) {
    super(message);
    this.name = "Sam52BridgeError";
    this.code = code;
    this.status = status;
  }
}

export class HermesTransportError extends Error {
  constructor(code, retryable) {
    super(code);
    this.name = "HermesTransportError";
    this.code = code;
    this.retryable = retryable;
  }
}

function rawBodyBuffer(rawBody) {
  if (typeof rawBody === "string") return Buffer.from(rawBody, "utf8");
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (ArrayBuffer.isView(rawBody)) {
    return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  }
  throw new Sam52BridgeError("payload_body_invalid", 400);
}

export async function readBoundedRequestBody(request) {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new Sam52BridgeError("payload_too_large", 413);
    }
    const declaredLength = Number(declared);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > SAM52_MAX_BODY_BYTES
    ) {
      throw new Sam52BridgeError("payload_too_large", 413);
    }
  }

  if (request.body === null) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Sam52BridgeError("payload_body_invalid", 400);
      }
      totalBytes += value.byteLength;
      if (totalBytes > SAM52_MAX_BODY_BYTES) {
        await reader.cancel("payload_too_large").catch(() => {});
        throw new Sam52BridgeError("payload_too_large", 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, code) {
  if (!isPlainObject(value)) throw new Sam52BridgeError(code, 400);
  return value;
}

function requireString(value, code, maximumLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new Sam52BridgeError(code, 400);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, code) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Sam52BridgeError(code, 400);
  }
}

function inspectJsonShape(value, depth = 0, counter = { keys: 0 }) {
  if (depth > 6) throw new Sam52BridgeError("payload_too_deep", 400);
  if (typeof value === "string") {
    if (value.length > 4096) {
      throw new Sam52BridgeError("payload_string_too_long", 400);
    }
    return;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) {
      throw new Sam52BridgeError("payload_array_too_large", 400);
    }
    for (const item of value) inspectJsonShape(item, depth + 1, counter);
    return;
  }
  if (!isPlainObject(value)) {
    throw new Sam52BridgeError("payload_value_invalid", 400);
  }
  for (const [key, item] of Object.entries(value)) {
    counter.keys += 1;
    if (counter.keys > 512) {
      throw new Sam52BridgeError("payload_key_limit_exceeded", 400);
    }
    if (DANGEROUS_KEYS.has(key)) {
      throw new Sam52BridgeError("payload_prototype_key_rejected", 400);
    }
    inspectJsonShape(item, depth + 1, counter);
  }
}

function projectSlug(event) {
  if (typeof event.project === "string" && PROJECT.test(event.project)) {
    return event.project;
  }
  if (isPlainObject(event.project)) {
    for (const key of ["slug", "name"]) {
      const value = event.project[key];
      if (typeof value === "string" && PROJECT.test(value)) return value;
    }
  }
  throw new Sam52BridgeError("payload_project_invalid", 400);
}

function optionalEnvironment(event) {
  if (event.environment === undefined || event.environment === null) {
    return "unknown";
  }
  if (
    typeof event.environment !== "string" ||
    !ENVIRONMENTS.has(event.environment)
  ) {
    throw new Sam52BridgeError("payload_environment_invalid", 400);
  }
  return event.environment;
}

export function parseSentryAlertPayload(rawBody) {
  const bodyBytes = rawBodyBuffer(rawBody);
  if (bodyBytes.byteLength > SAM52_MAX_BODY_BYTES) {
    throw new Sam52BridgeError("payload_too_large", 413);
  }
  let parsed;
  try {
    parsed = JSON.parse(bodyBytes.toString("utf8"));
  } catch {
    throw new Sam52BridgeError("payload_json_invalid", 400);
  }
  inspectJsonShape(parsed);
  const body = requirePlainObject(parsed, "payload_root_invalid");
  rejectUnknownKeys(body, TOP_LEVEL_KEYS, "payload_root_key_unknown");
  if (body.action !== "triggered") {
    throw new Sam52BridgeError("payload_action_invalid", 400);
  }
  const data = requirePlainObject(body.data, "payload_data_invalid");
  rejectUnknownKeys(data, DATA_KEYS, "payload_data_key_unknown");
  const event = requirePlainObject(data.event, "payload_event_invalid");
  const eventId = event.event_id ?? event.eventID ?? event.id;
  if (typeof eventId !== "string" || !EVENT_ID.test(eventId)) {
    throw new Sam52BridgeError("payload_event_id_invalid", 400);
  }
  if (typeof event.level !== "string" || !LEVELS.has(event.level)) {
    throw new Sam52BridgeError("payload_level_invalid", 400);
  }
  const triggeredRule = requireString(
    data.triggered_rule,
    "payload_rule_invalid",
    160,
  );
  return Object.freeze({
    schemaVersion: SAM52_SCHEMA_VERSION,
    eventId: eventId.toLowerCase(),
    environment: optionalEnvironment(event),
    level: event.level,
    project: projectSlug(event),
    rule: triggeredRule,
  });
}

export function sentrySignature(secret, rawBody) {
  return createHmac("sha256", secret).update(rawBodyBuffer(rawBody)).digest("hex");
}

export function verifySentrySignature(secret, rawBody, suppliedSignature) {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 512) {
    throw new Sam52BridgeError("webhook_not_configured", 503);
  }
  if (typeof suppliedSignature !== "string") return false;
  const normalized = suppliedSignature.startsWith("sha256=")
    ? suppliedSignature.slice(7)
    : suppliedSignature;
  if (!/^[0-9a-f]{64}$/i.test(normalized)) return false;
  const expected = Buffer.from(sentrySignature(secret, rawBody), "hex");
  const actual = Buffer.from(normalized, "hex");
  return timingSafeEqual(expected, actual);
}

export function opaqueAuditKey(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

export class BoundedReplayStore {
  constructor({
    maxEntries = SAM52_MAX_REPLAY_ENTRIES,
    ttlMs = SAM52_REPLAY_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  claim(deliveryId) {
    this.prune();
    if (this.entries.has(deliveryId)) return false;
    this.entries.set(deliveryId, {
      expiresAt: this.now() + this.ttlMs,
      state: "pending",
    });
    return true;
  }

  complete(deliveryId) {
    const entry = this.entries.get(deliveryId);
    if (!entry) throw new Error("replay_claim_missing");
    entry.state = "completed";
  }

  release(deliveryId) {
    const entry = this.entries.get(deliveryId);
    if (entry?.state === "pending") this.entries.delete(deliveryId);
  }
}

export function createHttpHermesTransport({
  url,
  token,
  fetchImpl = fetch,
  timeoutMs = SAM52_HERMES_TIMEOUT_MS,
}) {
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    throw new Sam52BridgeError("hermes_transport_not_configured", 503);
  }
  const loopback =
    endpoint.protocol === "http:" &&
    (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost");
  if (
    !loopback ||
    endpoint.pathname !== "/api/alerts/sentry" ||
    endpoint.search ||
    endpoint.hash ||
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 512
  ) {
    throw new Sam52BridgeError("hermes_transport_not_configured", 503);
  }
  return {
    async send(alert) {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(alert),
        });
      } catch {
        throw new HermesTransportError("hermes_transport_unreachable", true);
      }
      if (response.status === 429 || response.status >= 500) {
        throw new HermesTransportError("hermes_transport_retryable", true);
      }
      if (!response.ok) {
        throw new HermesTransportError("hermes_transport_rejected", false);
      }
    },
  };
}

async function emitAudit(audit, entry) {
  await audit(Object.freeze(entry));
}

export async function deliverSentryAlert({
  rawBody,
  signature,
  resource,
  deliveryId,
  secret,
  replayStore,
  transport,
  audit = (_entry) => {
    void _entry;
  },
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxAttempts = SAM52_MAX_ATTEMPTS,
}) {
  if (resource !== "event.alert") {
    throw new Sam52BridgeError("hook_resource_invalid", 400);
  }
  if (typeof deliveryId !== "string" || !DELIVERY_ID.test(deliveryId)) {
    throw new Sam52BridgeError("hook_request_id_invalid", 400);
  }
  if (!verifySentrySignature(secret, rawBody, signature)) {
    throw new Sam52BridgeError("signature_invalid", 401);
  }
  const alert = parseSentryAlertPayload(rawBody);
  const deliveryKey = opaqueAuditKey(deliveryId);
  const eventKey = opaqueAuditKey(alert.eventId);
  if (!replayStore.claim(deliveryId)) {
    await emitAudit(audit, {
      schemaVersion: SAM52_SCHEMA_VERSION,
      action: "deduplicated",
      deliveryKey,
      eventKey,
      project: alert.project,
      level: alert.level,
      status: "accepted",
    });
    return { duplicate: true, attempts: 0, alert };
  }

  const envelope = Object.freeze({
    schemaVersion: SAM52_SCHEMA_VERSION,
    kind: "sentry_issue_alert",
    deliveryId,
    eventId: alert.eventId,
    project: alert.project,
    level: alert.level,
    environment: alert.environment,
    rule: alert.rule,
  });
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await transport.send(envelope, { attempt });
        replayStore.complete(deliveryId);
        await emitAudit(audit, {
          schemaVersion: SAM52_SCHEMA_VERSION,
          action: "delivered",
          deliveryKey,
          eventKey,
          project: alert.project,
          level: alert.level,
          status: "accepted",
          attempts: attempt,
        });
        return { duplicate: false, attempts: attempt, alert };
      } catch (error) {
        const retryable =
          error instanceof HermesTransportError && error.retryable === true;
        await emitAudit(audit, {
          schemaVersion: SAM52_SCHEMA_VERSION,
          action: "delivery_attempt_failed",
          deliveryKey,
          eventKey,
          project: alert.project,
          level: alert.level,
          status: retryable ? "retryable" : "rejected",
          attempt,
        });
        if (!retryable || attempt === maxAttempts) {
          throw new Sam52BridgeError("delivery_failed", 503);
        }
        await sleep(100 * 2 ** (attempt - 1));
      }
    }
    throw new Sam52BridgeError("delivery_failed", 503);
  } catch (error) {
    replayStore.release(deliveryId);
    throw error;
  }
}
