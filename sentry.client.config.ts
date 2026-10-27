import * as Sentry from "@sentry/nextjs";
import { browserProfilingIntegration } from "@sentry/nextjs";
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
  // browserTracingIntegration is a *default* integration of @sentry/nextjs, so
  // this line alone is real-user monitoring whenever a DSN is present. It is
  // unset in production (checked in the runtime env and, because NEXT_PUBLIC_*
  // is inlined at build time, in the deployed bundle), which is why
  // docs/lighthouse-baseline.md can say nothing is collected -- see that file
  // before setting it.
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  // No replay sample rates here on purpose. Session replay is not a default
  // integration and nothing adds it, so the two rates this used to carry were
  // inert while reading as "replay is on at 10%" -- the same false claim that
  // let an unmasked replay configuration survive review elsewhere in this repo.
  integrations: [browserProfilingIntegration()],
  beforeSend: sanitizeSentryEvent,
  beforeSendTransaction: sanitizeSentryTransaction,
});
