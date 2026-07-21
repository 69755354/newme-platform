// RBAC: user (admin, operator, boss)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";

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

    if (profileErr || !profile) {
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
        p_notes: notes || null,
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
        { error: rpcErr.message || "Approval RPC failed" },
        { status: 500 }
      );
    }

    // ── Send notification on success ───────────────────────────────────
    try {
      const baseUrl =
        process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      const notificationType =
        action === "approve" ? "contract_approved" : "contract_rejected";

      // Fetch contract info for a richer notification body
      const { data: contractInfo } = await supabase
        .from("contracts")
        .select("contract_no, sales_id")
        .eq("id", contractId)
        .single();

      await fetch(`${baseUrl}/api/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: notificationType,
          contract_id: contractId,
          contract_no: contractInfo?.contract_no,
          action,
          step: currentStep,
          approver_name: profile.full_name || "Unknown",
          target_user_id: contractInfo?.sales_id,
        }),
      });
    } catch (notifyErr) {
      logger.warn(
        {
          err: notifyErr,
          request_id,
          operation: "contract_approve",
          user_id: user.id,
          contract_id: contractId,
        },
        "[API Approve] Notification failed",
      );
    }

    return NextResponse.json(rpcResult);
  } catch (err: any) {
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message;
    logger.error(
      {
        err,
        request_id,
        operation: "contract_approve",
        contract_id: contractId,
      },
      "[API Approve] Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
