// RBAC: user (authenticated) + service_role
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabase } from "@/lib/supabase-server";

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

  return NextResponse.json({ data });
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
  if (!profile?.role || !["admin", "boss", "operator"].includes(profile.role)) {
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

// DELETE /api/kpi/targets?period=2026-06 — delete all targets for a period
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period");

  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile?.role || !["admin", "boss", "operator"].includes(profile.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!period) return NextResponse.json({ error: "period required" }, { status: 400 });

  const { error } = await supabaseAdmin.from("kpi_targets").delete().eq("period", period);
  if (error) {
    const msg = process.env.NODE_ENV === "production" ? "Internal server error" : error.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
