import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      await import("./sentry.server.config");
    } catch (e) {
      console.warn("[newme] Sentry server instrumentation load failed, continuing without it:", (e as Error).message);
    }
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    try {
      await import("./sentry.edge.config");
    } catch (e) {
      console.warn("[newme] Sentry edge instrumentation load failed, continuing without it:", (e as Error).message);
    }
  }
}

export const onRequestError = Sentry.captureRequestError;
