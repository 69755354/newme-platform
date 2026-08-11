// RBAC: user (admin, boss, finance)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";
import { moneyRpcFailure } from "@/lib/money-rpc.mjs";
import type { Json } from "@/types/database";

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

    // Preserve the atomic allocation RPC and serialize only its generated JSON argument.
    const allocationPayload: Json = allocations.map(({ plan_id, amount }) => ({ plan_id, amount }));
    const { data: result, error: rpcErr } = await supabase.rpc("allocate_payment", {
      p_payment_id: paymentId,
      p_allocations: allocationPayload,
      p_allocated_by: user.id,
    });

    if (rpcErr) {
      const failure = moneyRpcFailure(rpcErr, "Failed to allocate payment");
      const log = failure.status >= 500 ? logger.error : logger.warn;
      log(
        {
          err: rpcErr,
          request_id,
          operation: "payment_allocate",
          user_id: user.id,
          payment_id: paymentId,
          error_code: rpcErr.code,
          http_status: failure.status,
        },
        "[API Payments Allocate] allocate_payment refused the request",
      );
      return NextResponse.json(failure.body, { status: failure.status });
    }

    return NextResponse.json({ data: result });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    logger.error(
      {
        err,
        request_id,
        operation: "payment_allocate",
        payment_id: paymentId,
      },
      "[API Payments Allocate] Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
