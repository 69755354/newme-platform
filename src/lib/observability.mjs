const LOGGER_MAX_DEPTH = 6;
const SENTRY_MAX_DEPTH = 16;
const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";
const TRUNCATED = "[Truncated]";

const SENSITIVE_KEY = /(?:password|passphrase|token|secret|authorization|cookie|set[-_]?cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|email|phone)/i;
const HEALTH_PATH = /\/api\/(?:health|ready|readiness|monitoring\/report)(?:[/?#]|$)/i;

function scrubText(value) {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer " + REDACTED)
    .replace(/\b(?:eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g, REDACTED)
    .replace(/\b(?:access_token|refresh_token|token|session|cookie)\s*[=:]\s*[^\s,;]+/gi, (match) => match.replace(/([^=:]+[=:]\s*).+$/i, "$1" + REDACTED))
    .replace(/\bpassword\s*[=:]\s*[^\s,;]+/gi, "password=" + REDACTED)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/(?<!\w)\+?\d[\d ().-]{7,}\d(?!\w)/g, "[REDACTED_PHONE]");
}

export function sanitizeValue(value, depth = 0, seen = new WeakSet(), maxDepth = LOGGER_MAX_DEPTH) {
  if (typeof value === "string") return scrubText(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= LOGGER_MAX_DEPTH) return TRUNCATED;
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

export function createPinoHooks() {
  return {
    logMethod(inputArgs, method) {
      for (let index = 0; index < inputArgs.length; index += 1) {
        const value = inputArgs[index];
        if (!value || typeof value !== "object") continue;
        const sanitized = sanitizeValue(value);
        if (value.err !== undefined) sanitized.err = serializeErr(value.err);
        inputArgs[index] = sanitized;
      }
      method.apply(this, inputArgs);
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
  return sanitizeSentryEvent(event);
}
