// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/dashboard/payment-tracker
 *
 * Returns payment tracking data: summary, installment details, per-rep collection.
 * CEO/Admin: all data. Sales: only their own.
 *
 * Response shape:
 * {
 *   summary: { totalContractValue, collected, overdue, dueThisWeek }
 *   installments: { id, contract_id, contract_no, contract_amount, customer_name, sales_id,
 *                   seq, amount, due_date, status, overdue_days, paid_amount }[]
 *   perRep: { user_id, full_name, signed_amount, collected, collection_rate, overdue_count }[]
 * }
 */
export async function GET(request: NextRequest) {
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user role
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    const role = profile?.role ?? "sales";
    const isManagement = ["admin", "boss", "operator"].includes(role);

    const userId = user.id;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // ─── Step 1: Fetch contracts with installment plans and payments ───
    let contractQuery = supabase
      .from("contracts")
      .select(`
        id, contract_no, contract_amount, contract_date, status, sales_id,
        party_a_name, lead_id,
        leads!contracts_lead_id_fkey!inner(customer_name, assigned_to),
        installment_plans!installment_plans_contract_id_fkey(id, seq, amount, due_date, status, paid_amount),
        payments!payments_contract_id_fkey(id, amount, confirmed, payment_date)
      `)
      .order("created_at", { ascending: false });

    if (!isManagement) {
      contractQuery = contractQuery.eq("sales_id", userId);
    }

    const { data: contracts, error: contractsErr } = await contractQuery;
    if (contractsErr) {
      console.error("[payment-tracker] Failed to fetch contracts:", contractsErr);
      return NextResponse.json({ error: "Failed to fetch contracts" }, { status: 500 });
    }

    // ─── Step 2: Compute summary ───
    let totalContractValue = 0;
    let collected = 0;
    let overdueTotal = 0;
    let dueThisWeekTotal = 0;

    // Compute next 7 days boundary
    const nextWeekDate = new Date();
    nextWeekDate.setDate(nextWeekDate.getDate() + 7);
    const nextWeekStr = nextWeekDate.toISOString().slice(0, 10);

    const allInstallments: any[] = [];

    for (const contract of contracts || []) {
      const amount = contract.contract_amount || 0;
      totalContractValue += amount;

      // Collected: sum of confirmed payments
      for (const p of contract.payments || []) {
        if (p.confirmed) {
          collected += p.amount || 0;
        }
      }

      // Process installments
      for (const inst of contract.installment_plans || []) {
        const paid = inst.paid_amount || 0;
        const dueDate = inst.due_date;
        let status = inst.status; // base status from DB

        // Override status logic
        if (status !== "paid" && status !== "cancelled") {
          if (paid >= inst.amount) {
            status = "paid";
          } else if (dueDate < today) {
            status = "overdue";
          } else if (dueDate >= today && dueDate <= nextWeekStr) {
            status = "due_soon";
          } else {
            status = "pending";
          }
        }

        const overdueDays = status === "overdue" && dueDate
          ? Math.floor((new Date(today).getTime() - new Date(dueDate).getTime()) / 86_400_000)
          : 0;

        if (status === "overdue") {
          overdueTotal += (inst.amount - paid);
        }
        if (status === "due_soon") {
          dueThisWeekTotal += (inst.amount - paid);
        }

        const leadInfo = Array.isArray(contract.leads) ? contract.leads[0] : contract.leads;
        const customerName = leadInfo?.customer_name || contract.party_a_name || "Unknown";

        allInstallments.push({
          id: inst.id,
          contract_id: contract.id,
          contract_no: contract.contract_no,
          contract_amount: contract.contract_amount,
          customer_name: customerName,
          sales_id: contract.sales_id,
          seq: inst.seq,
          amount: inst.amount,
          due_date: inst.due_date,
          status,
          overdue_days: overdueDays,
          paid_amount: paid,
        });
      }
    }

    // Sort installments by overdue_days DESC, then due_date ASC
    allInstallments.sort((a, b) => {
      if (a.status === "overdue" && b.status !== "overdue") return -1;
      if (a.status !== "overdue" && b.status === "overdue") return 1;
      return b.overdue_days - a.overdue_days || (a.due_date < b.due_date ? -1 : 1);
    });

    // ─── Step 3: Per-rep collection ───
    // Get all sales profiles
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name, role")
      .in("role", ["sales", "admin", "boss"])
      .eq("is_active", true);

    const repMap: Record<string, { full_name: string; signed: number; collected: number; overdue: number }> = {};
    for (const p of profiles || []) {
      repMap[p.id] = { full_name: p.full_name || "Unknown", signed: 0, collected: 0, overdue: 0 };
    }

    for (const contract of contracts || []) {
      const sid = contract.sales_id || "unassigned";
      if (!repMap[sid]) {
        repMap[sid] = { full_name: "Unassigned", signed: 0, collected: 0, overdue: 0 };
      }
      repMap[sid].signed += contract.contract_amount || 0;

      for (const p of contract.payments || []) {
        if (p.confirmed) {
          repMap[sid].collected += p.amount || 0;
        }
      }

      // Count overdue installments for this rep
      for (const inst of contract.installment_plans || []) {
        const paid = inst.paid_amount || 0;
        const dueDate = inst.due_date;
        if (inst.status !== "paid" && inst.status !== "cancelled" && dueDate < today) {
          repMap[sid].overdue++;
        }
      }
    }

    const perRep = Object.entries(repMap)
      .filter(([id, _]) => id !== "unassigned")
      .map(([user_id, data]) => ({
        user_id,
        full_name: data.full_name,
        signed_amount: data.signed,
        collected: data.collected,
        collection_rate: data.signed > 0 ? Math.round((data.collected / data.signed) * 100) : 0,
        overdue_count: data.overdue,
      }))
      .sort((a, b) => b.signed_amount - a.signed_amount);

    // ─── Response ───
    return NextResponse.json({
      summary: {
        totalContractValue: Math.round(totalContractValue),
        collected: Math.round(collected),
        outstanding: Math.round(totalContractValue - collected),
        overdue: Math.round(overdueTotal),
        dueThisWeek: Math.round(dueThisWeekTotal),
      },
      installments: allInstallments,
      perRep,
    });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    console.error("[payment-tracker] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
