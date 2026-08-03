// RBAC: cron (x-cron-secret)
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  dailyReminderBusinessDate,
  dailyReminderDeliveryResult,
  deliverDailyReminderNotifications,
  type DailyReminderTask,
} from "@/lib/daily-reminder-result";

export async function GET(request: Request) {
  return handleCron(request);
}

export async function POST(request: Request) {
  return handleCron(request);
}

async function handleCron(request: Request) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const { data: tasks, error: tasksError } = await supabaseAdmin
      .from("tasks")
      .select(`
        id,
        organization_id,
        title,
        assignee_id,
        due_at,
        leads ( id, customer_name )
      `)
      .eq("status", "pending")
      .gte("due_at", startOfDay.toISOString())
      .lte("due_at", endOfDay.toISOString());

    if (tasksError) {
      return NextResponse.json({ error: tasksError.message }, { status: 500 });
    }

    if (!tasks || tasks.length === 0) {
      return NextResponse.json({ checked: 0, notificationsCreated: 0 });
    }

    const reminderTasks = tasks.flatMap<DailyReminderTask>((task) => {
      if (!task.assignee_id || !task.organization_id) return [];
      return [{
        id: task.id,
        organizationId: task.organization_id,
        assigneeId: task.assignee_id,
        title: task.title,
        customerName: task.leads?.[0]?.customer_name ?? null,
      }];
    });

    const delivery = await deliverDailyReminderNotifications(
      reminderTasks,
      dailyReminderBusinessDate(now),
      async (notification) => {
        const { data, error: notificationError } = await supabaseAdmin
          .from("notifications")
          .upsert(notification, {
            onConflict: "organization_id,user_id,event_key",
            ignoreDuplicates: true,
          })
          .select("id");
        if (notificationError) throw new Error("notification_write_failed");
        return (data?.length ?? 0) > 0;
      },
    );

    const outcome = dailyReminderDeliveryResult(
      tasks.length,
      delivery.notificationsCreated,
      delivery.notificationFailures,
    );
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
