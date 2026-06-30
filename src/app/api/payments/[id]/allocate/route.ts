import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

interface AllocationItem {
  plan_id: string;
  amount: number;
}

/**
 * POST /api/payments/[id]/allocate
 * Allocates a confirmed payment to one or more installment plans.
 * Only admin/boss/finance can allocate payments.
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

    const body = await request.json();
    const { allocations } = body as { allocations: AllocationItem[] };

    if (!allocations || !Array.isArray(allocations) || allocations.length === 0) {
      return NextResponse.json(
        { error: "allocations must be a non-empty array of { plan_id, amount }" },
        { status: 400 }
      );
    }

    // Validate each allocation entry
    for (const alloc of allocations) {
      if (!alloc.plan_id || typeof alloc.plan_id !== "string") {
        return NextResponse.json(
          { error: "Each allocation must have a valid plan_id" },
          { status: 400 }
        );
      }
      if (!alloc.amount || typeof alloc.amount !== "number" || alloc.amount <= 0) {
        return NextResponse.json(
          { error: "Each allocation must have a positive amount" },
          { status: 400 }
        );
      }
    }

    // Verify the payment exists
    const { data: payment, error: paymentErr } = await supabase
      .from("payments")
      .select("id, confirmed")
      .eq("id", paymentId)
      .single();

    if (paymentErr || !payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    if (!payment.confirmed) {
      return NextResponse.json(
        { error: "Payment must be confirmed before allocation" },
        { status: 400 }
      );
    }

    // Call the RPC function to allocate the payment
    const { data: result, error: rpcErr } = await supabase.rpc("allocate_payment", {
      p_payment_id: paymentId,
      p_allocations: allocations,
      p_allocated_by: user.id,
    });

    if (rpcErr) {
      console.error("[API Payments Allocate] RPC failed:", rpcErr);
      return NextResponse.json(
        { error: rpcErr.message || "Failed to allocate payment" },
        { status: 500 }
      );
    }

    return NextResponse.json({ data: result });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    console.error("[API Payments Allocate] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
