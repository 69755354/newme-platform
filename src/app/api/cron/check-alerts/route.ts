import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createNotification, createNotificationsBulk, getAdminUserIds } from "@/lib/notifications";

/**
 * GET /api/cron/check-alerts
 * Cron endpoint: scans lead_alerts view for active alerts,
 * notifies assigned users and admins about new/ongoing issues.
 * Deduplicates by checking existing notifications within last 12h.
 * Called by external cron (Hermes) — validates via CRON_SECRET.
 */
export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    // 1. Fetch all active alerts from the view
    const { data: alerts, error: alertErr } = await supabaseAdmin
      .from("lead_alerts")
      .select("*")
      .not("alert_type", "is", null)
      .order("severity", { ascending: true });

    if (alertErr) {
      console.error("[Cron Alerts] View query failed:", alertErr);
      return NextResponse.json({ error: "Failed to query alerts" }, { status: 500 });
    }

    if (!alerts || alerts.length === 0) {
      return NextResponse.json({ message: "No alerts", count: 0 });
    }

    // 2. Check recently sent notifications to deduplicate (last 24h)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentNotifs } = await supabaseAdmin
      .from("notifications")
      .select("related_id, type")
      .in("type", [
        "followup_reminder",
        "follow_up_overdue",
      ])
      .gte("created_at", since);

    const recentKeys = new Set(
      (recentNotifs || []).map((n) => `${n.related_id}:${n.type}`)
    );

    // 3. Group alerts and create notifications
    const adminIds = await getAdminUserIds();
    let notifiedUsers = 0;
    let notifiedAdmins = 0;
    let skipped = 0;

    for (const alert of alerts) {
      // Determine notification type
      let notifType: string;
      let title: string;
      const name = alert.customer_name || "未知客户";

      switch (alert.alert_type) {
        case "due_today":
          notifType = "followup_reminder";
          title = `今日跟进提醒: ${name}`;
          break;
        case "overdue_followup":
          notifType = "follow_up_overdue";
          title = `逾期未跟进: ${name}`;
          break;
        case "stale_lead":
          notifType = "follow_up_overdue";
          title = `线索停滞: ${name}`;
          break;
        case "over_contacted":
          notifType = "followup_reminder";
          title = `过度联系警告: ${name}`;
          break;
        case "high_value_stuck":
          notifType = "follow_up_overdue";
          title = `高金额卡住: ${name}`;
          break;
        case "no_contact":
          notifType = "followup_reminder";
          title = `未联系线索: ${name}`;
          break;
        default:
          continue;
      }

      const dedupKey = `${alert.id}:${notifType}`;
      if (recentKeys.has(dedupKey)) {
        skipped++;
        continue;
      }
      recentKeys.add(dedupKey); // prevent duplicates within same batch

      // Notify assigned user
      if (alert.assigned_to) {
        await createNotification({
          userId: alert.assigned_to,
          type: notifType,
          title,
          body: alert.alert_message,
          relatedId: alert.id,
          relatedType: "lead",
        });
        notifiedUsers++;
      }

      // Notify admins for red-severity alerts
      if (alert.severity === "red" && adminIds.length > 0) {
        const adminNotifs = adminIds.map((adminId) => ({
          userId: adminId,
          type: notifType,
          title: `[管理] ${title}`,
          body: alert.alert_message,
          relatedId: alert.id,
          relatedType: "lead",
        }));
        await createNotificationsBulk(adminNotifs);
        notifiedAdmins += adminIds.length;
      }
    }

    return NextResponse.json({
      total_alerts: alerts.length,
      notified_users: notifiedUsers,
      notified_admins: notifiedAdmins,
      skipped_duplicates: skipped,
    });
  } catch (err: unknown) {
    console.error("[Cron Alerts] Error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
