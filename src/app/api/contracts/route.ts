import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/contracts
 * Creates a contract with installment plans.
 * Requires authentication via session cookie.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      lead_id,
      amount,
      currency,
      party_a_name,
      party_a_contact,
      party_b_name,
      installments,
      first_payment_due_date,
    } = body;

    if (!lead_id) {
      return NextResponse.json({ error: "lead_id is required" }, { status: 400 });
    }
    if (!amount || typeof amount !== "number" || amount <= 0) {
      return NextResponse.json({ error: "Valid amount is required" }, { status: 400 });
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");

    const { count } = await supabase
      .from("contracts")
      .select("id", { count: "exact", head: true })
      .gte("created_at", now.toISOString().slice(0, 10));
    const seq = String((count ?? 0) + 1).padStart(3, "0");
    const contractNo = `NEW-${dateStr}-${seq}`;

    const { data: contract, error: contractErr } = await supabase
      .from("contracts")
      .insert({
        lead_id,
        sales_id: user.id,
        created_by: user.id,
        contract_no: contractNo,
        contract_date: now.toISOString().slice(0, 10),
        contract_amount: amount,
        currency: currency || "AED",
        party_a_name: party_a_name || "Unknown",
        party_a_contact: party_a_contact || null,
        party_b_name: party_b_name || "NewMe Smart Home FZCO",
        status: "draft",
        first_payment_due_date: first_payment_due_date || null,
      })
      .select("id")
      .single();

    if (contractErr) {
      console.error("[API Contracts] Insert failed:", contractErr);
      return NextResponse.json({ error: "Failed to create contract" }, { status: 500 });
    }

    if (installments && Array.isArray(installments) && installments.length > 0) {
      const installmentRows = installments.map((inst: any) => ({
        contract_id: contract.id,
        seq: inst.seq || 1,
        amount: inst.amount || 0,
        due_date: inst.due_date || now.toISOString().slice(0, 10),
        description: inst.description || "",
        status: "pending",
      }));

      const { error: instErr } = await supabase
        .from("installment_plans")
        .insert(installmentRows);

      if (instErr) {
        console.error("[API Contracts] Installment insert failed:", instErr);
        return NextResponse.json({
          id: contract.id,
          contract_no: contractNo,
          warning: "Contract created but installment plans failed",
        });
      }
    }

    // Create first approval record (admin_review step)
    const { error: approvalErr } = await supabase
      .from("contract_approvals")
      .insert({
        contract_id: contract.id,
        step: "admin_review",
        status: "pending",
        notes: { source: "auto_created" },
      });

    if (approvalErr) {
      console.error(
        "[API Contracts] Approval record insert failed:",
        approvalErr
      );
    }

    // Notify admins that contract is pending approval
    try {
      await fetch(`${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "contract_pending_approval",
          contract_id: contract.id,
          contract_no: contractNo,
          lead_id,
          amount,
        }),
      });
    } catch (notifyErr) {
      console.warn("[API Contracts] Notification failed:", notifyErr);
    }

    revalidatePath("/contracts");
    revalidatePath("/leads");

    return NextResponse.json({ id: contract.id, contract_no: contractNo });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    console.error("[API Contracts] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/contracts — list contracts with optional filters
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch user role for access control
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (!profile) {
      return NextResponse.json({ error: "Profile not found" }, { status: 403 });
    }

    const userRole = profile.role;

    // Deny access to roles that shouldn't see contracts
    if (!["admin", "boss", "sales", "finance", "operator"].includes(userRole)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const leadId = searchParams.get("lead_id");

    let q = supabase.from("contracts").select("*, installment_plans(*)").order("created_at", { ascending: false });
    if (leadId) q = q.eq("lead_id", leadId);

    // sales role: only see own contracts
    if (userRole === "sales") {
      q = q.eq("sales_id", user.id);
    }
    // admin/boss/finance/operator: see all (no additional filter)

    const { data, error } = await q;
    if (error) {
      return NextResponse.json({ error: "Failed to fetch contracts" }, { status: 500 });
    }
    return NextResponse.json({ data });
  } catch (err: any) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * PUT /api/contracts — update contract fields including first_payment_status
 * Body: { id: string, first_payment_status?: string, first_payment_due_date?: string }
 */
export async function PUT(request: NextRequest) {
  try {
    const supabase = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { id, first_payment_status, first_payment_due_date } = body;

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    // Verify user owns this contract or is admin
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    const isAdmin = profile?.role && ["admin", "boss", "operator"].includes(profile.role);

    if (!isAdmin) {
      const { data: contract } = await supabase
        .from("contracts")
        .select("sales_id")
        .eq("id", id)
        .single();
      if (!contract || contract.sales_id !== user.id) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const updates: Record<string, any> = {};
    if (first_payment_status !== undefined) {
      if (!["unpaid", "partial", "paid"].includes(first_payment_status)) {
        return NextResponse.json({ error: "Invalid first_payment_status" }, { status: 400 });
      }
      updates.first_payment_status = first_payment_status;
    }
    if (first_payment_due_date !== undefined) {
      updates.first_payment_due_date = first_payment_due_date;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    updates.updated_at = new Date().toISOString();

    const { error } = await supabase
      .from("contracts")
      .update(updates)
      .eq("id", id);

    if (error) {
      console.error("[API Contracts] Update failed:", error);
      return NextResponse.json({ error: "Failed to update contract" }, { status: 500 });
    }

    revalidatePath("/contracts");

    return NextResponse.json({ success: true });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    console.error("[API Contracts] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
