import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger } from "@/lib/logger";
import { AUDIT_ACTIONS, accountKey, buildAuditRow, createThrottle } from "@/lib/audit-log-row.mjs";

export { AUDIT_ACTIONS, accountKey };

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

const failureThrottle = createThrottle();

/**
 * Best-effort application-layer audit write into audit_logs (actor id only).
 * Never throws and never blocks the caller beyond the one insert: an audit
 * outage must not lock people out of the system, but it is logged at error
 * level so it reaches Sentry.
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    if (entry.action === AUDIT_ACTIONS.LOGIN_FAILURE) {
      const key = `${String(entry.details?.account_key ?? "")}:${String(entry.details?.reason ?? "")}`;
      if (!failureThrottle(key)) return;
    }
    const row = buildAuditRow(entry);
    const { error } = await supabaseAdmin.from("audit_logs").insert(row);
    if (error) {
      logger.error({ operation: "audit_log_write", code: "audit_insert_failed", audit_action: row.action }, "audit log write failed");
    }
  } catch {
    logger.error({ operation: "audit_log_write", code: "audit_write_threw" }, "audit log write failed");
  }
}
