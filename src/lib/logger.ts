import pino from "pino";
import { serializeErr } from "./observability.mjs";

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
      "password",
      "token",
      "secret",
      "authorization",
      "cookie",
      "apiKey",
      "*.password",
      "*.token",
      "*.secret",
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

export { serializeErr } from "./observability.mjs";

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

export function genReqId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function logErr(
  msg: string,
  err: unknown,
  ctx?: Record<string, unknown>,
) {
  logger.error({ err, ...ctx }, msg);
}

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
