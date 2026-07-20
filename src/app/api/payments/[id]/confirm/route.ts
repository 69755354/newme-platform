// RBAC: user (admin, boss, finance)
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";

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
    const supabase = await createServerSupabase();
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

    if (!profile) {
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
      logger.error(
        {
          err: rpcErr,
          request_id,
          operation: "payment_confirm",
          user_id: user.id,
          payment_id: paymentId,
        },
        "[API Payments Confirm] RPC failed",
      );
      return NextResponse.json(
        { error: rpcErr.message || "Failed to confirm payment" },
        { status: 500 }
      );
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
