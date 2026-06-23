import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/payments
 * Records a new payment against a contract.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase();
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

    const userRole = profile?.role;
    const isPrivileged = userRole && ["admin", "boss", "finance", "operator"].includes(userRole);

    // Sales can only record payments against their own contracts
    if (!isPrivileged && contract.sales_id !== user.id) {
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
      })
      .select("id, amount")
      .single();

    if (insertErr) {
      console.error("[API Payments] Insert failed:", insertErr);
      return NextResponse.json({ error: "Failed to record payment" }, { status: 500 });
    }

    return NextResponse.json({ id: payment.id, amount: payment.amount }, { status: 201 });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    console.error("[API Payments] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/payments
 * Lists payments with optional filters.
 * Query params: contract_id, confirmed
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSupabase();
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

    if (!profile) {
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
        console.error("[API Payments] Failed to fetch sales contracts:", contractsErr);
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
      console.error("[API Payments] Fetch failed:", error);
      return NextResponse.json({ error: "Failed to fetch payments" }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    console.error("[API Payments] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
