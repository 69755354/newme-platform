// RBAC: user (admin, boss)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import {
  createNotification,
  getAdminUserIds,
} from "@/lib/notifications";
import { logger, genReqId } from "@/lib/logger";
import { moneyRpcFailure } from "@/lib/money-rpc.mjs";

/**
 * POST /api/contracts/[id]/revoke
 * Initiate contract revocation or superseding.
 *
 * Authorization is decided inside revoke_contract() by money_actor(), which reads
 * the actor from the JWT subject rather than from anything the caller sends, and
 * requires an active admin/boss profile. A 403 from this route is that check.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const request_id = genReqId();
  const { id: contractId } = await params;
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { reason, supersede } = body;

    if (!reason || typeof reason !== "string") {
      return NextResponse.json(
        { error: "reason is required" },
        { status: 400 }
      );
    }

    // revoke_contract() takes the row FOR UPDATE, re-reads the status inside the
    // same transaction and checks the role against the token subject. The
    // read-then-write this replaces let two concurrent requests both pass the
    // "already superseded" test, and its role check was a separate statement from
    // the write — while trg_guard_contracts_write now refuses a direct status
    // write from the caller's client outright.
    const { data: result, error: rpcErr } = await supabase.rpc("revoke_contract", {
      p_contract_id: contractId,
      p_reason: reason,
      p_supersede: supersede === true,
    });

    if (rpcErr) {
      const failure = moneyRpcFailure(rpcErr, "Failed to update contract status");
      const log = failure.status >= 500 ? logger.error : logger.warn;
      log(
        {
          err: rpcErr,
          request_id,
          operation: "contract_revoke",
          user_id: user.id,
          contract_id: contractId,
          error_code: rpcErr.code,
          http_status: failure.status,
        },
        "[Revoke Contract] revoke_contract refused the request",
      );
      return NextResponse.json(failure.body, { status: failure.status });
    }

    const contract = result as {
      status: string;
      previous_status: string;
      contract_no: string;
      sales_id: string | null;
    };
    const newStatus = contract.status;

    // Send notifications to relevant parties
    try {
      const notificationTargets: string[] = [];

      // Notify the assigned sales person
      if (contract.sales_id) {
        notificationTargets.push(contract.sales_id);
      }

      // Notify all admin/boss users
      const adminIds = await getAdminUserIds();
      for (const adminId of adminIds) {
        if (!notificationTargets.includes(adminId)) {
          notificationTargets.push(adminId);
        }
      }

      // The label follows the status the routine actually set, not the request.
      const actionLabel = newStatus === "superseded" ? "superseded" : "revocation initiated";
      const notifications = notificationTargets.map((userId) => ({
        userId,
        type: "contract_superseded",
        title: `Contract ${contract.contract_no} — ${actionLabel}`,
        body: `Contract ${contract.contract_no} has been ${actionLabel}. Reason: ${reason}`,
        relatedId: contractId,
        relatedType: "contract",
      }));

      for (const notif of notifications) {
        await createNotification(notif);
      }
    } catch (notifyErr) {
      logger.warn(
        {
          err: notifyErr,
          request_id,
          operation: "contract_revoke",
          user_id: user.id,
          contract_id: contractId,
        },
        "[Revoke Contract] Notification failed",
      );
    }

    return NextResponse.json({
      success: true,
      contract_id: contractId,
      status: newStatus,
      previous_status: contract.previous_status,
    });
  } catch (err: any) {
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message;
    logger.error(
      {
        err,
        request_id,
        operation: "contract_revoke",
        contract_id: contractId,
      },
      "[Revoke Contract] Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
