// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase-server";
import { applyPrivateNoStore } from "@/lib/request-auth-context";
import { logger, genReqId } from "@/lib/logger";
import { moneyRpcFailure } from "@/lib/money-rpc.mjs";
import { dispatchPersistedNotification } from "@/lib/notification-dispatch";
import { allowedSetContractStatuses } from "@/lib/contract-status-capabilities.mjs";

/**
 * GET /api/contracts/[id]
 *
 * Returns the full picture for a single contract:
 *   - contract row (+ lead customer name + salesperson profile)
 *   - installment_plans (ordered by seq)
 *   - payments (ordered by payment_date, with confirmer name)
 *   - contract_approvals (ordered by created_at, with approver name)
 *
 * Access control:
 *   - admin / boss / operator / finance → see any contract
 *   - sales                              → only own contracts (sales_id = user.id)
 *
 * NOTE: payments & contract_approvals each have multiple FKs to profiles, so we
 * resolve approver/confirmer names with a separate profiles lookup instead of
 * embedding (avoids PostgREST FK-disambiguation errors).
 *
 * Round-4 finding R5: this response carries payments and installment_plans, so it is
 * force-dynamic and goes out through applyPrivateNoStore() like every other
 * money-derived read. tests/security/api-cache-money-boundary.test.mjs derives that
 * rule from the routes' own queries rather than from a list.
 */
export const dynamic = "force-dynamic";
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const request_id = genReqId();
  const { id: contractId } = await params;
  try {
    const bearerToken = _request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = _request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    const role = profile?.role ?? "sales";
    const isManagement =
      role === "admin" || role === "boss" || role === "operator" || role === "finance";

    // ── Contract row (single FK to leads → safe; sales via constraint name) ──
    const { data: contract, error } = await supabase
      .from("contracts")
      .select(
        `*,
        leads ( id, customer_name, phone, source ),
        profiles!contracts_sales_id_fkey ( id, full_name, email )`
      )
      .eq("id", contractId)
      .single();

    if (error || !contract) {
      return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    }

    if (!isManagement && contract.sales_id !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── Installment plans ──
    const { data: installments } = await supabase
      .from("installment_plans")
      .select("id, seq, amount, due_date, status, paid_amount, allocated_amount, description")
      .eq("contract_id", contractId)
      .order("seq", { ascending: true });

    // ── Payments ──
    //
    // Round-4 finding R5: this select named `confirmed` and stopped there, so the
    // detail page had no way to tell a reversal from a payment still awaiting
    // confirmation. void_payment() sets confirmed = false as well as voided_at, and
    // the page's `p.confirmed ? paid : pendingConfirm` therefore displayed every
    // voided payment as pending cash — the same two-state rule B8 removed from the
    // payments dashboard, still live here. voided_at is what records the reversal
    // (src/lib/payment-state.mjs), void_reason is why, and voided_by joins the same
    // profiles lookup below as confirmed_by.
    const { data: payments } = await supabase
      .from("payments")
      .select(
        "id, amount, payment_date, payment_method, reference_no, confirmed, confirmed_at, confirmed_by, voided_at, voided_by, void_reason, installment_plan_id, created_at"
      )
      .eq("contract_id", contractId)
      .order("payment_date", { ascending: false });

    // ── Approval history ──
    const { data: approvals } = await supabase
      .from("contract_approvals")
      .select("id, step, status, notes, reviewed_at, created_at, approver_id")
      .eq("contract_id", contractId)
      .order("created_at", { ascending: true });

    // ── Resolve approver / confirmer names in one profiles lookup ──
    const nameIds = new Set<string>();
    (payments ?? []).forEach((p: any) => {
      if (p.confirmed_by) nameIds.add(p.confirmed_by);
      if (p.voided_by) nameIds.add(p.voided_by);
    });
    (approvals ?? []).forEach((a: any) => { if (a.approver_id) nameIds.add(a.approver_id); });
    const nameMap: Record<string, string> = {};
    if (nameIds.size > 0) {
      const { data: users } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", [...nameIds]);
      (users ?? []).forEach((u: any) => { nameMap[u.id] = u.full_name; });
    }

    const paymentsNamed = (payments ?? []).map((p: any) => ({
      ...p,
      confirmer_name: p.confirmed_by ? nameMap[p.confirmed_by] ?? null : null,
      voider_name: p.voided_by ? nameMap[p.voided_by] ?? null : null,
    }));
    const approvalsNamed = (approvals ?? []).map((a: any) => ({
      ...a,
      approver_name: a.approver_id ? nameMap[a.approver_id] ?? null : null,
    }));

    return applyPrivateNoStore(
      NextResponse.json({
        contract,
        installments: installments ?? [],
        payments: paymentsNamed,
        approvals: approvalsNamed,
        canManage: isManagement,
        allowedStatusTransitions: allowedSetContractStatuses(
          role,
          contract.sales_id === user.id,
          contract.status,
        ),
      }),
    );
  } catch (err: any) {
    const message =
      process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    logger.error(
      {
        err,
        request_id,
        operation: "contract_detail",
        contract_id: contractId,
      },
      "[API Contracts Detail] Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PATCH /api/contracts/[id]
 * Body: { status: string, reason?: string }
 *
 * The contract page has been PATCHing this route since it was written
 * (src/app/(dashboard)/contracts/[id]/page.tsx:273) against a module that
 * exported only GET, so every status change from that page was a 405 — no status
 * button on the contract detail page has ever worked.
 *
 * The handler does not write the status; set_contract_status() does, and it
 * accepts only the transitions in its table. That distinction is the whole point:
 * a handler that wrote `body.status` onto the row would have turned the page's
 * status grid into an approval-chain bypass, because 'approved' and 'pending_ceo'
 * were among the buttons. Those two statuses belong to approve_contract() and are
 * rejected here with 400.
 */
export async function PATCH(
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
      error: authErr,
    } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const { status, reason } = body as { status?: unknown; reason?: unknown };

    if (typeof status !== "string" || status.trim() === "") {
      return NextResponse.json({ error: "status is required" }, { status: 400 });
    }
    if (reason !== undefined && reason !== null && typeof reason !== "string") {
      return NextResponse.json({ error: "reason must be a string" }, { status: 400 });
    }

    const { data: result, error: rpcErr } = await supabase.rpc("set_contract_status", {
      p_contract_id: contractId,
      p_status: status,
      // Required for 'terminated' and ignored otherwise; the routine, not this
      // route, decides which transitions need one.
      p_reason: typeof reason === "string" && reason.trim() !== "" ? reason.trim() : undefined,
    });

    if (rpcErr) {
      const failure = moneyRpcFailure(rpcErr, "Failed to update contract status");
      const log = failure.status >= 500 ? logger.error : logger.warn;
      log(
        {
          err: rpcErr,
          request_id,
          operation: "contract_set_status",
          user_id: user.id,
          contract_id: contractId,
          requested_status: status,
          error_code: rpcErr.code,
          http_status: failure.status,
        },
        "[API Contracts Detail] set_contract_status refused the request",
      );
      return NextResponse.json(failure.body, { status: failure.status });
    }

    if (status.trim() === "pending_admin") {
      try {
        await dispatchPersistedNotification({
          actorId: user.id,
          input: {
            type: "contract_pending_approval",
            contract_id: contractId,
          },
        });
      } catch (notifyErr) {
        logger.warn(
          {
            err: notifyErr,
            request_id,
            operation: "contract_set_status",
            user_id: user.id,
            contract_id: contractId,
          },
          "[API Contracts Detail] Pending-approval notification failed",
        );
      }
    }

    revalidatePath("/contracts");

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message =
      process.env.NODE_ENV === "production" ? "Internal server error" : (err as Error).message;
    logger.error(
      {
        err,
        request_id,
        operation: "contract_set_status",
        contract_id: contractId,
      },
      "[API Contracts Detail] PATCH Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
