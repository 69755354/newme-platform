// RBAC: user (admin, boss, finance)
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";
import { moneyRpcFailure } from "@/lib/money-rpc.mjs";

/**
 * POST /api/payments/[id]/confirm
 * Confirms a payment, triggering cascading updates via RPC.
 * Only admin/boss/finance can confirm payments.
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

    // Fetch user role for access control
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

    // Verify the payment exists and is not already confirmed
    const { data: payment, error: paymentErr } = await supabase
      .from("payments")
      .select("id, confirmed")
      .eq("id", paymentId)
      .single();

    if (paymentErr || !payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    if (payment.confirmed) {
      return NextResponse.json(
        { error: "Payment is already confirmed" },
        { status: 400 }
      );
    }

    // Call the RPC function to confirm the payment with cascading updates
    const { data: result, error: rpcErr } = await supabase.rpc("confirm_payment", {
      p_payment_id: paymentId,
      p_confirmer_id: user.id,
    });

    if (rpcErr) {
      // Every refusal confirm_payment() raises is a decision with a SQLSTATE:
      // 42501 for the role rule, 22023 for a second confirmation or a voided
      // payment, class 28 for a session the boundary no longer accepts. Reporting
      // all of them as 500 told the client "we broke" and invited a retry.
      const failure = moneyRpcFailure(rpcErr, "Failed to confirm payment");
      const log = failure.status >= 500 ? logger.error : logger.warn;
      log(
        {
          err: rpcErr,
          request_id,
          operation: "payment_confirm",
          user_id: user.id,
          payment_id: paymentId,
          error_code: rpcErr.code,
          http_status: failure.status,
        },
        "[API Payments Confirm] confirm_payment refused the request",
      );
      return NextResponse.json(failure.body, { status: failure.status });
    }

    revalidatePath("/contracts");
    revalidatePath("/payments");
    revalidatePath("/dashboard");
    return NextResponse.json({ data: result });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    logger.error(
      {
        err,
        request_id,
        operation: "payment_confirm",
        payment_id: paymentId,
      },
      "[API Payments Confirm] Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
