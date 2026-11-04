// Pure helpers for application-layer audit rows (S7, review 5-logging-monitoring
// "审计表"). Rows record WHO (actor id only) did WHAT to WHICH object; they never
// carry e-mail, names, notes, request bodies, IPs or free text. audit_logs is
// server-write-only (migration 20260811100000), so rows are written with the
// service client from route handlers.
import { createHash } from "node:crypto";
import { sanitizeValue } from "./observability.mjs";

export const AUDIT_ACTIONS = Object.freeze({
  LOGIN_SUCCESS: "login_success",
  LOGIN_FAILURE: "login_failure",
  USER_CREATED: "user_created",
  ROLE_ASSIGNED: "role_assigned",
  DATA_EXPORT: "data_export",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_DETAIL_VALUE = /^[A-Za-z0-9_.:/-]{1,64}$/;

/** Short pseudonymous key for a login attempt target; the address itself is never stored. */
export function accountKey(email) {
  return createHash("sha256").update(String(email ?? "").trim().toLowerCase()).digest("hex").slice(0, 16);
}

/**
 * Build the insert payload. Detail values are restricted to short codes and
 * numbers, so a caller cannot smuggle a name or a note into the audit trail.
 */
/**
 * @param {{ actorId?: string | null, action: string, targetType?: string | null, targetId?: string | null, details?: Record<string, unknown> }} entry
 */
export function buildAuditRow({ actorId = null, action, targetType = null, targetId = null, details = {} }) {
  if (typeof action !== "string" || !/^[a-z][a-z0-9_]{2,47}$/.test(action)) throw new Error("audit_action_invalid");
  const safe = {};
  for (const [key, value] of Object.entries(sanitizeValue(details) ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === "boolean") safe[key] = value;
    else if (typeof value === "string" && SAFE_DETAIL_VALUE.test(value)) safe[key] = value;
  }
  return {
    actor_id: typeof actorId === "string" && UUID.test(actorId) ? actorId : null,
    action,
    target_type: typeof targetType === "string" ? targetType.slice(0, 40) : null,
    target_id: typeof targetId === "string" && UUID.test(targetId) ? targetId : null,
    details: safe,
  };
}

/**
 * Failed-login rows are throttled per (account key, reason) so a password-spray
 * cannot turn the audit table into a write amplifier.
 */
export function createThrottle({ windowMs = 60_000, maxKeys = 2000, now = Date.now } = {}) {
  const seen = new Map();
  return function allow(key) {
    const t = now();
    const last = seen.get(key);
    if (last !== undefined && t - last < windowMs) return false;
    if (seen.size >= maxKeys) {
      for (const [k, at] of seen) if (t - at >= windowMs) seen.delete(k);
      if (seen.size >= maxKeys) return false;
    }
    seen.set(key, t);
    return true;
  };
}
