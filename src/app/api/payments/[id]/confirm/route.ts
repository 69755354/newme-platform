// RBAC: user (admin, boss, finance)
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import { RequestAuthError } from "@/lib/request-auth-context";
import { logger, genReqId } from "@/lib/logger";

function paymentFailure(value: unknown): { code: string; status: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof (value as { error?: unknown }).error !== "string") return null;
  const error = (value as { error: string }).error;
  const normalized = error.toLowerCase();
  return normalized.includes("not found")
    ? { code: "payment_not_found", status: 404 }
    : normalized.includes("already")
      ? { code: "payment_already_confirmed", status: 409 }
      : { code: "payment_confirmation_conflict", status: 409 };
}

function paymentRpcStatus(message: string): number {
  const normalized = message.toLowerCase();
  if (normalized.includes("not_found") || normalized.includes("not found")) return 404;
  if (normalized.includes("capability") || normalized.includes("required")) return 403;
  if (normalized.includes("invalid")) return 400;
  if (normalized.includes("already") || normalized.includes("conflict")) return 409;
  return 503;
}

function paymentRpcCode(status: number): string {
  if (status === 400) return "invalid_payment_confirmation";
  if (status === 403) return "payment_confirmation_forbidden";
  if (status === 404) return "payment_not_found";
  if (status === 409) return "payment_confirmation_conflict";
  return "payment_confirmation_unavailable";
}

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
    const access = await resolveOrganizationAuthorization(
      request,
      "payments.confirm",
      "write",
    );
    const { supabase, user } = access.context;

    // Verify the payment exists and is not already confirmed
    const { data: payment, error: paymentErr } = await supabase
      .from("payments")
      .select("id, confirmed")
      .eq("id", paymentId)
      .eq("organization_id", access.organizationId)
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
    const { data: result, error: rpcErr } = await supabase.rpc(
      "v4_confirm_payment_for_organization",
      {
        p_organization_id: access.organizationId,
        p_payment_id: paymentId,
        p_request_id: access.context.requestId,
      },
    );

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

    revalidatePath("/contracts");
    revalidatePath("/payments");
    revalidatePath("/dashboard");
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
        operation: "payment_confirm",
        payment_id: paymentId,
      },
      "[API Payments Confirm] Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
