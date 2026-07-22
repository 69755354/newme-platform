import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,

  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

  beforeSend(event) {
    const url = event.request?.url || "";
    if (url.includes("/api/health")) {
      return null;
    }
    return event;
  },

  // Server-side specific: don't send health check transactions
  beforeSendTransaction(event) {
    if (event.transaction?.includes("/api/health")) {
      return null;
    }
    return event;
  },
});
