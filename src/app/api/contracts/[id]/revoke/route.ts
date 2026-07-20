// RBAC: user (admin, boss)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import {
  createNotification,
  getAdminUserIds,
} from "@/lib/notifications";
import { logger, genReqId } from "@/lib/logger";

/**
 * POST /api/contracts/[id]/revoke
 * Initiate contract revocation or superseding.
 * Only admin/boss can revoke.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const request_id = genReqId();
  const { id: contractId } = await params;
  try {
    const supabase = await createServerSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify admin/boss role
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    const isAdminOrBoss =
      profile?.role && ["admin", "boss"].includes(profile.role);

    if (!isAdminOrBoss) {
      return NextResponse.json(
        { error: "Only admin or boss can revoke contracts" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { reason, supersede } = body;

    if (!reason || typeof reason !== "string") {
      return NextResponse.json(
        { error: "reason is required" },
        { status: 400 }
      );
    }

    // Fetch the contract
    const { data: contract, error: contractErr } = await supabase
      .from("contracts")
      .select("id, contract_no, status, sales_id")
      .eq("id", contractId)
      .single();

    if (contractErr || !contract) {
      return NextResponse.json(
        { error: "Contract not found" },
        { status: 404 }
      );
    }

    if (contract.status === "superseded") {
      return NextResponse.json(
        { error: "Contract is already superseded" },
        { status: 400 }
      );
    }

    if (contract.status === "revoked") {
      return NextResponse.json(
        { error: "Contract is already revoked" },
        { status: 400 }
      );
    }

    const newStatus = supersede ? "superseded" : "revoking";

    // Update contract status
    const { error: updateErr } = await supabase
      .from("contracts")
      .update({
        status: newStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", contractId);

    if (updateErr) {
      logger.error(
        {
          err: updateErr,
          request_id,
          operation: "contract_revoke",
          user_id: user.id,
          contract_id: contractId,
        },
        "[Revoke Contract] DB update failed",
      );
      return NextResponse.json(
        { error: "Failed to update contract status" },
        { status: 500 }
      );
    }

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

      const actionLabel = supersede ? "superseded" : "revocation initiated";
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
