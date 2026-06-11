import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/quotations/[id]/convert
 * Convert an accepted quotation into a draft contract.
 * Sets quotation status to 'contract_created' and links back via contract_id.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: quotationId } = await params;
    const supabase = await createServerSupabase();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch quotation with lead info
    const { data: quote, error: quoteErr } = await supabaseAdmin
      .from("quotations")
      .select("*, leads(id, customer_name)")
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

    // Generate contract number
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const { count } = await supabaseAdmin
      .from("contracts")
      .select("id", { count: "exact", head: true })
      .gte("created_at", now.toISOString().slice(0, 10));
    const seq = String((count ?? 0) + 1).padStart(3, "0");
    const contractNo = `NEW-${dateStr}-${seq}`;

    // Parse optional body for overrides
    const body = await request.json().catch(() => ({}));
    const installments = body.installments || [];

    // Create contract from quotation data
    const { data: contract, error: contractErr } = await supabaseAdmin
      .from("contracts")
      .insert({
        lead_id: quote.lead_id,
        quotation_id: quote.id,
        sales_id: quote.created_by,
        created_by: user.id,
        contract_no: contractNo,
        contract_date: now.toISOString().slice(0, 10),
        contract_amount: quote.total_amount,
        currency: quote.currency || "AED",
        party_a_name: quote.leads?.customer_name || "Unknown",
        party_b_name: "NewMe Smart Home FZCO",
        status: "draft",
        first_payment_due_date: body.first_payment_due_date || null,
      })
      .select("id, contract_no")
      .single();

    if (contractErr) {
      console.error("[Quotation Convert] Contract insert failed:", contractErr);
      return NextResponse.json(
        { error: "Failed to create contract" },
        { status: 500 }
      );
    }

    // Create installment plans if provided
    if (installments.length > 0) {
      const rows = installments.map((inst: { seq: number; amount: number; due_date: string; description?: string }) => ({
        contract_id: contract.id,
        seq: inst.seq,
        amount: inst.amount,
        due_date: inst.due_date,
        description: inst.description || "",
        status: "pending",
      }));
      const { error: instErr } = await supabaseAdmin
        .from("installment_plans")
        .insert(rows);
      if (instErr) {
        console.error("[Quotation Convert] Installment insert failed:", instErr);
      }
    }

    // Create first approval record
    await supabaseAdmin.from("contract_approvals").insert({
      contract_id: contract.id,
      step: "admin_review",
      status: "pending",
      notes: { source: "quotation", quotation_id: quote.id, quote_no: quote.quote_no },
    });

    // Update quotation: link contract + change status
    await supabaseAdmin
      .from("quotations")
      .update({
        contract_id: contract.id,
        status: "contract_created",
        updated_at: new Date().toISOString(),
      })
      .eq("id", quotationId);

    // Update lead stage to contract_won
    if (quote.lead_id) {
      await supabaseAdmin
        .from("leads")
        .update({ stage: "contract_won", updated_at: new Date().toISOString() })
        .eq("id", quote.lead_id);
    }

    // Log activity
    await supabaseAdmin.from("activities").insert({
      lead_id: quote.lead_id,
      type: "note",
      content: `合同 ${contractNo} 已从报价 ${quote.quote_no} 自动创建，待审批`,
      ai_generated: true,
      user_id: user.id,
    });

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

    return NextResponse.json({
      success: true,
      contract_id: contract.id,
      contract_no: contract.contract_no,
      quotation_status: "contract_created",
    });
  } catch (err: unknown) {
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : (err as Error).message;
    console.error("[Quotation Convert] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
