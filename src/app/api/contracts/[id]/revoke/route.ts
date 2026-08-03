// RBAC: user (admin, boss)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { createNotificationsBulk, getAdminUserIds } from "@/lib/notifications";
import { logger, genReqId } from "@/lib/logger";
import { withContractNotificationWarning } from "@/lib/contract-approval-result";
import { buildContractRevocationNotifications } from "@/lib/contract-revocation-notification";

/**
 * POST /api/contracts/[id]/revoke
 * Initiate contract revocation or superseding.
 * Only admin/boss can revoke.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
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

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!profile?.role || !["admin", "boss"].includes(profile.role)) {
      return NextResponse.json(
        { error: "Only admin or boss can revoke contracts" },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { reason, supersede } = body as { reason?: unknown; supersede?: unknown };
    if (!reason || typeof reason !== "string") {
      return NextResponse.json({ error: "reason is required" }, { status: 400 });
    }

    const { data: contract, error: contractError } = await supabase
      .from("contracts")
      .select("id, organization_id, contract_no, status, sales_id")
      .eq("id", contractId)
      .single();
    if (contractError || !contract) {
      return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    }
    if (contract.status === "superseded") {
      return NextResponse.json({ error: "Contract is already superseded" }, { status: 400 });
    }
    if (contract.status === "revoked") {
      return NextResponse.json({ error: "Contract is already revoked" }, { status: 400 });
    }

    const newStatus = supersede === true ? "superseded" : "revoking";
    const { error: updateError } = await supabase
      .from("contracts")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", contractId)
      .eq("organization_id", contract.organization_id);
    if (updateError) {
      logger.error(
        {
          err: updateError,
          request_id,
          operation: "contract_revoke",
          user_id: user.id,
          contract_id: contractId,
        },
        "[Revoke Contract] DB update failed",
      );
      return NextResponse.json(
        { error: "Failed to update contract status" },
        { status: 500 },
      );
    }

    const result = await withContractNotificationWarning({
      success: true as const,
      contract_id: contractId,
      status: newStatus,
    }, async () => {
      const notifications = buildContractRevocationNotifications({
        contractId,
        contractNo: contract.contract_no,
        salesId: contract.sales_id,
        status: newStatus,
        reason,
      }, await getAdminUserIds(contract.organization_id));
      await createNotificationsBulk(contract.organization_id, notifications);
    }, (notificationError) => logger.warn(
      {
        err: notificationError,
        request_id,
        operation: "contract_revoke_notification",
        user_id: user.id,
        contract_id: contractId,
      },
      "[Revoke Contract] Contract updated but notification delivery failed",
    ));

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = process.env.NODE_ENV === "production"
      ? "Internal server error"
      : error instanceof Error ? error.message : "Internal server error";
    logger.error(
      {
        err: error,
        request_id,
        operation: "contract_revoke",
        contract_id: contractId,
      },
      "[Revoke Contract] Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
