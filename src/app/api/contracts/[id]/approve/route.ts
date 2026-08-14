// RBAC: user (admin, operator, boss)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";
import { moneyRpcFailure } from "@/lib/money-rpc.mjs";
import { dispatchPersistedNotification } from "@/lib/notification-dispatch";

/**
 * POST /api/contracts/[id]/approve
 * Approves or rejects a contract via the two-step approval workflow.
 *
 * Steps, decided by approve_contract() from the contract's status:
 *   pending_admin → admin_review — only admin / operator
 *   pending_ceo   → ceo_review   — only boss
 *
 * The routine settles the pending row for that step, opens the next one, and
 * moves the contract, all in one transaction with the row held FOR UPDATE.
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

    // ── Call RPC ───────────────────────────────────────────────────────
    // The step is decided by the routine from the contract's status, inside the
    // transaction that settles it. This route used to read the EARLIEST pending
    // contract_approvals row instead: the append-only approve_contract left
    // 'admin_review' pending forever, so after the first approval every later
    // decision was still routed to the admin_review step and ceo_review was
    // unreachable — a two-step approval chain that only ever ran step one.
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
      const failure = moneyRpcFailure(rpcErr, "Approval failed");
      const log = failure.status >= 500 ? logger.error : logger.warn;
      log(
        {
          err: rpcErr,
          request_id,
          operation: "contract_approve",
          user_id: user.id,
          contract_id: contractId,
          error_code: rpcErr.code,
          http_status: failure.status,
        },
        "[API Approve] approve_contract refused the request",
      );
      return NextResponse.json(failure.body, { status: failure.status });
    }

    // ── Send notification on success ───────────────────────────────────
    try {
      const notificationType =
        action === "approve" ? "contract_approved" : "contract_rejected";
      await dispatchPersistedNotification({
        actorId: user.id,
        input: {
          type: notificationType,
          contract_id: contractId,
        },
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
