import pino from "pino";
import * as Sentry from "@sentry/nextjs";
import { createPinoHooks, serializeErr } from "./observability.mjs";

const isProd = process.env.NODE_ENV === "production";

function reportProductionError(payload: {
  message: string;
  context: Record<string, unknown>;
  error?: Error;
}) {
  const route = typeof payload.context.route === "string" ? payload.context.route : "";
  if (/\/api\/(?:health|ready|monitoring\/report)(?:[/?#]|$)/i.test(route)) return;
  const tags = Object.fromEntries(
    ["route", "operation", "code", "request_id"]
      .filter((key) => typeof payload.context[key] === "string")
      .map((key) => [key, String(payload.context[key]).slice(0, 200)]),
  );
  const captureContext = { level: "error" as const, tags, extra: { log: payload.context } };
  if (payload.error instanceof Error) {
    Sentry.captureException(payload.error, captureContext);
  } else {
    Sentry.captureMessage(payload.message, captureContext);
  }
}

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
      process.env.SENTRY_RELEASE ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.NEXT_PUBLIC_APP_VERSION ||
      "unknown",
    build_id: process.env.BUILD_ID || process.env.NEXT_PUBLIC_APP_VERSION || "unknown",
  },
  redact: {
    paths: [
      "password", "token", "secret", "authorization", "cookie", "apiKey",
      "*.password", "*.token", "*.secret", "phone", "email", "access_token",
      "refresh_token", "session", "headers.authorization", "headers.cookie",
      "req.headers.authorization", "req.headers.cookie", "*.phone", "*.email",
      "*.access_token", "*.refresh_token", "*.headers.authorization",
      "*.headers.cookie",
    ],
    censor: "[REDACTED]",
  },
  hooks: createPinoHooks(isProd ? reportProductionError : undefined),
  serializers: { err: serializeErr },
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

export function logErr(msg: string, err: unknown, ctx?: Record<string, unknown>) {
  logger.error({ err, ...ctx }, msg);
}

export function audit(
  action: string,
  actor: { id: string; email?: string; role?: string },
  target?: { type: string; id: string },
  detail?: Record<string, unknown>,
) {
  logger.info({ audit: true, action, actor, target, detail }, `AUDIT: ${action}`);
}
