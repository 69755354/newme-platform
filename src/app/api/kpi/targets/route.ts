// RBAC: user (authenticated) + service_role
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabase } from "@/lib/supabase-server";
import { applyPrivateNoStore } from "@/lib/request-auth-context";
import { moneyRpcFailure } from "@/lib/money-rpc.mjs";

// R5: kpi_targets.actual_amount is maintained by confirm_payment() and
// void_payment(), so this read is money-derived and must not be served from any
// cache — see tests/security/api-cache-money-boundary.test.mjs, which derives that
// rule from what each route queries.
export const dynamic = "force-dynamic";

// GET /api/kpi/targets?period=2026-06
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period");

  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // F-15: read through the caller's RLS client. kpi_targets SELECT policies
  // already grant admin/boss/operator every row and restrict sales to their own
  // (or unassigned) targets, so this closes the service_role bypass without
  // changing what an authorized user sees.
  let q = supabase
    .from("kpi_targets")
    .select("*, profiles!kpi_targets_assigned_to_fkey(full_name)");
  if (period) q = q.eq("period", period);

  const { data, error } = await q.order("assigned_to", { ascending: true, nullsFirst: true });
  if (error) {
    const msg = process.env.NODE_ENV === "production" ? "Internal server error" : error.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return applyPrivateNoStore(NextResponse.json({ data }));
}

// POST /api/kpi/targets — batch upsert targets for a period
export async function POST(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check role
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  // The service-role RPC bypasses RLS, so this check must match the table's
  // admin/boss write policy exactly. Operators retain read access only.
  if (!profile?.role || !["admin", "boss"].includes(profile.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { period, targets } = body as {
    period: string;
    targets: { target_type: string; target_amount: number; assigned_to: string | null; notes?: string }[];
  };

  if (!period || !targets?.length) {
    return NextResponse.json({ error: "period and targets required" }, { status: 400 });
  }

  const rows = targets.map(t => ({
    target_type: t.target_type,
    target_amount: t.target_amount,
    assigned_to: t.assigned_to || null,
    notes: t.notes || null,
  }));

  // Delete-then-insert is the right strategy — an upsert cannot be used because
  // assigned_to is nullable and NULL never equals NULL in the unique constraint,
  // so duplicates accumulate. But it has to happen in ONE transaction.
  //
  // This used to be two PostgREST calls, i.e. two transactions: delete the
  // period, then insert the new rows. Any failure of the second (a target_type
  // CHECK violation, a NUMERIC(12,2) overflow, an unknown assigned_to, a dropped
  // connection) left the delete committed and the period EMPTY, with no copy of
  // what had been there and no restore path. One malformed row from the settings
  // UI wiped every target for the month.
  //
  // replace_kpi_targets does both statements in a single transaction, so a bad
  // row now rolls the delete back and the existing targets survive.
  const { data, error } = await supabaseAdmin.rpc("replace_kpi_targets", {
    p_period: period,
    p_rows: rows,
    p_set_by: user.id,
  });

  if (error) {
    const msg = process.env.NODE_ENV === "production" ? "Internal server error" : error.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ data });
}

// DELETE /api/kpi/targets?period=2026-06 — clear all targets for a period
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period");

  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // B7: admin/boss, not admin/boss/operator. The write below goes out on the
  // service-role client, which bypasses RLS, so this list is the ONLY thing
  // enforcing the rule — and the database's own DELETE policy on kpi_targets
  // (20260701000000_non_core_tables_rls_fix.sql:227) is admin/boss. Measured on an
  // isolated PG17 with the branch migrations applied: an operator's identical
  // `delete from kpi_targets where period = ...` as `authenticated` removes 0 rows,
  // and the same statement as `service_role` removes every one of them. Keeping
  // operator here meant the route granted a capability the database refuses.
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile?.role || !["admin", "boss"].includes(profile.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!period) return NextResponse.json({ error: "period required" }, { status: 400 });

  // B7: this used to be
  //     await supabaseAdmin.from("kpi_targets").delete().eq("period", period);
  // i.e. the service-role client reaching the table without reaching the routine
  // that owns the write. replace_kpi_targets() carries actual_amount forward and
  // refuses a payload that drops a target still holding collected money; this
  // statement dropped the same money by a different verb, and took none of the
  // period advisory lock that serializes same-period saves. Reproduced on an
  // isolated PG17, both release modes: the service-role delete answered 00000,
  // removed 2 rows and took recorded actuals 700.00 -> 0, and a second connection
  // could take the period lock while that delete was still in flight.
  //
  // clear_kpi_targets() takes the same lock and refuses (22023) when any row in the
  // period holds a non-zero actual_amount, so clearing an untouched period still
  // works and clearing collected money is no longer expressible.
  const { data: removed, error } = await supabaseAdmin.rpc("clear_kpi_targets", {
    p_period: period,
    p_actor: user.id,
  });

  if (error) {
    const { status, body } = moneyRpcFailure(error, "Failed to clear the period's KPI targets");
    return NextResponse.json(body, { status });
  }

  return NextResponse.json({ success: true, rows_removed: removed ?? 0 });
}
