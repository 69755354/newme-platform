export const DEDUP_WINDOW_MS = 5 * 60 * 1_000;
export const MAX_ALERT_BATCH = 100;
export const MAX_DEDUP_STATE_ENTRIES = 500;
export const MAX_SUMMARY_LENGTH = 300;
export const MAX_SUMMARY_DEPTH = 6;
export const MAX_SUMMARY_NODES = 200;

const MAX_RAW_SUMMARY_LENGTH = 4_096;
const SUPPORTED_SOURCES = new Set([
  "health-check",
  "login-probe",
  "supabase-pool-monitor",
  "resource-alert",
  "meta-watchdog",
  "browser-smoke",
  "sentry",
]);
const SAFE_KEY = /^[a-z0-9][a-z0-9_.-]{0,79}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\ufeff]/g;
const SENSITIVE_FIELD = /(?:authorization|cookie|token|secret|password|api[-_]?key|email|phone|stack|path|detail|hint)/i;

function sanitizeText(value) {
  return String(value ?? "")
    .slice(0, MAX_RAW_SUMMARY_LENGTH)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:authorization|cookie|set-cookie|token|secret|password|api[-_]?key|email|phone)\s*[=:]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/\+?\d[\d(). -]{6,}\d/g, "[REDACTED_PHONE]")
    .replace(/\b(?:key|detail|hint)\s*\([^)]{0,80}\)\s*=\s*\([^)]{0,200}\)/gi, "[REDACTED_DB_DETAIL]")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"']{1,200})/g, "[REDACTED_PATH]")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SUMMARY_LENGTH) || "[empty]";
}

function inspectNestedSummary(value) {
  const seen = new Set();
  let nodes = 0;

  function visit(current, depth) {
    nodes += 1;
    if (nodes > MAX_SUMMARY_NODES || depth > MAX_SUMMARY_DEPTH) return false;
    if (current === null || typeof current !== "object") return true;
    if (seen.has(current)) return false;
    seen.add(current);

    try {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (SENSITIVE_FIELD.test(key)) continue;
        if ("value" in descriptor && !visit(descriptor.value, depth + 1)) return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  visit(value, 0);
  return "[REDACTED_NESTED_DETAIL]";
}

export function sanitizeAlertSummary(value) {
  if (value !== null && typeof value === "object") return inspectNestedSummary(value);
  return sanitizeText(value);
}

function normalizeTimestamp(value, field = "occurredAt") {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`alert requires a valid ${field} timestamp`);
  return timestamp;
}

function normalizeAlert(alert) {
  if (!alert || typeof alert !== "object" || Array.isArray(alert)) throw new Error("alert must be an object");
  const source = String(alert.source ?? "");
  const key = String(alert.key ?? "");
  if (!SUPPORTED_SOURCES.has(source)) throw new Error("unsupported alert source");
  if (!SAFE_KEY.test(key)) throw new Error("alert key must be a safe identifier");

  return {
    source,
    key,
    occurredAt: normalizeTimestamp(alert.occurredAt),
    summary: sanitizeAlertSummary(alert.summary),
  };
}

function splitIdentity(identity) {
  const separator = identity.indexOf(":");
  if (separator <= 0 || separator !== identity.lastIndexOf(":")) return null;
  const source = identity.slice(0, separator);
  const key = identity.slice(separator + 1);
  return SUPPORTED_SOURCES.has(source) && SAFE_KEY.test(key) ? { source, key } : null;
}

function normalizeState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {};

  let entries;
  try {
    entries = Object.entries(Object.getOwnPropertyDescriptors(state));
  } catch {
    throw new Error("deduplication state must be a plain object");
  }
  if (entries.length > MAX_DEDUP_STATE_ENTRIES) {
    throw new Error("deduplication state exceeds the maximum entry count");
  }

  const normalized = {};
  for (const [identity, descriptor] of entries) {
    if (!("value" in descriptor) || !splitIdentity(identity)) {
      throw new Error("deduplication state contains an invalid identity");
    }
    if (typeof descriptor.value !== "number" || !Number.isFinite(descriptor.value)) {
      throw new Error("deduplication state contains an invalid timestamp");
    }
    normalized[identity] = descriptor.value;
  }
  return normalized;
}

function toOutputAlert(alert) {
  return {
    source: alert.source,
    key: alert.key,
    summary: alert.summary,
    occurredAt: new Date(alert.occurredAt).toISOString(),
  };
}

function selectReferenceTime(alerts, state, now) {
  if (now !== undefined) return normalizeTimestamp(now, "now");
  return Math.max(0, ...alerts.map((alert) => alert.occurredAt), ...Object.values(state));
}

/**
 * Pure staging-only alert grouping. It never contacts a notifier, accesses
 * the filesystem, or persists deduplication state. Any non-dry-run mode and
 * every resource-limit breach fail closed before a result is returned.
 */
export function aggregateStagingAlerts(alerts, priorState = {}, { mode = "dry-run", now } = {}) {
  if (mode !== "dry-run") throw new Error("staging alert aggregation is dry-run only");
  if (!Array.isArray(alerts)) throw new Error("alerts must be an array");
  if (alerts.length > MAX_ALERT_BATCH) throw new Error("alert batch exceeds the maximum size");

  const normalizedAlerts = alerts.map(normalizeAlert);
  const normalizedState = normalizeState(priorState);
  const referenceTime = selectReferenceTime(normalizedAlerts, normalizedState, now);
  const activeState = {};

  for (const [identity, timestamp] of Object.entries(normalizedState)) {
    if (timestamp >= referenceTime - DEDUP_WINDOW_MS && timestamp <= referenceTime) {
      activeState[identity] = timestamp;
    }
  }

  const emitted = [];
  const suppressed = [];

  for (const alert of normalizedAlerts) {
    if (alert.occurredAt < referenceTime - DEDUP_WINDOW_MS || alert.occurredAt > referenceTime) {
      throw new Error("alert occurred outside the injected deduplication window");
    }

    const identity = `${alert.source}:${alert.key}`;
    const priorTimestamp = activeState[identity];
    if (typeof priorTimestamp === "number" && alert.occurredAt - priorTimestamp < DEDUP_WINDOW_MS) {
      suppressed.push({ ...toOutputAlert(alert), reason: "deduplicated" });
      continue;
    }
    if (!(identity in activeState) && Object.keys(activeState).length >= MAX_DEDUP_STATE_ENTRIES) {
      throw new Error("deduplication state exceeds the maximum entry count");
    }
    emitted.push(toOutputAlert(alert));
    activeState[identity] = alert.occurredAt;
  }

  return { mode: "dry-run", emitted, suppressed, nextState: activeState };
}
