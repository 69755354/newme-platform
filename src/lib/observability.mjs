const LOGGER_MAX_DEPTH = 6;
const SENTRY_MAX_DEPTH = 16;
const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";
const TRUNCATED = "[Truncated]";

const SENSITIVE_KEY = /(?:password|passphrase|token|secret|authorization|cookie|set[-_]?cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|email|phone)/i;
const HEALTH_PATH = /\/api\/(?:health|ready|readiness)(?:[/?#]|$)/i;
const TRANSACTION_NOISE_PATH = /\/api\/(?:health|ready|readiness|monitoring\/report)(?:[/?#]|$)/i;
const SENSITIVE_ASSIGNMENT = /\b(password|passphrase|secret|client[-_]?secret|monitoring[-_]?secret|x[-_]?monitoring[-_]?secret|api[-_]?key|apikey|authorization|access[-_]?token|refresh[-_]?token|token|session|cookie)(\s*[=:]\s*)[^\r\n]*/gi;

function scrubText(value) {
  return value
    // Sensitive free-text assignments have no reliable delimiter. Redact the
    // remainder of that log line so quoted, spaced, or comma-bearing values
    // cannot leak a suffix to telemetry.
    .replace(SENSITIVE_ASSIGNMENT, (_match, key, operator) => key + operator + REDACTED)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer " + REDACTED)
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic " + REDACTED)
    .replace(/\b(?:eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g, REDACTED)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/(?<!\w)\+?\d[\d ().-]{7,}\d(?!\w)/g, "[REDACTED_PHONE]");
}

export function sanitizeValue(value, depth = 0, seen = new WeakSet(), maxDepth = LOGGER_MAX_DEPTH) {
  if (typeof value === "string") return scrubText(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= maxDepth) return TRUNCATED;
  if (typeof value === "object") {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, depth + 1, seen, maxDepth));
    }

    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key)
        ? REDACTED
        : sanitizeValue(item, depth + 1, seen, maxDepth);
    }
    return output;
  }
  return String(value);
}

function serializeErrorFields(error, seen, depth) {
  if (depth >= LOGGER_MAX_DEPTH) return TRUNCATED;
  if (seen.has(error)) return CIRCULAR;
  seen.add(error);

  const output = {
    kind: error instanceof Error ? "Error" : "ObjectError",
  };
  if (typeof error.name === "string") output.name = scrubText(error.name);
  if (typeof error.message === "string") output.message = scrubText(error.message);
  if (typeof error.stack === "string") output.stack = scrubText(error.stack);
  for (const key of ["code", "details", "hint"]) {
    if (error[key] !== undefined) output[key] = sanitizeValue(error[key], depth + 1, seen);
  }
  if (error.cause !== undefined) {
    output.cause = serializeErr(error.cause, seen, depth + 1);
  }
  return output;
}

export function serializeErr(error, seen = new WeakSet(), depth = 0) {
  if (error === null || error === undefined) return error;
  if (depth >= LOGGER_MAX_DEPTH) return TRUNCATED;
  if (error instanceof Error || (typeof error === "object" && typeof error.message === "string")) {
    return serializeErrorFields(error, seen, depth);
  }
  if (typeof error === "string") return { kind: "StringError", message: scrubText(error) };
  if (typeof error === "object") return { kind: "UnknownObject", value: sanitizeValue(error, depth, seen) };
  return { kind: "Unknown", value: sanitizeValue(error) };
}

export function createPinoHooks(reportError) {
  return {
    logMethod(inputArgs, method, level) {
      let originalError;
      for (let index = 0; index < inputArgs.length; index += 1) {
        const value = inputArgs[index];
        if (!value || typeof value !== "object") continue;
        if (originalError === undefined && value.err instanceof Error) originalError = value.err;
        const sanitized = sanitizeValue(value);
        if (value.err !== undefined) sanitized.err = serializeErr(value.err);
        inputArgs[index] = sanitized;
      }
      method.apply(this, inputArgs);
      if (level >= 50 && typeof reportError === "function") {
        const context = inputArgs.find((value) => value && typeof value === "object") || {};
        const message = inputArgs.find((value) => typeof value === "string") || "server error";
        try {
          reportError({ message: scrubText(message), context, error: originalError });
        } catch {
          // Observability transport must never break the request path.
        }
      }
    },
  };
}

export function sanitizeSentryEvent(event) {
  if (!event || typeof event !== "object") return event;
  const request = event.request || {};
  const route = [event.transaction, request.url, request.path, event.tags?.route]
    .filter((value) => typeof value === "string")
    .join(" ");
  if (HEALTH_PATH.test(route)) return null;
  return sanitizeValue(event, 0, new WeakSet(), SENTRY_MAX_DEPTH);
}

export function sanitizeSentryTransaction(event) {
  if (!event || typeof event !== "object") return event;
  const request = event.request || {};
  const route = [event.transaction, request.url, request.path, event.tags?.route]
    .filter((value) => typeof value === "string")
    .join(" ");
  if (TRANSACTION_NOISE_PATH.test(route)) return null;
  return sanitizeValue(event, 0, new WeakSet(), SENTRY_MAX_DEPTH);
}
