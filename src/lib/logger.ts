import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

/**
 * Structured logger for NewMe CRM.
 *
 * In production: JSON to stdout (journalctl-readable).
 * In development: pretty-printed with colors.
 *
 * Base fields (service / environment / release_sha / build_id) are read once
 * from the environment at module init time and injected into every log line.
 *
 * Usage:
 *   import { logger } from "@/lib/logger";
 *   logger.error({ err, userId, action }, "Failed to update lead");
 *   logger.info({ userId, leadId }, "Lead stage changed");
 *   logger.warn({ quota }, "API rate limit approaching");
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? "info" : "debug"),
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
      }),
  base: {
    service: process.env.SERVICE_NAME || "newme-crm",
    environment: process.env.NODE_ENV || "development",
    release_sha:
      process.env.BUILD_ID ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      "unknown",
    build_id: process.env.BUILD_ID || "unknown",
  },
  redact: {
    paths: [
      // Original top-level secrets
      "password",
      "token",
      "secret",
      "authorization",
      "cookie",
      "apiKey",
      "*.password",
      "*.token",
      "*.secret",
      // PII / credential fields that may appear in context objects
      "phone",
      "email",
      "access_token",
      "refresh_token",
      "session",
      "headers.authorization",
      "headers.cookie",
      "req.headers.authorization",
      "req.headers.cookie",
      "*.phone",
      "*.email",
      "*.access_token",
      "*.refresh_token",
      "*.headers.authorization",
      "*.headers.cookie",
    ],
    censor: "[REDACTED]",
  },
  serializers: {
    err: serializeErr,
  },
});

/**
 * Standard error serializer for the pino `err` key.
 *
 * Handles every error shape we see in this codebase:
 *   - Native `Error` (and subclasses) → message, stack, name, cause (recursive)
 *   - `PostgresError` from `pg` / Supabase `PostgrestError` → adds code,
 *     details, hint (PostgresError extends Error, PostgrestError is a plain
 *     object with `message`, so both paths below cover it)
 *   - Plain object with a `message` property
 *   - String errors
 *   - Unknown types → JSON.stringify fallback
 *
 * This is the standalone, exported form so callers can reuse it for manual
 * pre-serialization (e.g. when shipping error context to Sentry) without
 * coupling to pino internals.
 *
 * Note: we do NOT walk the full error chain to scrub SQL / PII here — that
 * scrubbing is the caller's responsibility case-by-case. The serializer just
 * surfaces what the Error object itself exposes.
 */
export function serializeErr(err: unknown): unknown {
  if (err === null || err === undefined) {
    return err;
  }

  // Native Error or any subclass (incl. PostgresError from `pg`)
  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      kind: "Error",
      name: err.name,
      message: err.message,
    };
    if (err.stack) out.stack = err.stack;
    // Access extra / non-standard fields via unknown. Error.cause is part of
    // ES2022 but our lib target is older, so we read it from the record view.
    const extra = err as unknown as Record<string, unknown>;
    if (extra.code !== undefined) out.code = extra.code;
    if (extra.details !== undefined) out.details = extra.details;
    if (extra.hint !== undefined) out.hint = extra.hint;
    if (extra.cause !== undefined) out.cause = serializeErr(extra.cause);
    return out;
  }

  // Plain object — incl. Supabase PostgrestError ({ code, message, details, hint })
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") {
      const out: Record<string, unknown> = {
        kind: "ObjectError",
        message: obj.message,
      };
      if (typeof obj.name === "string") out.name = obj.name;
      if (typeof obj.stack === "string") out.stack = obj.stack;
      if (obj.code !== undefined) out.code = obj.code;
      if (obj.details !== undefined) out.details = obj.details;
      if (obj.hint !== undefined) out.hint = obj.hint;
      if (obj.cause !== undefined) out.cause = serializeErr(obj.cause);
      return out;
    }
    // Unknown object — fall back to JSON
    try {
      JSON.stringify(err);
      return { kind: "UnknownObject", value: err };
    } catch {
      return { kind: "UnknownObject", value: String(err) };
    }
  }

  // String errors
  if (typeof err === "string") {
    return { kind: "StringError", message: err };
  }

  // Unknown primitives (number, boolean, bigint, symbol, function)
  try {
    return { kind: "Unknown", value: JSON.stringify(err) };
  } catch {
    return { kind: "Unknown", value: String(err) };
  }
}

/**
 * Standard log-context fields for server-side structured logging.
 *
 * Documentation + type guidance only — NOT enforced at runtime. Callers are
 * free to pass any subset of these keys plus arbitrary extras via the
 * `[key: string]: unknown` index signature.
 */
export interface LogContext {
  request_id?: string;
  route?: string;
  method?: string;
  operation?: string;
  user_id?: string;
  lead_id?: string;
  project_id?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

/**
 * Generate a short, unique request_id.
 *
 * Uses `crypto.randomUUID()` and returns the first 8 chars for readability
 * (e.g. `a3f1c2d9`). Short IDs are easier to grep / paste into tickets while
 * still providing ~4 billion values of entropy per UUID v4 prefix.
 */
export function genReqId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Shorthand: log an error with optional structured context.
 * Usage: logErr("Failed to upsert", error, { userId, leadId })
 */
export function logErr(
  msg: string,
  err: unknown,
  ctx?: Record<string, unknown>,
) {
  logger.error({ err, ...ctx }, msg);
}

/**
 * Audit trail for security-sensitive operations.
 * Currently logs to stdout; will write to audit_logs table when available.
 */
export function audit(
  action: string,
  actor: { id: string; email?: string; role?: string },
  target?: { type: string; id: string },
  detail?: Record<string, unknown>,
) {
  logger.info(
    {
      audit: true,
      action,
      actor,
      target,
      detail,
    },
    `AUDIT: ${action}`,
  );
}
