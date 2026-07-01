import * as Sentry from "@sentry/nextjs";
import { browserProfilingIntegration } from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Tracing
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

  // Session Replay (Sentry's own, complementary to PostHog)
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  // Browser Profiling — captures JS execution hotspots for performance debugging
  // T3-2: enables profiling on top of existing tracesSampleRate 0.1
  integrations: [
    browserProfilingIntegration(),
  ],

  // Filter out health check noise
  beforeSend(event) {
    const url = event.request?.url || "";
    if (url.includes("/api/health") || url.includes("/api/monitoring/report")) {
      return null;
    }
    return event;
  },
});
