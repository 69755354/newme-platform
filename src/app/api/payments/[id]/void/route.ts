// RBAC: user (admin, boss, finance)
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";
import { moneyRpcFailure } from "@/lib/money-rpc.mjs";

/**
 * POST /api/payments/[id]/void
 *
 * The supported reversal. Round-3 finding P1-2: the trg_guard_* triggers covered
 * INSERT and UPDATE but not DELETE, and `authenticated` held DELETE on payments,
 * so a browser session could delete a confirmed payment. The allocation rows went
 * with it through ON DELETE CASCADE while installment_plans.allocated_amount,
 * projects.paid_amount, kpi_targets.actual_amount and contracts.first_payment_status
 * kept the deleted payment's money in their totals — a reproduced,
 * silently-inconsistent ledger.
 *
 * 20260814000000 closes both halves: DELETE is revoked and refused on all five
 * money tables, and void_payment() is the reversal that actually reverses. In one
 * transaction it locks the payment and every affected installment plan in a stable
 * order, releases the allocations, marks the payment voided with an actor and a
 * reason, and recomputes each derived total from the payments that still count
 * (confirmed and not voided). The row stays, which is the point: a voided payment
 * is auditable and a deleted one is not.
 *
 * The routine, not this route, is the authorization boundary — money_actor() binds
 * the actor to the session's JWT subject, admits only admin/boss/finance, and
 * refuses a session the class-28 boundary no longer accepts. The role check below
 * is the same early answer the sibling routes give, so a salesperson gets a 403
 * without a database round trip.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const request_id = genReqId();
  const { id: paymentId } = await params;
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

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (!profile?.role) {
      return NextResponse.json({ error: "Profile not found" }, { status: 403 });
    }
    const allowedRoles = ["admin", "boss", "finance"];
    if (!allowedRoles.includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const reason =
      body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string"
        ? (body as { reason: string }).reason.trim()
        : "";
    if (!reason) {
      // void_payment() refuses a blank reason with 22023 as well; answering here
      // keeps the reversal from looking like a database failure to the client.
      return NextResponse.json(
        { error: "A reason is required to void a payment", code: "reason_required" },
        { status: 400 },
      );
    }

    const { data: result, error: rpcErr } = await supabase.rpc("void_payment", {
      p_payment_id: paymentId,
      p_reason: reason,
    });

    if (rpcErr) {
      const failure = moneyRpcFailure(rpcErr, "Failed to void payment");
      const log = failure.status >= 500 ? logger.error : logger.warn;
      log(
        {
          err: rpcErr,
          request_id,
          operation: "payment_void",
          user_id: user.id,
          payment_id: paymentId,
          error_code: rpcErr.code,
          http_status: failure.status,
        },
        "[API Payments Void] void_payment refused the request",
      );
      return NextResponse.json(failure.body, { status: failure.status });
    }

    revalidatePath("/contracts");
    revalidatePath("/payments");
    revalidatePath("/dashboard");
    return NextResponse.json({ data: result });
  } catch (err: unknown) {
    const message =
      process.env.NODE_ENV === "production" ? "Internal server error" : (err as Error).message;
    logger.error(
      { err, request_id, operation: "payment_void", payment_id: paymentId },
      "[API Payments Void] Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
