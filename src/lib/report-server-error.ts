/**
 * reportServerError — centralized server-side error reporting.
 *
 * POSTs structured errors to the internal /api/monitoring/report endpoint.
 * Silently fails if the endpoint is unreachable (no circular error loops).
 */
interface ServerErrorPayload {
  message: string;
  stack?: string;
  type?: string;
  url?: string;
}

export async function reportServerError(payload: ServerErrorPayload): Promise<void> {
  const secret = process.env.MONITORING_SECRET;
  if (!secret) return; // not configured, skip silently

  try {
    const { message, stack, type = "server", url = "" } = payload;
    const origin = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

    await fetch(`${origin}/api/monitoring/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-monitoring-secret": secret,
      },
      body: JSON.stringify({ message, stack, type, url }),
    });
  } catch {
    // Never throw — silent fail to prevent circular error loops
  }
}
