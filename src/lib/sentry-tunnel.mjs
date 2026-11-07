// Same-origin forwarder for browser error envelopes (S7 review, must-fix 1).
//
// Replaces the Sentry plugin's rewrite-based tunnel, which is a plain reverse
// proxy: it relayed the staff session cookies to Sentry and accepted envelopes
// for any Sentry project. This handler is POST-only, size-capped, checks that
// the envelope's DSN is THIS project (host and project id come from server
// environment variables, never from the repository), forwards to one fixed
// upstream URL, and sends only the body plus a fixed content type. Cookie,
// Authorization, X-Forwarded-For and every other inbound header are dropped.

export const TUNNEL_MAX_BYTES = 200 * 1024;
export const TUNNEL_TIMEOUT_MS = 5_000;

const DSN_PATTERN = /^https:\/\/([A-Za-z0-9]+)(?::[^@/]*)?@([A-Za-z0-9.-]+)\/(\d+)$/;

/** Parse the target project from server env; returns null when unset or malformed. */
export function resolveTunnelTarget(env = process.env) {
  const raw = (env.SENTRY_DSN || env.NEXT_PUBLIC_SENTRY_DSN || "").trim();
  const match = DSN_PATTERN.exec(raw);
  if (!match) return null;
  const host = match[2].toLowerCase();
  if (!host.endsWith(".sentry.io") && !host.endsWith(".sentry.io.")) return null;
  const projectId = match[3];
  return { host, projectId, upstream: `https://${host}/api/${projectId}/envelope/` };
}

function reply(status, body = "") {
  return new Response(body, { status, headers: { "cache-control": "no-store" } });
}

async function readCapped(request, maxBytes) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

function envelopeDsn(bytes) {
  const newline = bytes.indexOf(10);
  const headerBytes = newline === -1 ? bytes : bytes.subarray(0, newline);
  if (headerBytes.byteLength === 0 || headerBytes.byteLength > 8 * 1024) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(headerBytes));
    return header && typeof header.dsn === "string" ? header.dsn : null;
  } catch {
    return null;
  }
}

/**
 * @param {Request} request
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch }} [deps]
 */
export async function handleTunnelRequest(request, { env = process.env, fetchImpl = fetch } = {}) {
  if (request.method !== "POST") return reply(405);
  const target = resolveTunnelTarget(env);
  if (!target) return reply(503);

  const body = await readCapped(request, TUNNEL_MAX_BYTES);
  if (body === null) return reply(413);

  const dsn = envelopeDsn(body);
  if (dsn === null) return reply(400);
  const match = DSN_PATTERN.exec(dsn);
  if (!match || match[2].toLowerCase() !== target.host || match[3] !== target.projectId) return reply(403);

  try {
    const upstream = await fetchImpl(target.upstream, {
      method: "POST",
      // Fixed header set: nothing from the browser request is copied across.
      headers: { "content-type": "application/x-sentry-envelope" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(TUNNEL_TIMEOUT_MS),
    });
    return reply(upstream.status >= 200 && upstream.status < 300 ? 200 : 502);
  } catch {
    return reply(502);
  }
}
