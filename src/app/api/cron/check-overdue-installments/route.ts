// RBAC: cron (x-cron-secret)
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

type OverduePlan = { id: string; contract_id: string; seq: number; amount: number; due_date: string };
type NotificationFailure = { installment_id: string; reason: string };

async function createOverdueNotifications(plan: OverduePlan): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [{ data: admins, error: adminsError }, { data: contract, error: contractError }] = await Promise.all([
    supabaseAdmin.from("profiles").select("id").in("role", ["admin", "boss"]).eq("is_active", true),
    supabaseAdmin.from("contracts").select("sales_id").eq("id", plan.contract_id).single(),
  ]);
  if (adminsError) return { ok: false, reason: "admin_lookup_failed" };
  if (contractError || !contract) return { ok: false, reason: "contract_lookup_failed" };

  const recipientIds = new Set((admins ?? []).map((admin: { id: string }) => admin.id));
  if (contract.sales_id) recipientIds.add(contract.sales_id);
  if (recipientIds.size === 0) return { ok: false, reason: "no_recipients" };

  const { error: insertError } = await supabaseAdmin.from("notifications").insert(
    [...recipientIds].map((userId) => ({
      user_id: userId,
      type: "payment_overdue",
      title: `Overdue installment: AED ${plan.amount}`,
      body: `Installment ${plan.seq} was due on ${plan.due_date}.`,
      related_id: plan.id,
      related_type: "payment",
    })),
  );
  if (insertError) return { ok: false, reason: "notification_insert_failed" };
  return { ok: true };
}

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
    const notificationFailures: NotificationFailure[] = [];
    if (overdue && overdue.length > 0) {
      for (const plan of overdue) {
        // notifications has no uniqueness constraint for this event; do not retry
        // an ambiguous insert failure or it may duplicate payment alerts.
        const delivery = await createOverdueNotifications(plan);
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
