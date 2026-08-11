// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";
import { moneyRpcFailure } from "@/lib/money-rpc.mjs";
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
 * The bookkeeping AFTER the conversion — project, activity, notification — is
 * still separate, still non-fatal, and still reported in `warnings`: those rows
 * are derived, and destroying a committed contract because an activity insert
 * failed is the behaviour this release removes, not one to keep.
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

    // Parse optional body for overrides
    const body = await request.json().catch(() => ({}));
    const installments = Array.isArray(body.installments) ? body.installments : [];

    // seq defaults to position: `inst.seq` omitted used to become 1 for every
    // row, and installment_plans has a UNIQUE (contract_id, seq).
    const schedule = installments.map(
      (inst: { seq?: number; amount?: number; due_date?: string; description?: string }, index: number) => ({
        seq: Number.isFinite(inst?.seq) ? inst.seq : index + 1,
        amount: Number.isFinite(inst?.amount) ? inst.amount : 0,
        due_date: inst?.due_date || null,
        description: typeof inst?.description === "string" ? inst.description : "",
      }),
    );

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
    };

    // ── Committed. Everything below is derived bookkeeping ──────────────
    const warnings: string[] = [];
    const noteFailure = (stage: string, err: unknown) => {
      warnings.push(stage);
      logger.error(
        { err, request_id, operation: "quotation_convert", stage, contract_id: conversion.contract_id },
        `[Quotation Convert] ${stage} failed after the conversion committed`,
      );
    };

    const { data: quote, error: quoteReadErr } = await supabase
      .from("quotations")
      .select("id, quote_no, lead_id, created_by, total_amount, leads(customer_id, customer_name, property_type, property_size_sqm, location)")
      .eq("id", quotationId)
      .single();

    if (quoteReadErr || !quote) {
      // The conversion happened; only the follow-up rows are affected.
      noteFailure("quotation_read_back", quoteReadErr);
    } else {
      const lead = quote.leads as {
        customer_id?: string | null;
        customer_name?: string | null;
        property_type?: string | null;
        property_size_sqm?: number | null;
        location?: string | null;
      } | null;

      // on_lead_won() creates a project only for a lead that has no contract yet,
      // and the conversion above created one in the same transaction that marked
      // the lead won — so the trigger returned early and this is the project row.
      const projectName = `${lead?.customer_name || "Client"} - ${lead?.property_type || "Smart Home"}`;
      const { error: projectErr } = await supabase.from("projects").insert({
        lead_id: quote.lead_id,
        contract_id: conversion.contract_id,
        sales_id: quote.created_by,
        customer_id: lead?.customer_id || null,
        name: projectName,
        property_type: lead?.property_type || null,
        property_size: lead?.property_size_sqm || null,
        location: lead?.location || null,
        phase: "design",
        status: "active",
        contract_amount: quote.total_amount,
      });
      if (projectErr) noteFailure("project_insert", projectErr);

      const { error: activityErr } = await supabase.from("activities").insert({
        lead_id: quote.lead_id,
        type: "note",
        content: `合同 ${conversion.contract_no} 已从报价 ${quote.quote_no} 自动创建，待审批`,
        ai_generated: true,
        user_id: user.id,
      });
      if (activityErr) noteFailure("activity_insert", activityErr);
    }

    // Notify admins
    try {
      await fetch(
        `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/notify`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "contract_pending_approval",
            contract_id: conversion.contract_id,
            lead_id: quote?.lead_id ?? null,
            amount: quote?.total_amount ?? null,
          }),
        }
      );
    } catch {
      // non-blocking
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
      ...(warnings.length > 0 ? { warnings } : {}),
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
