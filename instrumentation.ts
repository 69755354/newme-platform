import * as Sentry from "@sentry/nextjs";
import { installServerCrashReporting } from "./src/lib/server-crash-reporting.mjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    installServerCrashReporting({
      captureException: Sentry.captureException,
      flush: Sentry.flush,
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
