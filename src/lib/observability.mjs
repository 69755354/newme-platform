const LOGGER_MAX_DEPTH = 6;
const SENTRY_MAX_DEPTH = 16;
const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";
const TRUNCATED = "[Truncated]";

const SENSITIVE_KEY = /(?:password|passphrase|token|secret|authorization|cookie|set[-_]?cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|email|phone)/i;
// Customer/staff person names and free-text fields. Formats cannot identify a
// name or a note, so these are redacted by key wherever they appear (logs and
// telemetry). Bare `name` is too generic globally (sdk.name, browser.name); it
// is redacted only inside caller-supplied subtrees, see PERSONAL_SUBTREE_KEY.
const PERSONAL_KEY = /^(?:(?:customer|contact|client|lead|first|last|full|display|nick|user|sender|recipient|rep|actor|target|owner|assignee)[-_]?name|decision[-_]?maker|notes?|remarks?|comments?|address(?:[-_]?line\d*)?|street|whatsapp(?:[-_]?number)?|mobile(?:[-_]?number)?|wa[-_]?id|message[-_]?body|answers|field[-_]?data|raw[-_]?import[-_]?data|ip[-_]?address)$/i;
const PERSONAL_SUBTREE_KEY = /^(?:name|body|text|content|value|customer|client|contact|person|owner|assignee|rep|username|surname)$/i;
const SAFE_REQUEST_HEADERS = new Set(["user-agent", "content-type", "accept-language"]);
const HEALTH_PATH = /\/api\/(?:health|ready|readiness)(?:[/?#]|$)/i;
const TRANSACTION_NOISE_PATH = /\/api\/(?:health|ready|readiness|monitoring\/report)(?:[/?#]|$)/i;
const SENSITIVE_ASSIGNMENT = /\b(password|passphrase|secret|client[-_]?secret|monitoring[-_]?secret|x[-_]?monitoring[-_]?secret|api[-_]?key|apikey|authorization|access[-_]?token|refresh[-_]?token|token|session|cookie)(\s*[=:]\s*)[^\r\n]*/gi;

const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Row/request/actor ids are UUIDs and are the debugging handle; their digit-only
// groups must not be mistaken for phone numbers. Scrub the text around them.
function scrubText(value) {
  if (!UUID_TEXT.test(value)) return scrubSegment(value);
  UUID_TEXT.lastIndex = 0;
  const ids = value.match(UUID_TEXT);
  return value.split(UUID_TEXT).map((part, i) => scrubSegment(part) + (ids[i] ?? "")).join("");
}

function scrubSegment(value) {
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

export function sanitizeValue(value, depth = 0, seen = new WeakSet(), maxDepth = LOGGER_MAX_DEPTH, strictNames = false) {
  if (typeof value === "string") return scrubText(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= maxDepth) return TRUNCATED;
  if (typeof value === "object") {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, depth + 1, seen, maxDepth, strictNames));
    }

    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) || PERSONAL_KEY.test(key) || (strictNames && PERSONAL_SUBTREE_KEY.test(key) && typeof item !== "object")
        ? REDACTED
        : sanitizeValue(item, depth + 1, seen, maxDepth, strictNames);
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

/** Drop query string and fragment; keep scheme/host/path for debugging. */
export function stripQuery(value) {
  if (typeof value !== "string") return value;
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

function minimizeBreadcrumb(crumb) {
  if (!crumb || typeof crumb !== "object") return crumb;
  const out = {};
  for (const key of ["type", "category", "level", "timestamp"]) if (crumb[key] !== undefined) out[key] = crumb[key];
  // Only the category/type/level survive. Custom breadcrumb messages, UI selectors
  // (title/aria-label text) and console lines carry whatever the page or code
  // printed, which can include a customer name; none has a safe subset.
  const data = crumb.data && typeof crumb.data === "object" ? crumb.data : null;
  if (data) {
    const kept = {};
    for (const key of ["method", "status_code", "reason"]) {
      if (typeof data[key] === "string" || typeof data[key] === "number") kept[key] = data[key];
    }
    for (const key of ["url", "from", "to"]) {
      if (typeof data[key] === "string") kept[key] = stripQuery(data[key]);
    }
    if (Object.keys(kept).length) out.data = kept;
  }
  return out;
}

// Keys that hold query strings or database statements (db.statement, url.query,
// http.query ...) can embed literal customer values; they are removed, not masked.
const DROP_KEY = /query|statement|\bsql\b|^sql$/i;
// Contexts the SDK fills with environment facts; `name` there is a product name
// (Chrome, Linux), not a person. Every other context is caller-supplied.
const SDK_CONTEXTS = new Set(["browser", "os", "runtime", "device", "app", "culture", "cloud_resource", "gpu", "trace", "response", "react", "state"]);

function dropSensitiveKeys(value, depth = 0) {
  if (depth > SENTRY_MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => dropSensitiveKeys(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (DROP_KEY.test(key)) continue;
    out[key] = dropSensitiveKeys(item, depth + 1);
  }
  return out;
}

function minimizeContexts(contexts) {
  const out = {};
  for (const [key, value] of Object.entries(contexts)) {
    const cleaned = dropSensitiveKeys(value);
    out[key] = SDK_CONTEXTS.has(key)
      ? cleaned
      : sanitizeValue(cleaned, 0, new WeakSet(), SENTRY_MAX_DEPTH, true);
  }
  return out;
}

function minimizeException(exception) {
  const values = Array.isArray(exception?.values) ? exception.values : null;
  if (!values) return exception;
  return {
    ...exception,
    values: values.map((entry) => {
      if (!entry || typeof entry !== "object" || !entry.stacktrace || !Array.isArray(entry.stacktrace.frames)) return entry;
      // Frame local variables (vars) hold arbitrary runtime values; never sent.
      const frames = entry.stacktrace.frames.map((frame) => {
        if (!frame || typeof frame !== "object") return frame;
        const { vars: _vars, ...rest } = frame;
        return rest;
      });
      return { ...entry, stacktrace: { ...entry.stacktrace, frames } };
    }),
  };
}

function minimizeRequest(request) {
  if (!request || typeof request !== "object") return request;
  const out = {};
  if (typeof request.method === "string") out.method = request.method;
  if (typeof request.url === "string") out.url = stripQuery(request.url);
  if (request.headers && typeof request.headers === "object") {
    const headers = {};
    for (const [key, item] of Object.entries(request.headers)) {
      const lower = key.toLowerCase();
      if (SAFE_REQUEST_HEADERS.has(lower) && typeof item === "string") headers[key] = item;
      // Credential-bearing headers stay visible as present-but-redacted.
      else if (/^(?:authorization|cookie|set-cookie|x-[a-z-]*(?:token|secret|key))$/.test(lower)) headers[key] = REDACTED;
    }
    if (Object.keys(headers).length) out.headers = headers;
  }
  // data (request body), cookies, query_string and env are dropped entirely.
  return out;
}

/**
 * Customer-data minimisation applied before the generic scrubber. Sentry keeps
 * routes, ids, status codes, stack frames and SDK metadata; it never receives
 * request bodies, query strings, cookies, person names, notes or the user's
 * e-mail/IP — only the actor id.
 */
export function minimizeSentryEvent(event) {
  const out = { ...event };
  if (event.request) out.request = minimizeRequest(event.request);
  if (event.user && typeof event.user === "object") {
    const id = typeof event.user.id === "string" || typeof event.user.id === "number" ? event.user.id : undefined;
    if (id === undefined) delete out.user;
    else out.user = { id };
  }
  if (Array.isArray(event.breadcrumbs)) out.breadcrumbs = event.breadcrumbs.map(minimizeBreadcrumb);
  else if (event.breadcrumbs && Array.isArray(event.breadcrumbs.values)) {
    out.breadcrumbs = { ...event.breadcrumbs, values: event.breadcrumbs.values.map(minimizeBreadcrumb) };
  }
  if (event.extra && typeof event.extra === "object") {
    out.extra = sanitizeValue(dropSensitiveKeys(event.extra), 0, new WeakSet(), SENTRY_MAX_DEPTH, true);
  }
  if (event.tags && typeof event.tags === "object") {
    out.tags = sanitizeValue(dropSensitiveKeys(event.tags), 0, new WeakSet(), SENTRY_MAX_DEPTH, true);
  }
  if (event.contexts && typeof event.contexts === "object") out.contexts = minimizeContexts(event.contexts);
  if (event.exception) out.exception = minimizeException(event.exception);
  if (Array.isArray(event.threads?.values)) {
    out.threads = { ...event.threads, values: event.threads.values.map((thread) => minimizeException({ values: [thread] }).values[0]) };
  }
  if (typeof event.transaction === "string") out.transaction = stripQuery(event.transaction);
  if (Array.isArray(event.spans)) {
    out.spans = event.spans.map((span) => {
      if (!span || typeof span !== "object") return span;
      const copy = { ...span };
      if (typeof span.description === "string") copy.description = stripQuery(span.description);
      if (span.data && typeof span.data === "object") {
        const data = { ...span.data };
        for (const key of Object.keys(data)) {
          if (/query|body|statement|sql/i.test(key)) delete data[key];
          else if (/url|target|route/i.test(key) && typeof data[key] === "string") data[key] = stripQuery(data[key]);
        }
        copy.data = data;
      }
      return copy;
    });
  }
  return out;
}

export function sanitizeSentryEvent(event) {
  if (!event || typeof event !== "object") return event;
  const request = event.request || {};
  const route = [event.transaction, request.url, request.path, event.tags?.route]
    .filter((value) => typeof value === "string")
    .join(" ");
  if (HEALTH_PATH.test(route)) return null;
  return sanitizeValue(minimizeSentryEvent(event), 0, new WeakSet(), SENTRY_MAX_DEPTH);
}

export function sanitizeSentryTransaction(event) {
  if (!event || typeof event !== "object") return event;
  const request = event.request || {};
  const route = [event.transaction, request.url, request.path, event.tags?.route]
    .filter((value) => typeof value === "string")
    .join(" ");
  if (TRANSACTION_NOISE_PATH.test(route)) return null;
  return sanitizeValue(minimizeSentryEvent(event), 0, new WeakSet(), SENTRY_MAX_DEPTH);
}
