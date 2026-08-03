// RBAC: user (admin, boss, finance)
import { NextRequest, NextResponse } from "next/server";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import { RequestAuthError } from "@/lib/request-auth-context";
import { logger, genReqId } from "@/lib/logger";
import type { Json } from "@/types/database";

interface AllocationItem {
  plan_id: string;
  amount: number;
}

function paymentFailure(value: unknown): { code: string; status: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof (value as { error?: unknown }).error !== "string") return null;
  const error = (value as { error: string }).error;
  const normalized = error.toLowerCase();
  return normalized.includes("not found")
    ? { code: "payment_not_found", status: 404 }
    : normalized.includes("exceed")
      ? { code: "payment_allocation_exceeds_amount", status: 409 }
      : { code: "payment_allocation_conflict", status: 409 };
}

function paymentRpcStatus(message: string): number {
  const normalized = message.toLowerCase();
  if (normalized.includes("not_found") || normalized.includes("not found")) return 404;
  if (normalized.includes("capability") || normalized.includes("required")) return 403;
  if (normalized.includes("invalid")) return 400;
  if (normalized.includes("already") || normalized.includes("exceed")
    || normalized.includes("conflict")) return 409;
  return 503;
}

function paymentRpcCode(status: number): string {
  if (status === 400) return "invalid_payment_allocation";
  if (status === 403) return "payment_allocation_forbidden";
  if (status === 404) return "payment_not_found";
  if (status === 409) return "payment_allocation_conflict";
  return "payment_allocation_unavailable";
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
    const access = await resolveOrganizationAuthorization(
      request,
      "payments.allocate",
      "write",
    );
    const { supabase, user } = access.context;

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
      .eq("organization_id", access.organizationId)
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
    const { data: result, error: rpcErr } = await supabase.rpc(
      "v4_allocate_payment_for_organization",
      {
        p_organization_id: access.organizationId,
        p_payment_id: paymentId,
        p_allocations: allocationPayload,
        p_request_id: access.context.requestId,
      },
    );

    if (rpcErr) {
      logger.error(
        {
          err: rpcErr,
          request_id,
          operation: "payment_allocate",
          user_id: user.id,
          payment_id: paymentId,
        },
        "[API Payments Allocate] RPC failed",
      );
      const status = paymentRpcStatus(rpcErr.message || "");
      return NextResponse.json({ error: paymentRpcCode(status) }, { status });
    }

    const businessFailure = paymentFailure(result);
    if (businessFailure) {
      return NextResponse.json(
        { error: businessFailure.code },
        { status: businessFailure.status },
      );
    }

    return NextResponse.json({ data: result });
  } catch (err: unknown) {
    if (err instanceof OrganizationAuthorizationError || err instanceof RequestAuthError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    const message = process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err instanceof Error ? err.message : "Internal server error";
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
