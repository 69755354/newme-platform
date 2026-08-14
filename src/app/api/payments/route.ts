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

// ── There is no GET here any more ────────────────────────────────────────────
//
// Round-4 finding R5. This file used to export a second payments read model:
// `select("*")` on payments, returned as `{ data }`, with `?contract_id` and
// `?confirmed` filters, its own role list ["admin","boss","sales","finance",
// "operator"], and its own sales scoping through a separate contracts lookup.
// Nothing in the application called it — the dashboard reads GET
// /api/payments/list, which B8 made the one typed read model — so it was an
// authenticated surface no page exercised and no test covered, still answering
// requests.
//
// Three concrete reasons it could not just be left there:
//
//   * it was a THIRD state model. `?confirmed=true` filters on `confirmed` alone,
//     so it reported voided money as received; `select("*")` returned voided_at
//     alongside it, which is exactly the shape B8 removed from the list route
//     (fields on the wire that nothing interprets). See src/lib/payment-state.mjs.
//   * `select("*")` also returned request_key and credited_to — the idempotency key
//     a client minted and the internal credit attribution — which are server-side
//     bookkeeping. The list route names its columns for that reason.
//   * its role list was a fourth copy of the money-role rule, unbound to the
//     routines' own lists that tests/security/money-grant-coupling.test.mjs holds
//     together. A route nobody calls is a route nobody notices drifting.
//
// Deleted rather than fixed: a read model has one place, and it already exists.
// tests/security/payment-idempotency-boundary.test.mjs pins that this file exports
// POST and nothing else.
