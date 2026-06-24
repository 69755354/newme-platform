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
  const now = new Date().toISOString();

  // Tasks are the source of truth for overdue follow-ups.
  const { data: overdueTasks, error } = await supabase
    .from("tasks")
    .select("id, lead_id, due_at, assignee_id, leads!inner(customer_name, final_status)")
    .is("completed_at", null)
    .lt("due_at", now)
    .not("assignee_id", "is", null);

  if (error) {
    console.error("[cron/overdue-followups] Query error:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }

  const overdueFollowups = (overdueTasks ?? []).flatMap((task: any) => {
    const lead = Array.isArray(task.leads) ? task.leads[0] : task.leads;
    if (!lead || lead.final_status) return [];
    return [{ ...task, lead }];
  });

  if (overdueFollowups.length === 0) {
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

  for (const task of overdueFollowups) {
    const customerName = task.lead.customer_name || "Unnamed";
    const overdueDays = Math.floor(
      (Date.now() - new Date(task.due_at).getTime()) / 86_400_000
    );

    // Notify assigned salesperson
    if (task.assignee_id) {
      notifications.push({
        userId: task.assignee_id,
        type: "follow_up_overdue",
        title: `Overdue follow-up: ${customerName}`,
        body: `Follow-up for "${customerName}" is ${overdueDays} day(s) overdue.`,
        relatedId: task.lead_id,
        relatedType: "lead",
      });
    }

    // Also notify admins
    for (const adminId of adminIds) {
      if (adminId === task.assignee_id) continue; // don't double-notify
      notifications.push({
        userId: adminId,
        type: "follow_up_overdue",
        title: `Overdue follow-up: ${customerName}`,
        body: `Follow-up for "${customerName}" (assigned to sales) is ${overdueDays} day(s) overdue.`,
        relatedId: task.lead_id,
        relatedType: "lead",
      });
    }
  }

  // Deduplicate: check existing notifications from last 7d
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentNotifs } = await supabase
    .from("notifications")
    .select("user_id, type, related_id")
    .in("type", ["follow_up_overdue"])
    .gte("created_at", sevenDaysAgo);

  const recentKeys = new Set(
    (recentNotifs || []).map((n) => `${n.user_id}:${n.type}:${n.related_id}`)
  );

  // Filter out duplicates
  const deduped = notifications.filter((n) => {
    const key = `${n.userId}:${n.type}:${n.relatedId}`;
    if (recentKeys.has(key)) return false;
    recentKeys.add(key); // prevent duplicates within same batch
    return true;
  });

  // Insert notifications in batches to avoid too-large inserts
  const batchSize = 50;
  let inserted = 0;
  for (let i = 0; i < deduped.length; i += batchSize) {
    const batch = deduped.slice(i, i + batchSize).map((n) => ({
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
    leadsChecked: overdueFollowups.length,
    notificationsCreated: inserted,
    skippedDuplicates: notifications.length - deduped.length,
    today: now,
  });
}
