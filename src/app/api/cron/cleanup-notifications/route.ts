// RBAC: cron (x-cron-secret)
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createIntegrationLogSinks } from "@/lib/integration-execution.mjs";
import { genReqId, logger } from "@/lib/logger";

/**
 * GET /api/cron/cleanup-notifications
 * Cron endpoint: deletes notifications older than 90 days.
 *
 * Authorization: x-cron-secret header (matches all other cron routes).
 * Set CRON_SECRET env var and pass it as x-cron-secret header.
 */
export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const sinks = createIntegrationLogSinks({
    logger,
    requestId: genReqId(),
    route: "/api/cron/cleanup-notifications",
  });
  const reportFailure = async (reason: string) => {
    const event = {
      integration: "cron_notification_cleanup",
      operation: "scheduled_notification_cleanup",
      outcome: "failure",
      attempts: 1,
      reason,
    };
    await sinks.audit(event);
    await sinks.alert(event);
  };

  // Calculate cutoff date (90 days ago)
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 90);
  const cutoffISO = cutoffDate.toISOString();

  // First count how many will be deleted
  const { count, error: countErr } = await supabaseAdmin
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .lt("created_at", cutoffISO);

  if (countErr) {
    await reportFailure("cleanup_count_failed");
    return NextResponse.json({ error: "Count query failed" }, { status: 500 });
  }

  if (!count || count === 0) {
    await sinks.audit({
      integration: "cron_notification_cleanup",
      operation: "scheduled_notification_cleanup",
      outcome: "success",
      attempts: 1,
      reason: null,
    });
    return NextResponse.json({
      message: "No notifications to clean up",
      deleted: 0,
      cutoffDate: cutoffISO,
    });
  }

  // Delete in batches to avoid timeouts on large datasets
  const batchSize = 500;
  let deleted = 0;

  while (true) {
    const { data: batch, error: selectErr } = await supabaseAdmin
      .from("notifications")
      .select("id")
      .lt("created_at", cutoffISO)
      .limit(batchSize);

    if (selectErr) {
      await reportFailure("cleanup_select_failed");
      return NextResponse.json(
        { error: "Cleanup select failed", deleted, expectedCount: count },
        { status: 502 },
      );
    }

    if (!batch || batch.length === 0) break;

    const ids = batch.map((n: { id: string }) => n.id);
    const { error: deleteErr } = await supabaseAdmin
      .from("notifications")
      .delete()
      .in("id", ids);

    if (deleteErr) {
      await reportFailure("cleanup_delete_failed");
      return NextResponse.json(
        { error: "Cleanup delete failed", deleted, expectedCount: count },
        { status: 502 },
      );
    }

    deleted += ids.length;
  }

  await sinks.audit({
    integration: "cron_notification_cleanup",
    operation: "scheduled_notification_cleanup",
    outcome: "success",
    attempts: 1,
    reason: null,
  });
  return NextResponse.json({
    message: "Cleanup complete",
    deleted,
    expectedCount: count,
    cutoffDate: cutoffISO,
  });
}
