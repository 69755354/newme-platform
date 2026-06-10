/**
 * Client-side helper to trigger notifications via /api/notify.
 * Called after business actions complete (assign lead, stage change, etc.).
 * Fire-and-forget: errors are logged but don't block the UI.
 */

interface NotifyParams {
  type: "lead_created" | "lead_assigned" | "lead_stage_change" | "lead_stage_changed" | "quote_created" | "contract_created" | "contract_signed" | "payment_due" | "payment_received" | "payment_overdue" | "first_payment_reminder" | "kpi_target_set" | "followup_reminder" | "follow_up_overdue" | "team_member_added";
  [key: string]: any;
}

export async function notify(params: NotifyParams): Promise<void> {
  try {
    const res = await fetch("/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn("[notify] Failed:", res.status, err);
    }
  } catch (e) {
    console.warn("[notify] Network error:", e);
  }
}
