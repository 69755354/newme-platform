// SAM-51: Sentry instrumentation hook disabled — require-in-the-middle
// Turbopack bundling issue prevents @sentry/nextjs from loading at runtime.
// Client-side Sentry (via withSentryConfig webpack plugin) still works.
// Re-enable when Sentry/Next.js 16 compatibility is resolved.

export async function register() {
  // no-op: Sentry server instrumentation skipped
}
