// RBAC: user (admin, operator, boss)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";
import { createNotificationsBulk, getAdminUserIds } from "@/lib/notifications";
import {
  completeContractApproval,
  ContractApprovalResultError,
} from "@/lib/contract-approval-result";

/**
 * POST /api/contracts/[id]/approve
 * Approves or rejects a contract via the two-step approval workflow.
 *
 * Steps:
 *   admin_review — only admin / operator
 *   ceo_review   — only boss
 *
 * The actual mutation is delegated to the RPC `approve_contract` which
 * updates both the `contract_approvals` row and the parent `contracts`
 * record atomically.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const request_id = genReqId();
  const { id: contractId } = await params;
  try {
    // ── Auth ───────────────────────────────────────────────────────────
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ── Fetch user role ────────────────────────────────────────────────
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("role, full_name")
      .eq("id", user.id)
      .single();

    if (profileErr || !profile?.role) {
      return NextResponse.json(
        { error: "Profile not found" },
        { status: 403 }
      );
    }

    const userRole = profile.role;

    // ── Parse & validate body ──────────────────────────────────────────
    const body = await request.json();
    const { action, notes } = body as {
      action?: string;
      notes?: string;
    };

    if (!action || !["approve", "reject"].includes(action)) {
      return NextResponse.json(
        { error: "action must be 'approve' or 'reject'" },
        { status: 400 }
      );
    }

    // ── Determine current approval step ────────────────────────────────
    // Fetch the pending approval record for this contract (if any).
    const { data: pendingApproval, error: approvalFetchErr } =
      await supabase
        .from("contract_approvals")
        .select("id, step, status")
        .eq("contract_id", contractId)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

    if (approvalFetchErr) {
      logger.error(
        {
          err: approvalFetchErr,
          request_id,
          operation: "contract_approve",
          user_id: user.id,
          contract_id: contractId,
        },
        "[API Approve] Failed to fetch pending approval",
      );
      return NextResponse.json(
        { error: "Failed to determine approval step" },
        { status: 500 }
      );
    }

    if (!pendingApproval) {
      return NextResponse.json(
        { error: "No pending approval found for this contract" },
        { status: 400 }
      );
    }

    const currentStep = pendingApproval.step as string;

    // ── Role-based access control ──────────────────────────────────────
    if (currentStep === "admin_review") {
      if (!["admin", "operator"].includes(userRole)) {
        return NextResponse.json(
          { error: "Only admin or operator can approve the admin_review step" },
          { status: 403 }
        );
      }
    } else if (currentStep === "ceo_review") {
      if (userRole !== "boss") {
        return NextResponse.json(
          { error: "Only boss can approve the ceo_review step" },
          { status: 403 }
        );
      }
    } else {
      return NextResponse.json(
        { error: `Unknown approval step: ${currentStep}` },
        { status: 400 }
      );
    }

    // ── Call RPC ───────────────────────────────────────────────────────
    const { data: rpcResult, error: rpcErr } = await supabase.rpc(
      "approve_contract",
      {
        p_contract_id: contractId,
        p_approver_id: user.id,
        p_action: action,
        p_notes: notes?.trim() || undefined,
      }
    );

    if (rpcErr) {
      logger.error(
        {
          err: rpcErr,
          request_id,
          operation: "contract_approve",
          user_id: user.id,
          contract_id: contractId,
        },
        "[API Approve] RPC failed",
      );
      return NextResponse.json(
        { error: "contract_approval_unavailable" },
        { status: 503 }
      );
    }

    // ── Send notification on success ───────────────────────────────────
    let result;
    try {
      result = await completeContractApproval(
        rpcResult,
        async () => {
          const notificationType = action === "approve"
            ? "contract_approved"
            : "contract_rejected";
          const { data: contractInfo, error: contractInfoError } = await supabase
            .from("contracts")
            .select("contract_no, sales_id, organization_id")
            .eq("id", contractId)
            .single();
          if (contractInfoError || !contractInfo) {
            throw new Error("contract_notification_context_failed");
          }
          const recipients = [...new Set([
            ...(await getAdminUserIds(contractInfo.organization_id)),
            contractInfo.sales_id,
          ].filter((id): id is string => Boolean(id)))];
          await createNotificationsBulk(contractInfo.organization_id, recipients.map((userId) => ({
            userId,
            type: notificationType,
            title: `Contract ${action === "approve" ? "approved" : "rejected"}: ${contractInfo.contract_no}`,
            body: `${profile.full_name || "An approver"} ${action}d ${currentStep}.`,
            relatedId: contractId,
            relatedType: "contract",
            eventKey: `contract:${contractId}:${notificationType}:${pendingApproval.id}`,
          })));
        },
        (notificationError) => logger.error(
          {
            err: notificationError,
            request_id,
            operation: "contract_approval_notification",
            contract_id: contractId,
          },
          "[API Approve] Approval committed but notification delivery failed",
        ),
      );
    } catch (resultError: unknown) {
      if (resultError instanceof ContractApprovalResultError) {
        return NextResponse.json({ error: resultError.code }, { status: resultError.status });
      }
      throw resultError;
    }
    return NextResponse.json(result);
  } catch (err: unknown) {
    logger.error(
      {
        err,
        request_id,
        operation: "contract_approve",
        contract_id: contractId,
      },
      "[API Approve] Error",
    );
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
