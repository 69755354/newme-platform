// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";
import {
  canRecordPayment,
  readIdempotencyKey,
  validatePaymentRecordInput,
} from "@/lib/payment-idempotency.mjs";
import { recordPaymentWithKey } from "@/lib/payment-idempotency-server.mjs";

/**
 * POST /api/payments
 *
 * The dashboard's sole payment-recording boundary. The caller owns one UUID per
 * intent; PostgreSQL enforces uniqueness on (created_by, request_key), while the
 * application distinguishes an honest replay from reuse for a different intent.
 */
export async function POST(request: NextRequest) {
  const request_id = genReqId();
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Request body must be valid JSON", code: "INVALID_REQUEST" }, { status: 400 });
    }

    const validation = validatePaymentRecordInput(body);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error, code: "INVALID_REQUEST" }, { status: 400 });
    }
    const intent = validation.intent;
    const { contract_id } = intent;

    const requestKey = readIdempotencyKey({
      body,
      headerValue: request.headers.get("idempotency-key"),
    });
    if (!requestKey) {
      return NextResponse.json(
        {
          error: "A valid idempotencyKey (UUID) is required",
          code: "INVALID_REQUEST",
        },
        { status: 400 },
      );
    }

    const { data: contract, error: contractErr } = await supabase
      .from("contracts")
      .select("id, sales_id")
      .eq("id", contract_id)
      .single();
    if (contractErr || !contract) {
      return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (
      !canRecordPayment({
        role: profile?.role,
        contractSalesId: contract.sales_id,
        userId: user.id,
      })
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const write = await recordPaymentWithKey({
      supabase,
      creatorId: user.id,
      requestKey,
      intent,
    });

    if (write.outcome === "created") {
      return NextResponse.json({ id: write.payment.id, amount: write.payment.amount }, { status: write.status });
    }

    if (write.outcome === "replay") {
      logger.info(
        { request_id, operation: "payment_create", user_id: user.id, contract_id, payment_id: write.payment.id },
        "[API Payments] Idempotent replay",
      );
      return NextResponse.json(
        { id: write.payment.id, amount: write.payment.amount, idempotent_replay: true },
        { status: write.status },
      );
    }

    if (write.outcome === "mismatch") {
      logger.warn(
        { request_id, operation: "payment_create", user_id: user.id, contract_id },
        "[API Payments] Idempotency key reused for a different payment",
      );
      return NextResponse.json(
        {
          error: "This idempotency key already recorded a different payment. Use a new key for a new intent.",
          code: write.code,
        },
        { status: write.status },
      );
    }

    if (write.outcome === "opaque") {
      return NextResponse.json(
        { error: "This request has already been recorded", code: write.code },
        { status: write.status },
      );
    }

    logger.error(
      {
        err: write.error,
        request_id,
        operation: "payment_create",
        user_id: user.id,
        contract_id,
      },
      "[API Payments] Insert failed",
    );
    return NextResponse.json({ error: "Failed to record payment" }, { status: 500 });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    logger.error({ err, request_id, operation: "payment_create" }, "[API Payments] POST Error");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/payments
 * Lists payments with optional filters.
 * Query params: contract_id, confirmed
 */
export async function GET(request: NextRequest) {
  const request_id = genReqId();
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

    const userRole = profile.role;
    const allowedRoles = ["admin", "boss", "sales", "finance", "operator"];
    if (!allowedRoles.includes(userRole)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const contractId = searchParams.get("contract_id");
    const confirmed = searchParams.get("confirmed");

    let query = supabase
      .from("payments")
      .select("*")
      .order("created_at", { ascending: false });

    if (contractId) {
      query = query.eq("contract_id", contractId);
    }
    if (confirmed !== null && confirmed !== undefined) {
      query = query.eq("confirmed", confirmed === "true");
    }

    // Sales can only see payments for their own contracts
    if (userRole === "sales") {
      // Get contract IDs owned by this sales user
      const { data: ownContracts, error: contractsErr } = await supabase
        .from("contracts")
        .select("id")
        .eq("sales_id", user.id);

      if (contractsErr) {
        logger.error(
          {
            err: contractsErr,
            request_id,
            operation: "payment_list",
            user_id: user.id,
          },
          "[API Payments] Failed to fetch sales contracts",
        );
        return NextResponse.json({ error: "Failed to fetch payments" }, { status: 500 });
      }

      const ownContractIds = (ownContracts || []).map((c: { id: string }) => c.id);

      if (ownContractIds.length === 0) {
        return NextResponse.json({ data: [] });
      }

      query = query.in("contract_id", ownContractIds);
    }

    const { data, error } = await query;

    if (error) {
      logger.error(
        {
          err: error,
          request_id,
          operation: "payment_list",
          user_id: user.id,
        },
        "[API Payments] Fetch failed",
      );
      return NextResponse.json({ error: "Failed to fetch payments" }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    logger.error(
      {
        err,
        request_id,
        operation: "payment_list",
      },
      "[API Payments] GET Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
