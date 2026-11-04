// Browser-side error capture (S7, review 5-logging-monitoring F3). Next 16 loads
// this file in the browser; the old sentry.client.config.ts was never wired in
// and the build had no public DSN, so no browser error was ever reported.
//
// Errors only: tracing is off (0) and there is no replay or profiling, so no
// page content, input value or timing of a customer is collected. Every event
// still passes the same minimiser/scrubber as the server (request bodies, query
// strings, cookies, names, notes and the user's e-mail/IP are dropped).
// NEXT_PUBLIC_SENTRY_DSN is inlined at build time: the release build must set it
// (see S7-INSTALL.md); without it the SDK stays disabled and sends nothing.
import * as Sentry from "@sentry/nextjs";
import {
  sanitizeSentryEvent,
  sanitizeSentryTransaction,
} from "./src/lib/observability.mjs";

const buildId = process.env.NEXT_PUBLIC_APP_VERSION || "unknown";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  release: buildId,
  environment: process.env.NODE_ENV || "development",
  initialScope: { tags: { build: buildId } },
  sendDefaultPii: false,
  tracesSampleRate: 0,
  // Same-origin tunnel (next.config.ts tunnelRoute): no ad-blocker loss and no
  // new CSP origin for the page.
  beforeSend: sanitizeSentryEvent,
  beforeSendTransaction: sanitizeSentryTransaction,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
