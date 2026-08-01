// RBAC: cron (x-cron-secret)
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createIntegrationLogSinks } from "@/lib/integration-execution.mjs";
import { genReqId, logger } from "@/lib/logger";

type OverduePlan = {
  id: string;
  organization_id: string;
  contract_id: string;
  seq: number;
  amount: number;
  due_date: string;
};
type NotificationFailure = { installment_id: string; reason: string };

async function createOverdueNotifications(plan: OverduePlan): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [{ data: memberships, error: membershipsError }, { data: contract, error: contractError }] = await Promise.all([
    supabaseAdmin
      .from("memberships")
      .select("user_id")
      .eq("organization_id", plan.organization_id)
      .eq("status", "active"),
    supabaseAdmin
      .from("contracts")
      .select("sales_id")
      .eq("organization_id", plan.organization_id)
      .eq("id", plan.contract_id)
      .single(),
  ]);
  if (membershipsError) return { ok: false, reason: "membership_lookup_failed" };
  if (contractError || !contract) return { ok: false, reason: "contract_lookup_failed" };

  const memberIds = [...new Set((memberships ?? []).map((membership) => membership.user_id))];
  if (memberIds.length === 0) return { ok: false, reason: "no_active_members" };
  const { data: profiles, error: profilesError } = await supabaseAdmin
    .from("profiles")
    .select("id, role")
    .in("id", memberIds)
    .eq("is_active", true);
  if (profilesError) return { ok: false, reason: "profile_lookup_failed" };

  const activeProfileIds = new Set((profiles ?? []).map((profile) => profile.id));
  const recipientIds = new Set(
    (profiles ?? [])
      .filter((profile) => profile.role === "admin" || profile.role === "boss")
      .map((profile) => profile.id),
  );
  if (contract.sales_id && activeProfileIds.has(contract.sales_id)) {
    recipientIds.add(contract.sales_id);
  }
  if (recipientIds.size === 0) return { ok: false, reason: "no_recipients" };

  const { data: existingNotifications, error: existingError } = await supabaseAdmin
    .from("notifications")
    .select("user_id")
    .eq("type", "payment_overdue")
    .eq("related_id", plan.id)
    .eq("related_type", "payment");
  if (existingError) return { ok: false, reason: "notification_lookup_failed" };

  const existingRecipientIds = new Set((existingNotifications ?? []).map((notification: { user_id: string }) => notification.user_id));
  const missingRecipientIds = [...recipientIds].filter((userId) => !existingRecipientIds.has(userId));
  if (missingRecipientIds.length === 0) return { ok: true };

  const { error: insertError } = await supabaseAdmin.from("notifications").insert(
    missingRecipientIds.map((userId) => ({
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
  const sinks = createIntegrationLogSinks({
    logger,
    requestId: genReqId(),
    route: "/api/cron/check-overdue-installments",
  });
  const reportFailure = async (reason: string, attempts = 1) => {
    const event = {
      integration: "cron_overdue_installments",
      operation: "scheduled_overdue_delivery",
      outcome: "failure",
      attempts,
      reason,
    };
    await sinks.audit(event);
    await sinks.alert(event);
  };

  try {
    const today = new Date().toISOString().slice(0, 10);

    // Read first. A plan becomes overdue only after its notification write succeeds,
    // which keeps a failed notification eligible for the next cron run.
    const { data: overdue, error: overdueQueryError } = await supabaseAdmin
      .from("installment_plans")
      .select("id, organization_id, contract_id, seq, amount, due_date")
      .in("status", ["pending", "partial"])
      .lt("due_date", today);

    if (overdueQueryError) {
      await reportFailure("overdue_query_failed");
      return NextResponse.json({ error: "Overdue query failed" }, { status: 500 });
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
          const { data: updatedPlan, error: statusUpdateError } = await supabaseAdmin
            .from("installment_plans")
            .update({ status: "overdue", updated_at: new Date().toISOString() })
            .eq("id", plan.id)
            .eq("organization_id", plan.organization_id)
            .in("status", ["pending", "partial"])
            .select("id")
            .maybeSingle();
          if (statusUpdateError || !updatedPlan) {
            notificationFailures.push({ installment_id: plan.id, reason: "status_update_failed" });
            console.error("[Cron Overdue] Status update failed", { installment_id: plan.id, statusUpdateError });
          } else {
            notified.push(plan.id);
          }
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
      await reportFailure("notification_delivery_failed");
      return NextResponse.json(result, { status: 502 });
    }
    await sinks.audit({
      integration: "cron_overdue_installments",
      operation: "scheduled_overdue_delivery",
      outcome: "success",
      attempts: 1,
      reason: null,
    });
    return NextResponse.json(result);
  } catch {
    await reportFailure("unexpected_cron_failure");
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
