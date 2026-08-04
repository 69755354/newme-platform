import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { parseObject, text } from "@/lib/shared-operations";

type ClaimedJob = {
  id: string;
  organization_id: string;
  requested_by: string;
  kind: "work_items_import" | "organization_export" | "operations_report";
  parameters: unknown;
};

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function processImport(job: ClaimedJob) {
  const parameters = parseObject(job.parameters);
  const items = Array.isArray(parameters?.items) ? parameters.items : null;
  if (!items || items.length < 1 || items.length > 100) throw new Error("shared_import_items_invalid");
  const rows = items.map((candidate, index) => {
    const item = parseObject(candidate);
    const titleCode = text(item?.title_code, 64);
    if (!item || !titleCode) throw new Error("shared_import_item_invalid");
    return {
      organization_id: job.organization_id,
      title: `Imported work item ${titleCode}`,
      priority: text(item.priority, 16) ?? "normal",
      created_by: job.requested_by,
      idempotency_key: `job:${job.id}:item:${index}`,
    };
  });
  const { data, error } = await supabaseAdmin.from("shared_work_items").upsert(rows, {
    onConflict: "organization_id,idempotency_key", ignoreDuplicates: true,
  }).select("id");
  if (error) throw new Error("shared_import_write_failed");
  return { counts: { imported: data?.length ?? 0, requested: rows.length }, sha256: digest(rows.map((row) => row.idempotency_key)) };
}

async function processExport(job: ClaimedJob) {
  const { data, error } = await supabaseAdmin.rpc("v4_export_organization_customer_data", {
    p_organization_id: job.organization_id,
    p_actor_user_id: job.requested_by,
    p_request_id: `shared-job-${job.id}`,
  });
  if (error || !parseObject(data)) throw new Error("shared_export_failed");
  const exported = parseObject(data);
  const packageData = parseObject(exported?.data);
  return {
    counts: { sections: packageData ? Object.keys(packageData).length : 0 },
    sha256: digest(data),
  };
}

async function processReport(job: ClaimedJob) {
  const [work, approvals, notifications, jobs] = await Promise.all([
    supabaseAdmin.from("shared_work_items").select("id", { count: "exact", head: true }).eq("organization_id", job.organization_id),
    supabaseAdmin.from("shared_approval_requests").select("id", { count: "exact", head: true }).eq("organization_id", job.organization_id),
    supabaseAdmin.from("shared_notifications").select("id", { count: "exact", head: true }).eq("organization_id", job.organization_id),
    supabaseAdmin.from("shared_jobs").select("id", { count: "exact", head: true }).eq("organization_id", job.organization_id),
  ]);
  if ([work, approvals, notifications, jobs].some((result) => result.error)) {
    throw new Error("shared_report_query_failed");
  }
  const counts = {
    work_items: work.count ?? 0,
    approvals: approvals.count ?? 0,
    notifications: notifications.count ?? 0,
    jobs: jobs.count ?? 0,
  };
  return { counts, sha256: digest(counts) };
}

export async function runSharedOperationsWorker() {
  const workerId = `shared-${randomUUID()}`;
  const { data: outbox, error: outboxClaimError } = await supabaseAdmin.rpc("v4_claim_shared_outbox", {
    p_batch_size: 50, p_worker_id: workerId, p_lease_seconds: 120,
  });
  if (outboxClaimError) throw new Error("shared_outbox_claim_failed");
  let deliveredEvents = 0;
  for (const event of Array.isArray(outbox) ? outbox : []) {
    const eventObject = parseObject(event);
    if (!eventObject || typeof eventObject.id !== "string") continue;
    const { error } = await supabaseAdmin.rpc("v4_complete_shared_outbox", {
      p_outbox_id: eventObject.id, p_worker_id: workerId,
      p_succeeded: true, p_error_code: null,
    });
    if (!error) deliveredEvents += 1;
  }

  const { data: pendingNotifications, error: pendingNotificationError } = await supabaseAdmin
    .from("shared_notifications").select("id").eq("channel", "in_app")
    .eq("state", "pending").order("created_at", { ascending: true }).limit(100);
  if (pendingNotificationError) throw new Error("shared_notification_claim_failed");
  let deliveredNotifications = 0;
  const notificationIds = (pendingNotifications ?? []).map((row) => row.id);
  if (notificationIds.length > 0) {
    const { data, error } = await supabaseAdmin.from("shared_notifications").update({
      state: "delivered", delivered_at: new Date().toISOString(),
    }).in("id", notificationIds).eq("state", "pending").select("id");
    if (error) throw new Error("shared_notification_delivery_failed");
    deliveredNotifications = data?.length ?? 0;
  }

  const { data: claimedJobs, error: jobClaimError } = await supabaseAdmin.rpc("v4_claim_shared_jobs", {
    p_batch_size: 10, p_worker_id: workerId, p_lease_seconds: 300,
  });
  if (jobClaimError) throw new Error("shared_jobs_claim_failed");
  let completedJobs = 0;
  let failedJobs = 0;
  for (const raw of Array.isArray(claimedJobs) ? claimedJobs : []) {
    const job = raw as unknown as ClaimedJob;
    try {
      const result = job.kind === "work_items_import"
        ? await processImport(job)
        : job.kind === "organization_export"
          ? await processExport(job)
          : await processReport(job);
      const { error } = await supabaseAdmin.rpc("v4_complete_shared_job", {
        p_job_id: job.id, p_worker_id: workerId, p_succeeded: true,
        p_result_counts: result.counts, p_result_sha256: result.sha256, p_error_code: null,
      });
      if (error) throw new Error("shared_job_complete_failed");
      completedJobs += 1;
    } catch (error) {
      const code = error instanceof Error && /^[a-z][a-z0-9_.-]{2,95}$/.test(error.message)
        ? error.message : "shared_job_failed";
      await supabaseAdmin.rpc("v4_complete_shared_job", {
        p_job_id: job.id, p_worker_id: workerId, p_succeeded: false,
        p_result_counts: {}, p_result_sha256: null, p_error_code: code,
      });
      failedJobs += 1;
    }
  }
  return { delivered_events: deliveredEvents, delivered_notifications: deliveredNotifications,
    completed_jobs: completedJobs, failed_jobs: failedJobs };
}
