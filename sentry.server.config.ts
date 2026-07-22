import * as Sentry from "@sentry/nextjs";
import {
  sanitizeSentryEvent,
  sanitizeSentryTransaction,
} from "./src/lib/observability.mjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  sendDefaultPii: false,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  beforeSend: sanitizeSentryEvent,
  beforeSendTransaction: sanitizeSentryTransaction,
});
