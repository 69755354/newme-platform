// RBAC: user (authenticated) + service_role
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabase } from "@/lib/supabase-server";

// GET /api/kpi/targets?period=2026-06
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period");

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let q = supabaseAdmin.from("kpi_targets").select("*, profiles(full_name)");
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
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check role
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || !["admin", "boss", "operator"].includes(profile.role)) {
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
    period,
    target_type: t.target_type,
    target_amount: t.target_amount,
    assigned_to: t.assigned_to || null,
    notes: t.notes || null,
    set_by: user.id,
  }));

  // Delete-then-insert strategy: upsert with nullable assigned_to is broken
  // because SQL NULL != NULL in the unique constraint, so duplicates accumulate.
  // Step 1: delete all existing targets for this period
  const { error: delError } = await supabaseAdmin
    .from("kpi_targets")
    .delete()
    .eq("period", period);
  if (delError) {
    const msg = process.env.NODE_ENV === "production" ? "Internal server error" : delError.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Step 2: insert fresh rows
  const { data, error } = await supabaseAdmin
    .from("kpi_targets")
    .insert(rows)
    .select();

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

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || !["admin", "boss", "operator"].includes(profile.role)) {
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
