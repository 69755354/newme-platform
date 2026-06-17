import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getAdminUserIds } from "@/lib/notifications";

/**
 * GET /api/cron/check-overdue-followups
 * Cron endpoint: checks all leads for overdue follow-ups and creates notifications.
 *
 * Called by external cron (Hermes) — validates via CRON_SECRET header.
 */
export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = supabaseAdmin;
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

  // Dedup: check existing notifications of same type for each lead (permanent)
  const userIds = [...new Set(overdueLeads.map((l) => l.assigned_to).filter(Boolean))];
  const { data: existingNotifs } = await supabase
    .from("notifications")
    .select("related_id, user_id, type")
    .eq("type", "follow_up_overdue")
    .in("user_id", userIds);

  const existingKeys = new Set(
    (existingNotifs || []).map((n) => `${n.related_id}:${n.user_id}:${n.type}`)
  );

  for (const lead of overdueLeads) {
    const customerName = lead.customer_name || "Unnamed";
    const overdueDays = Math.floor(
      (Date.now() - new Date(lead.next_followup_date).getTime()) / 86_400_000
    );

    // Notify assigned salesperson
    if (lead.assigned_to) {
      const dedupKey = `${lead.id}:${lead.assigned_to}:follow_up_overdue`;
      if (!existingKeys.has(dedupKey)) {
        notifications.push({
          userId: lead.assigned_to,
          type: "follow_up_overdue",
          title: `Overdue follow-up: ${customerName}`,
          body: `Follow-up for "${customerName}" is ${overdueDays} day(s) overdue.`,
          relatedId: lead.id,
          relatedType: "lead",
        });
        existingKeys.add(dedupKey);
      }
    }

    // Also notify admins
    for (const adminId of adminIds) {
      if (adminId === lead.assigned_to) continue;
      const dedupKey = `${lead.id}:${adminId}:follow_up_overdue`;
      if (!existingKeys.has(dedupKey)) {
        notifications.push({
          userId: adminId,
          type: "follow_up_overdue",
          title: `Overdue follow-up: ${customerName}`,
          body: `Follow-up for "${customerName}" (assigned to sales) is ${overdueDays} day(s) overdue.`,
          relatedId: lead.id,
          relatedType: "lead",
        });
        existingKeys.add(dedupKey);
      }
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
