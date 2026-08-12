// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";
import {
  canRecordPayment,
  isRequestKeyConflict,
  readIdempotencyKey,
  resolveSpentKey,
} from "@/lib/payment-idempotency.mjs";

/**
 * POST /api/payments
 * Records a new payment against a contract. This is the only way a payment is
 * recorded; the payments dashboard posts here.
 *
 * Requires an idempotency key. It is stored as payments.request_key, which carries
 * a unique index on (created_by, request_key): a double-submitted form or a
 * retried fetch records one payment, and the retry is answered with the payment
 * the first attempt created rather than a second one. The key has to come from the
 * caller — one generated here would be new on every attempt and would make every
 * retry a fresh payment, which is the defect this closes, not a fix for it.
 *
 * The index raises the same 23505 whether the retry is honest or the key has been
 * reused for a different payment, so this route decides between them by comparing
 * the request against the payment already stored under that key.
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

    const body = await request.json();
    const { contract_id, amount, payment_date, payment_method, reference_no, notes } = body;

    if (!contract_id) {
      return NextResponse.json({ error: "contract_id is required" }, { status: 400 });
    }
    if (!amount || typeof amount !== "number" || amount <= 0) {
      return NextResponse.json({ error: "Valid amount is required" }, { status: 400 });
    }
    if (!payment_date) {
      return NextResponse.json({ error: "payment_date is required" }, { status: 400 });
    }
    if (!payment_method) {
      return NextResponse.json({ error: "payment_method is required" }, { status: 400 });
    }

    const requestKey = readIdempotencyKey({
      body,
      headerValue: request.headers.get("idempotency-key"),
    });
    if (!requestKey) {
      return NextResponse.json(
        {
          error:
            "A valid idempotencyKey (UUID) is required, so a resubmitted request records one payment instead of two",
          code: "INVALID_REQUEST",
        },
        { status: 400 },
      );
    }

    // Verify the contract exists
    const { data: contract, error: contractErr } = await supabase
      .from("contracts")
      .select("id, sales_id")
      .eq("id", contract_id)
      .single();

    if (contractErr || !contract) {
      return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    }

    // Fetch user role for access control
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    // A role is required, the recording roles may record against any contract,
    // and anyone else may record only against a contract they own.
    if (
      !canRecordPayment({
        role: profile?.role,
        contractSalesId: contract.sales_id,
        userId: user.id,
      })
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { data: payment, error: insertErr } = await supabase
      .from("payments")
      .insert({
        contract_id,
        created_by: user.id,
        amount,
        payment_date,
        payment_method,
        reference_no: reference_no || null,
        confirmed: false,
        notes: notes || null,
        request_key: requestKey,
      })
      .select("id, amount")
      .single();

    if (insertErr) {
      // 23505 on the request-key index is not, by itself, a failure: this key has
      // already recorded a payment. Whether that payment is the one being asked
      // for is a different question, and the index answers with the same sqlstate
      // either way — so read the stored payment and compare.
      if (isRequestKeyConflict(insertErr)) {
        const { data: existing } = await supabase
          .from("payments")
          .select("id, amount, contract_id, payment_date, payment_method, reference_no, notes")
          .eq("created_by", user.id)
          .eq("request_key", requestKey)
          .maybeSingle();

        const requested = { contract_id, amount, payment_date, payment_method, reference_no, notes };
        const verdict = resolveSpentKey({ stored: existing, requested });

        if (verdict.outcome === "replay" && existing) {
          logger.info(
            { request_id, operation: "payment_create", user_id: user.id, contract_id, payment_id: existing.id },
            "[API Payments] Idempotent replay: returning the payment the first attempt recorded",
          );
          return NextResponse.json(
            { id: existing.id, amount: existing.amount, idempotent_replay: true },
            { status: verdict.status },
          );
        }

        if (verdict.outcome === "mismatch") {
          // Recording it would be a second payment under a key that promised
          // there would be only one; answering with the stored payment would tell
          // the caller a payment it never asked for had been recorded. Neither is
          // acceptable, so the caller has to mint a new key and decide.
          logger.warn(
            { request_id, operation: "payment_create", user_id: user.id, contract_id },
            "[API Payments] Idempotency key reused for a different payment; refused",
          );
          return NextResponse.json(
            {
              error:
                "This idempotency key already recorded a different payment. Use a new key to record a new payment.",
              code: verdict.code,
            },
            { status: verdict.status },
          );
        }

        // The row exists but this session cannot read it — a key reused across
        // creators, or a contract this caller may write to but not read back.
        // Refusing is right, and saying which of the two it is would leak the row.
        return NextResponse.json(
          { error: "This request has already been recorded", code: verdict.code },
          { status: verdict.status },
        );
      }

      logger.error(
        {
          err: insertErr,
          request_id,
          operation: "payment_create",
          user_id: user.id,
          contract_id,
        },
        "[API Payments] Insert failed",
      );
      return NextResponse.json({ error: "Failed to record payment" }, { status: 500 });
    }

    return NextResponse.json({ id: payment.id, amount: payment.amount }, { status: 201 });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    logger.error(
      {
        err,
        request_id,
        operation: "payment_create",
      },
      "[API Payments] POST Error",
    );
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
