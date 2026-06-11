import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/payments/[id]/confirm
 * Confirms a payment, triggering cascading updates via RPC.
 * Only admin/boss/finance can confirm payments.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: paymentId } = await params;

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
    const { data: payment, error: paymentErr } = await supabaseAdmin
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
    const { data: result, error: rpcErr } = await supabaseAdmin.rpc("confirm_payment", {
      p_payment_id: paymentId,
      p_confirmer_id: user.id,
    });

    if (rpcErr) {
      console.error("[API Payments Confirm] RPC failed:", rpcErr);
      return NextResponse.json(
        { error: rpcErr.message || "Failed to confirm payment" },
        { status: 500 }
      );
    }

    return NextResponse.json({ data: result });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    console.error("[API Payments Confirm] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
