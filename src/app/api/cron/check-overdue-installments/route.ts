// RBAC: cron (x-cron-secret)
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { deliverOverdueNotification } from "@/lib/cron-overdue-notification";

/**
 * GET /api/cron/check-overdue-installments
 * Cron endpoint: scans installment_plans and marks overdue items.
 * Called by external cron (Hermes) — validates via CRON_SECRET.
 */
export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const today = new Date().toISOString().slice(0, 10);

    // Mark pending installments past due_date as overdue
    const { data: overdue, error: updateErr } = await supabaseAdmin
      .from("installment_plans")
      .update({ status: "overdue", updated_at: new Date().toISOString() })
      .in("status", ["pending", "partial"])
      .lt("due_date", today)
      .select("id, contract_id, seq, amount, due_date");

    if (updateErr) {
      console.error("[Cron Overdue] Update failed:", updateErr);
      return NextResponse.json({ error: "Update failed" }, { status: 500 });
    }

    // Notify about newly overdue installments
    const notified: string[] = [];
    const notificationFailures: Array<{ installment_id: string; reason: string }> = [];
    if (overdue && overdue.length > 0) {
      for (const plan of overdue) {
        const delivery = await deliverOverdueNotification(plan);
        if (delivery.ok) {
          notified.push(plan.id);
        } else {
          notificationFailures.push({ installment_id: plan.id, reason: delivery.reason });
          console.error("[Cron Overdue] Notification delivery failed", {
            installment_id: plan.id,
            contract_id: plan.contract_id,
            reason: delivery.reason,
          });
        }
      }
    }

    const result = {
      overdue_count: overdue?.length ?? 0,
      notified: notified.length,
      notification_failures: notificationFailures.length,
      failures: notificationFailures,
    };
    if (notificationFailures.length > 0) {
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (err: unknown) {
    console.error("[Cron Overdue] Error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
