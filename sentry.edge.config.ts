import * as Sentry from "@sentry/nextjs";
import {
  sanitizeSentryEvent,
  sanitizeSentryTransaction,
} from "./src/lib/observability.mjs";

const release = process.env.SENTRY_RELEASE ||
  process.env.NEXT_PUBLIC_APP_VERSION ||
  "unknown";

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  release,
  environment: process.env.NODE_ENV || "development",
  initialScope: { tags: { build: process.env.NEXT_PUBLIC_APP_VERSION || "unknown" } },
  sendDefaultPii: false,
  tracesSampleRate: 0,
  beforeSend: sanitizeSentryEvent,
  beforeSendTransaction: sanitizeSentryTransaction,
});
