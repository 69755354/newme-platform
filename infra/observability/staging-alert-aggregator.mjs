export const DEDUP_WINDOW_MS = 5 * 60 * 1_000;

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

export function sanitizeAlertSummary(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:authorization|token|secret|password|api[-_]?key|email)\s*[=:]\s*[^\s,;]+/gi, (match) => {
      const separator = match.includes(":") ? ":" : "=";
      return `${match.slice(0, match.indexOf(separator) + 1)}[REDACTED]`;
    })
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 300);
}

function normalizeTimestamp(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("alert requires a valid occurredAt timestamp");
  return timestamp;
}

function normalizeAlert(alert) {
  if (!alert || typeof alert !== "object") throw new Error("alert must be an object");
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

function normalizeState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {};
  const normalized = {};
  for (const [identity, timestamp] of Object.entries(state)) {
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) normalized[identity] = timestamp;
  }
  return normalized;
}

/**
 * Pure, staging-only alert grouping. It never contacts a notifier or writes
 * state; callers may persist nextState only after an explicit future review.
 */
export function aggregateStagingAlerts(alerts, priorState = {}, { mode = "dry-run" } = {}) {
  if (mode !== "dry-run") throw new Error("staging alert aggregation is dry-run only");
  if (!Array.isArray(alerts)) throw new Error("alerts must be an array");

  const nextState = normalizeState(priorState);
  const emitted = [];
  const suppressed = [];

  for (const rawAlert of alerts) {
    const alert = normalizeAlert(rawAlert);
    const identity = `${alert.source}:${alert.key}`;
    const priorTimestamp = nextState[identity];
    if (typeof priorTimestamp === "number" && alert.occurredAt - priorTimestamp < DEDUP_WINDOW_MS) {
      suppressed.push({ ...alert, reason: "deduplicated" });
      continue;
    }
    emitted.push({
      source: alert.source,
      key: alert.key,
      summary: alert.summary,
      occurredAt: new Date(alert.occurredAt).toISOString(),
    });
    nextState[identity] = alert.occurredAt;
  }

  return { mode, emitted, suppressed, nextState };
}
