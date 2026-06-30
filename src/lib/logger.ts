import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

/**
 * Structured logger for NewMe CRM.
 * 
 * In production: JSON to stdout (journalctl-readable).
 * In development: pretty-printed with colors.
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
  base: { env: process.env.NODE_ENV, app: "newme-crm" },
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
    ],
    censor: "[REDACTED]",
  },
});

/**
 * Shorthand: log and include error object.
 * Usage: logErr("Failed to upsert", error, { userId })
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
