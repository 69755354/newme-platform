export function dailyReminderDeliveryResult(
  checked: number,
  notificationsCreated: number,
  notificationFailures: number,
) {
  if (notificationFailures > 0) {
    return {
      status: 502,
      body: {
        error: "notification_delivery_failed",
        checked,
        notificationsCreated,
        notificationFailures,
      },
    } as const;
  }
  return {
    status: 200,
    body: { checked, notificationsCreated, notificationFailures },
  } as const;
}

export interface DailyReminderTask {
  id: string;
  organizationId: string;
  assigneeId: string;
  title: string;
  customerName?: string | null;
}

export interface DailyReminderNotification {
  organization_id: string;
  user_id: string;
  type: "followup_reminder";
  title: string;
  body: string;
  related_id: string;
  related_type: null;
  event_key: string;
}

export function dailyReminderBusinessDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dailyReminderEventKey(taskId: string, businessDate: string): string {
  return `daily-reminder:task:${taskId}:due-on:${businessDate}`;
}

export function buildDailyReminderNotification(
  task: DailyReminderTask,
  businessDate: string,
): DailyReminderNotification {
  const customerSuffix = task.customerName ? ` (${task.customerName})` : "";
  return {
    organization_id: task.organizationId,
    user_id: task.assigneeId,
    type: "followup_reminder",
    title: "Today's task reminder",
    body: `${task.title}${customerSuffix} is due today.`,
    related_id: task.id,
    // The baseline relation constraint does not define a `task` discriminator.
    related_type: null,
    event_key: dailyReminderEventKey(task.id, businessDate),
  };
}

export async function deliverDailyReminderNotifications(
  tasks: DailyReminderTask[],
  businessDate: string,
  write: (notification: DailyReminderNotification) => Promise<boolean>,
) {
  let notificationsCreated = 0;
  let notificationFailures = 0;
  for (const task of tasks) {
    try {
      if (await write(buildDailyReminderNotification(task, businessDate))) {
        notificationsCreated++;
      }
    } catch {
      notificationFailures++;
    }
  }
  return { notificationsCreated, notificationFailures };
}
