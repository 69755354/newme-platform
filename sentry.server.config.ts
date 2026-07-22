import * as Sentry from "@sentry/nextjs";
import {
  sanitizeSentryEvent,
  sanitizeSentryTransaction,
} from "./src/lib/observability.mjs";

const release = process.env.SENTRY_RELEASE ||
  process.env.BUILD_ID ||
  process.env.NEXT_PUBLIC_APP_VERSION ||
  "unknown";
const buildId = process.env.BUILD_ID || process.env.NEXT_PUBLIC_APP_VERSION || "unknown";

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  release,
  environment: process.env.NODE_ENV || "development",
  initialScope: { tags: { build: buildId } },
  sendDefaultPii: false,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  beforeSend: sanitizeSentryEvent,
  beforeSendTransaction: sanitizeSentryTransaction,
});
