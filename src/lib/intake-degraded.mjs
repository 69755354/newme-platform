// S35 B5: a small in-process flag the health endpoint can show. When a lead intake path had to run in a degraded mode
// (the WhatsApp privacy gate was closed, so message bodies were not stored), /api/health says so for 30 minutes after the
// last occurrence. Uptime probes that already read /api/health (they match '"status":"ok"') keep working: the status
// stays "ok", only an extra field appears. Held on globalThis so every route bundle in the process sees the same flag.
export const INTAKE_DEGRADED_WINDOW_MS = 30 * 60_000;
const KEY = Symbol.for("newme.intakeDegraded");

const store = () => (globalThis[KEY] ??= new Map());

/** Remember that `channel` ("whatsapp") ran degraded just now. */
export function markIntakeDegraded(channel, now = Date.now()) {
  store().set(String(channel), now);
}

/** Channels that ran degraded within the window, e.g. { whatsapp: "degraded" }; {} when everything is normal. */
export function intakeDegradedSnapshot(now = Date.now(), windowMs = INTAKE_DEGRADED_WINDOW_MS) {
  const out = {};
  for (const [channel, at] of store()) if (now - at <= windowMs) out[channel] = "degraded";
  return out;
}

export function resetIntakeDegraded() {
  store().clear();
}
