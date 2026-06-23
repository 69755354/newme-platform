import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { createNotification, getAdminUserIds } from "@/lib/notifications";

/**
 * GET /api/cron/check-overdue-followups
 * Cron endpoint: checks all leads for overdue follow-ups and creates notifications.
 *
 * Authorization: cron secret token (required in production).
 * Set CRON_SECRET env var and pass it as ?token=xxx.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");
  if (token !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createServerSupabase();
  const today = new Date().toISOString().split("T")[0];

  // Fetch all leads with overdue follow-ups (not won/lost, with assigned sales rep)
  const { data: overdueLeads, error } = await supabase
    .from("leads")
    .select("id, customer_name, assigned_to, next_followup_date")
    .not("stage", "in", '("won","lost")')
    .lte("next_followup_date", today)
    .not("assigned_to", "is", null);

  if (error) {
    console.error("[cron/overdue-followups] Query error:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }

  if (!overdueLeads || overdueLeads.length === 0) {
    return NextResponse.json({ message: "No overdue follow-ups", count: 0 });
  }

  // Also notify admins (in addition to assigned salesperson)
  const adminIds = await getAdminUserIds();
  const notifications: {
    userId: string;
    type: string;
    title: string;
    body: string;
    relatedId: string;
    relatedType: string;
  }[] = [];

  for (const lead of overdueLeads) {
    const customerName = lead.customer_name || "Unnamed";
    const overdueDays = Math.floor(
      (Date.now() - new Date(lead.next_followup_date).getTime()) / 86_400_000
    );

    // Notify assigned salesperson
    if (lead.assigned_to) {
      notifications.push({
        userId: lead.assigned_to,
        type: "follow_up_overdue",
        title: `Overdue follow-up: ${customerName}`,
        body: `Follow-up for "${customerName}" is ${overdueDays} day(s) overdue.`,
        relatedId: lead.id,
        relatedType: "lead",
      });
    }

    // Also notify admins
    for (const adminId of adminIds) {
      if (adminId === lead.assigned_to) continue; // don't double-notify
      notifications.push({
        userId: adminId,
        type: "follow_up_overdue",
        title: `Overdue follow-up: ${customerName}`,
        body: `Follow-up for "${customerName}" (assigned to sales) is ${overdueDays} day(s) overdue.`,
        relatedId: lead.id,
        relatedType: "lead",
      });
    }
  }

  // Insert notifications in batches to avoid too-large inserts
  const batchSize = 50;
  let inserted = 0;
  for (let i = 0; i < notifications.length; i += batchSize) {
    const batch = notifications.slice(i, i + batchSize).map((n) => ({
      user_id: n.userId,
      type: n.type,
      title: n.title,
      body: n.body,
      related_id: n.relatedId,
      related_type: n.relatedType,
    }));
    const { error: insertErr } = await supabase.from("notifications").insert(batch);
    if (insertErr) {
      console.error("[cron/overdue-followups] Batch insert error:", insertErr);
    } else {
      inserted += batch.length;
    }
  }

  return NextResponse.json({
    message: "Overdue follow-ups processed",
    leadsChecked: overdueLeads.length,
    notificationsCreated: inserted,
    today,
  });
}
