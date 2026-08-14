// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";
import { moneyRpcFailure } from "@/lib/money-rpc.mjs";
import { dispatchPersistedNotification } from "@/lib/notification-dispatch";
import type { Json } from "@/types/database";

/**
 * POST /api/quotations/[id]/convert
 * Convert an accepted quotation into a draft contract.
 *
 * One call to convert_quotation_to_contract(uuid, jsonb). The routine takes the
 * quotation FOR UPDATE, re-checks status / contract_id / total / ownership inside
 * that transaction, creates the contract, its installment schedule and its
 * pending admin_review row, links the quotation and marks the lead won — all or
 * nothing.
 *
 * What this replaces, all of it live before this release:
 *
 *   - seven transactions with hand-written compensation. The compensating delete
 *     and the claim release are themselves separate transactions and can fail,
 *     which is how orphan contracts and quotations stuck in 'contract_created'
 *     with no contract appeared;
 *   - a claim-by-conditional-update used as a mutual exclusion primitive, which
 *     mutated the quotation's status before anything had been created;
 *   - a service_role COUNT to derive contract_no (the caller-visible count
 *     produced numbers that already existed), with a ten-attempt retry loop in
 *     the route. next_contract_no() is now the single counter for all creation
 *     paths;
 *   - the ownership check as a separate statement from the write.
 *
 * The direct inserts would be refused now in any case:
 * trg_guard_contracts_write and trg_guard_installment_plans_write raise 42501 for
 * an INSERT arriving as the `authenticated` role.
 *
 * Two round-3 findings changed the contract of this route.
 *
 * P1-5 — the installment schedule is REQUIRED and explicit. The dialog used to
 * POST with no body at all; this route turned that into `installments: []`, and
 * the routine created a contract with an approval row and no schedule, which no
 * entrypoint could then repair. The schedule is now validated here (shape, count,
 * positive amounts, unique sequence numbers) and again by the routine against the
 * quotation total, which this route deliberately does not read: a validation that
 * needs the authoritative total belongs in the same transaction as the write.
 * Every failure is a 400 before anything is written.
 *
 * P1-6 — the project and activity rows are written by the routine, inside the
 * conversion's transaction. They used to be written here, after the commit, with
 * failure downgraded to a `warnings` entry and HTTP 200; a retry then hit
 * "quotation is already converted", so a conversion that lost its project row
 * could not be repaired. Re-posting the same request now reaches the routine's
 * idempotent branch, which creates whatever is missing and reports it as
 * `finalized`. This route no longer writes derived rows at all.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const request_id = genReqId();
  const { id: quotationId } = await params;
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

    const body = await request.json().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "A JSON body with an installments array is required", code: "installments_required" },
        { status: 400 },
      );
    }

    // The schedule is required. A missing or empty array used to become a
    // zero-installment contract; it is now a refusal before any write.
    if (!Array.isArray(body.installments) || body.installments.length === 0) {
      return NextResponse.json(
        {
          error: "A conversion needs an installment schedule with at least one entry",
          code: "installments_required",
        },
        { status: 400 },
      );
    }

    // seq defaults to position: `inst.seq` omitted used to become 1 for every
    // row, and installment_plans has a UNIQUE (contract_id, seq).
    const schedule: { seq: number; amount: number; due_date: string | null; description: string }[] = [];
    const seen = new Set<number>();
    for (const [index, raw] of body.installments.entries()) {
      const inst = (raw ?? {}) as {
        seq?: unknown;
        amount?: unknown;
        due_date?: unknown;
        description?: unknown;
      };
      const seq = Number.isInteger(inst.seq) && (inst.seq as number) > 0 ? (inst.seq as number) : index + 1;
      const amount = typeof inst.amount === "number" ? inst.amount : Number(inst.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json(
          { error: `Installment ${index + 1} needs a positive amount`, code: "installment_amount_invalid" },
          { status: 400 },
        );
      }
      if (seen.has(seq)) {
        return NextResponse.json(
          { error: `Installment sequence ${seq} appears twice`, code: "installment_seq_duplicate" },
          { status: 400 },
        );
      }
      seen.add(seq);
      schedule.push({
        seq,
        amount,
        due_date: typeof inst.due_date === "string" && inst.due_date ? inst.due_date : null,
        description: typeof inst.description === "string" ? inst.description : "",
      });
    }

    const { data: converted, error: rpcErr } = await supabase.rpc("convert_quotation_to_contract", {
      p_quotation_id: quotationId,
      p_payload: {
        // Checked against the token subject by money_actor(); a mismatch is 42501.
        actor_id: user.id,
        first_payment_due_date: body.first_payment_due_date || null,
        installments: schedule,
      } as Json,
    });

    if (rpcErr) {
      const failure = moneyRpcFailure(rpcErr, "Failed to convert quotation");
      const log = failure.status >= 500 ? logger.error : logger.warn;
      log(
        {
          err: rpcErr,
          request_id,
          operation: "quotation_convert",
          user_id: user.id,
          quotation_id: quotationId,
          error_code: rpcErr.code,
          http_status: failure.status,
        },
        "[Quotation Convert] convert_quotation_to_contract refused the request",
      );
      return NextResponse.json(failure.body, { status: failure.status });
    }

    const conversion = converted as {
      contract_id: string;
      contract_no: string;
      quotation_status: string;
      installments_count: number;
      already_converted?: boolean;
      finalized?: string[] | null;
    };

    // ── Committed, contract + schedule + approval + project + activity ──
    // Nothing derived is written here any more (P1-6). A retry of this exact
    // request reaches the routine's idempotent branch and reports what it had to
    // recreate, so a repair is a re-POST rather than an operator's SQL.
    if (conversion.already_converted) {
      logger.info(
        {
          request_id,
          operation: "quotation_convert",
          user_id: user.id,
          quotation_id: quotationId,
          contract_id: conversion.contract_id,
          finalized: conversion.finalized ?? [],
        },
        "[Quotation Convert] already converted; the routine finalized the missing derived rows",
      );
    }

    // Resolve the pending step and approvers from the committed contract.
    try {
      await dispatchPersistedNotification({
        actorId: user.id,
        input: {
          type: "contract_pending_approval",
          contract_id: conversion.contract_id,
        },
      });
    } catch (notifyErr) {
      logger.warn({
        err: notifyErr,
        request_id,
        operation: "quotation_convert_notification",
        user_id: user.id,
        contract_id: conversion.contract_id,
      }, "[Quotation Convert] Notification failed");
    }

    // Revalidate cached pages to reflect new contract
    revalidatePath("/quotes");
    revalidatePath("/contracts");
    revalidatePath("/leads");

    return NextResponse.json({
      success: true,
      contract_id: conversion.contract_id,
      contract_no: conversion.contract_no,
      quotation_status: conversion.quotation_status,
      installments_count: conversion.installments_count,
      already_converted: conversion.already_converted ?? false,
      ...(conversion.finalized && conversion.finalized.length > 0
        ? { finalized: conversion.finalized }
        : {}),
    });
  } catch (err: unknown) {
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : (err as Error).message;
    logger.error(
      {
        err,
        request_id,
        operation: "quotation_convert",
        quotation_id: quotationId,
      },
      "[Quotation Convert] Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
