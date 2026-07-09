// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/contracts/[id]
 *
 * Returns the full picture for a single contract:
 *   - contract row (+ lead customer name + salesperson profile)
 *   - installment_plans (ordered by seq)
 *   - payments (ordered by payment_date, with confirmer name)
 *   - contract_approvals (ordered by created_at, with approver name)
 *
 * Access control:
 *   - admin / boss / operator / finance → see any contract
 *   - sales                              → only own contracts (sales_id = user.id)
 *
 * NOTE: payments & contract_approvals each have multiple FKs to profiles, so we
 * resolve approver/confirmer names with a separate profiles lookup instead of
 * embedding (avoids PostgREST FK-disambiguation errors).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: contractId } = await params;

    const supabase = await createServerSupabase();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    const role = profile?.role ?? "sales";
    const isManagement =
      role === "admin" || role === "boss" || role === "operator" || role === "finance";

    // ── Contract row (single FK to leads → safe; sales via constraint name) ──
    const { data: contract, error } = await supabase
      .from("contracts")
      .select(
        `*,
        leads ( id, customer_name, phone, source ),
        profiles!contracts_sales_id_fkey ( id, full_name, email )`
      )
      .eq("id", contractId)
      .single();

    if (error || !contract) {
      return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    }

    if (!isManagement && contract.sales_id !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── Installment plans ──
    const { data: installments } = await supabase
      .from("installment_plans")
      .select("id, seq, amount, due_date, status, paid_amount, allocated_amount, description")
      .eq("contract_id", contractId)
      .order("seq", { ascending: true });

    // ── Payments ──
    const { data: payments } = await supabase
      .from("payments")
      .select(
        "id, amount, payment_date, payment_method, reference_no, confirmed, confirmed_at, confirmed_by, installment_plan_id, created_at"
      )
      .eq("contract_id", contractId)
      .order("payment_date", { ascending: false });

    // ── Approval history ──
    const { data: approvals } = await supabase
      .from("contract_approvals")
      .select("id, step, status, notes, reviewed_at, created_at, approver_id")
      .eq("contract_id", contractId)
      .order("created_at", { ascending: true });

    // ── Resolve approver / confirmer names in one profiles lookup ──
    const nameIds = new Set<string>();
    (payments ?? []).forEach((p: any) => { if (p.confirmed_by) nameIds.add(p.confirmed_by); });
    (approvals ?? []).forEach((a: any) => { if (a.approver_id) nameIds.add(a.approver_id); });
    const nameMap: Record<string, string> = {};
    if (nameIds.size > 0) {
      const { data: users } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", [...nameIds]);
      (users ?? []).forEach((u: any) => { nameMap[u.id] = u.full_name; });
    }

    const paymentsNamed = (payments ?? []).map((p: any) => ({
      ...p,
      confirmer_name: p.confirmed_by ? nameMap[p.confirmed_by] ?? null : null,
    }));
    const approvalsNamed = (approvals ?? []).map((a: any) => ({
      ...a,
      approver_name: a.approver_id ? nameMap[a.approver_id] ?? null : null,
    }));

    return NextResponse.json({
      contract,
      installments: installments ?? [],
      payments: paymentsNamed,
      approvals: approvalsNamed,
      canManage: isManagement,
    });
  } catch (err: any) {
    const message =
      process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    console.error("[API Contracts Detail] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
