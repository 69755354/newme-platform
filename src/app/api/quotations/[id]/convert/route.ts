// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger, genReqId } from "@/lib/logger";

/**
 * POST /api/quotations/[id]/convert
 * Convert an accepted quotation into a draft contract.
 * Sets quotation status to 'contract_created' and links back via contract_id.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const request_id = genReqId();
  const { id: quotationId } = await params;
  try {    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch quotation with lead info
    const { data: quote, error: quoteErr } = await supabase
      .from("quotations")
      .select("*, leads(id, customer_name, property_type, property_size_sqm, location, phone)")
      .eq("id", quotationId)
      .single();

    if (quoteErr || !quote) {
      return NextResponse.json(
        { error: "Quotation not found" },
        { status: 404 }
      );
    }

    // Only accepted quotations can be converted
    if (quote.status !== "accepted") {
      return NextResponse.json(
        { error: "Only accepted quotations can be converted", current_status: quote.status },
        { status: 400 }
      );
    }

    // Zero-total quotations cannot be converted: contract_amount would violate
    // the DB CHECK (contracts_contract_amount_check). Pre-check as 400 instead
    // of letting the insert below fail with a 500.
    if (!(quote.total_amount > 0)) {
      return NextResponse.json(
        { error: "Quotation total must be greater than zero to convert" },
        { status: 400 }
      );
    }

    // Check if contract already created from this quotation
    if (quote.contract_id) {
      return NextResponse.json(
        { error: "Contract already created from this quotation", contract_id: quote.contract_id },
        { status: 409 }
      );
    }

    // Fetch user role
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    const isAdmin =
      profile?.role && ["admin", "boss", "operator"].includes(profile.role);

    // Sales can only convert their own quotations
    if (!isAdmin && quote.created_by !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const now = new Date();
    const contractDate = now.toISOString().slice(0, 10);
    const dateStr = contractDate.replace(/-/g, "");

    // Parse optional body for overrides
    const body = await request.json().catch(() => ({}));
    const installments = body.installments || [];

    // Claim the quotation BEFORE creating anything, with a conditional update.
    //
    // The `quote.contract_id` check above is a read, and the write that acted on
    // it came at the very end of the request, so two concurrent POSTs both read
    // contract_id = null and both created a contract for the same quotation —
    // duplicate contracts, duplicate approval records, duplicate projects, and a
    // lead marked won twice. Rows matched is the interlock: exactly one caller
    // can move the quotation out of 'accepted', and the loser gets 409. Also
    // covers the sequential retry case, where the first attempt failed after
    // creating a contract.
    const { data: claimed, error: claimErr } = await supabase
      .from("quotations")
      .update({ status: "contract_created", updated_at: new Date().toISOString() })
      .eq("id", quotationId)
      .eq("status", "accepted")
      .is("contract_id", null)
      .select("id");

    if (claimErr) {
      logger.error(
        { err: claimErr, request_id, operation: "quotation_convert", user_id: user.id, quotation_id: quotationId },
        "[Quotation Convert] Quotation claim failed",
      );
      return NextResponse.json({ error: "Failed to convert quotation" }, { status: 500 });
    }
    if (!claimed || claimed.length === 0) {
      return NextResponse.json(
        { error: "Quotation is already being converted or is no longer accepted" },
        { status: 409 },
      );
    }

    // Release the claim if we cannot finish. Without this, a failure would leave
    // the quotation permanently stuck in 'contract_created' with no contract.
    const releaseClaim = async () => {
      const { error } = await supabase
        .from("quotations")
        .update({ status: "accepted", updated_at: new Date().toISOString() })
        .eq("id", quotationId)
        .is("contract_id", null);
      if (error) {
        logger.error(
          { err: error, request_id, operation: "quotation_convert", quotation_id: quotationId },
          "[Quotation Convert] CRITICAL: quotation claim could not be released",
        );
      }
    };

    // Contract number. The sequence was counted through the CALLER's RLS client:
    //
    //     await supabase.from("contracts").select("id", {count: "exact", head: true})
    //
    // policy_contracts_select_sales restricts a sales user to their own rows, so
    // the count excluded every contract their colleagues created that day. The
    // number generated was therefore one that already existed, contract_no is
    // UNIQUE (20260605000000_newme_crm_v22_complete.sql:79), and the insert died
    // with 23505 → 500 "Failed to create contract". Not a race: a deterministic
    // failure for any non-admin converting on a day when someone else had already
    // signed a contract.
    //
    // Counting on service_role sees every row, and the retry loop handles the
    // genuine concurrent-insert race that UNIQUE is there to catch.
    const { count: sameDayCount, error: countErr } = await supabaseAdmin
      .from("contracts")
      .select("id", { count: "exact", head: true })
      .eq("contract_date", contractDate);

    if (countErr) {
      logger.error(
        { err: countErr, request_id, operation: "quotation_convert", quotation_id: quotationId },
        "[Quotation Convert] Contract number sequence read failed",
      );
      await releaseClaim();
      return NextResponse.json({ error: "Failed to create contract" }, { status: 500 });
    }

    const MAX_CONTRACT_NO_ATTEMPTS = 10;
    let contract: { id: string; contract_no: string } | null = null;
    let contractErr: { code?: string; message?: string } | null = null;

    for (let attempt = 0; attempt < MAX_CONTRACT_NO_ATTEMPTS; attempt += 1) {
      const seq = String((sameDayCount ?? 0) + 1 + attempt).padStart(3, "0");
      const { data, error } = await supabase
        .from("contracts")
        .insert({
          lead_id: quote.lead_id,
          quotation_id: quote.id,
          sales_id: quote.created_by,
          created_by: user.id,
          contract_no: `NEW-${dateStr}-${seq}`,
          contract_date: contractDate,
          contract_amount: quote.total_amount,
          currency: quote.currency || "AED",
          party_a_name: quote.leads?.customer_name || "Unknown",
          party_b_name: "NewMe Smart Home FZCO",
          status: "draft",
          first_payment_due_date: body.first_payment_due_date || null,
        })
        .select("id, contract_no")
        .single();

      if (!error) {
        contract = data;
        contractErr = null;
        break;
      }
      contractErr = error;
      // 23505 = unique_violation: another contract took this number. Any other
      // error is not going to be fixed by trying a different number.
      if (error.code !== "23505") break;
    }

    if (!contract) {
      logger.error(
        {
          err: contractErr,
          request_id,
          operation: "quotation_convert",
          user_id: user.id,
          quotation_id: quotationId,
        },
        "[Quotation Convert] Contract insert failed",
      );
      await releaseClaim();
      return NextResponse.json(
        { error: "Failed to create contract" },
        { status: 500 }
      );
    }

    // Undo the contract on a fatal failure below. The five writes that follow are
    // five separate transactions, so there is no rollback to fall back on: the
    // previous implementation discarded every one of their errors, awaiting them
    // without inspecting the result, and returned `success: true` regardless. A
    // failed installment insert produced a signed-value contract with no payment
    // schedule; a failed contract_approvals insert produced a contract that could
    // never be approved; a failed quotations update left contract_id NULL, so the
    // duplicate-conversion guard never armed and the next POST created a second
    // contract. All three reported success.
    //
    // Compensation runs on service_role because `authenticated` has no DELETE
    // policy on contracts — this removes a row created moments ago by this same
    // request, and nothing else.
    const deleteContract = async () => {
      const { error } = await supabaseAdmin.from("contracts").delete().eq("id", contract.id);
      if (error) {
        logger.error(
          { err: error, request_id, operation: "quotation_convert", contract_id: contract.id },
          "[Quotation Convert] CRITICAL: contract compensation delete failed; orphan contract left behind",
        );
      }
    };
    const abort = async (stage: string, err: unknown) => {
      logger.error(
        {
          err,
          request_id,
          operation: "quotation_convert",
          stage,
          user_id: user.id,
          quotation_id: quotationId,
          contract_id: contract.id,
        },
        `[Quotation Convert] ${stage} failed; rolling back conversion`,
      );
      await deleteContract();
      await releaseClaim();
      return NextResponse.json({ error: "Failed to convert quotation" }, { status: 500 });
    };

    // Installment plans, if provided. A contract whose payment schedule silently
    // failed to materialise is a money defect, so this is fatal.
    if (installments.length > 0) {
      const rows = installments.map((inst: { seq: number; amount: number; due_date: string; description?: string }) => ({
        contract_id: contract.id,
        seq: inst.seq,
        amount: inst.amount,
        due_date: inst.due_date,
        description: inst.description || "",
        status: "pending",
      }));
      const { error: instErr } = await supabase
        .from("installment_plans")
        .insert(rows);
      if (instErr) return abort("installment_plans_insert", instErr);
    }

    // First approval record. Without it the contract is unapprovable, so fatal.
    const { error: approvalErr } = await supabase.from("contract_approvals").insert({
      contract_id: contract.id,
      step: "admin_review",
      status: "pending",
      notes: { source: "quotation", quotation_id: quote.id, quote_no: quote.quote_no },
    });
    if (approvalErr) return abort("contract_approvals_insert", approvalErr);

    // Link the contract onto the claimed quotation. This is what makes the
    // conversion idempotent for every later request, so it is fatal too.
    const { error: linkErr } = await supabase
      .from("quotations")
      .update({
        contract_id: contract.id,
        status: "contract_created",
        updated_at: new Date().toISOString(),
      })
      .eq("id", quotationId);
    if (linkErr) return abort("quotation_link", linkErr);

    // Past this point the conversion is committed and must not be undone: the
    // contract exists and the quotation points at it. The remaining writes are
    // derived bookkeeping — a failure is reported to the caller rather than
    // swallowed, and rather than destroying a valid contract.
    const warnings: string[] = [];
    const noteFailure = (stage: string, err: unknown) => {
      warnings.push(stage);
      logger.error(
        { err, request_id, operation: "quotation_convert", stage, contract_id: contract.id },
        `[Quotation Convert] ${stage} failed after the conversion committed`,
      );
    };

    // Update lead final_status to won
    if (quote.lead_id) {
      const { error } = await supabase
        .from("leads")
        .update({ final_status: "won", updated_at: new Date().toISOString() })
        .eq("id", quote.lead_id);
      if (error) noteFailure("lead_final_status", error);
    }

    // Create project for won lead
    const lead = quote.leads as any;
    const projectName = `${lead?.customer_name || "Client"} - ${lead?.property_type || "Smart Home"}`;
    const { error: projectErr } = await supabase.from("projects").insert({
      lead_id: quote.lead_id,
      contract_id: contract.id,
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

    // Log activity
    const { error: activityErr } = await supabase.from("activities").insert({
      lead_id: quote.lead_id,
      type: "note",
      content: `合同 ${contract.contract_no} 已从报价 ${quote.quote_no} 自动创建，待审批`,
      ai_generated: true,
      user_id: user.id,
    });
    if (activityErr) noteFailure("activity_insert", activityErr);

    // Notify admins
    try {
      await fetch(
        `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/notify`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "contract_pending_approval",
            contract_id: contract.id,
            lead_id: quote.lead_id,
            amount: quote.total_amount,
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
      contract_id: contract.id,
      contract_no: contract.contract_no,
      quotation_status: "contract_created",
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
