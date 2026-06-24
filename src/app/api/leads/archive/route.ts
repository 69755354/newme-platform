// POST /api/leads/archive — Soft-archive leads (Mohamed or specific lead_ids)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check role — only boss/admin can archive
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || !["admin", "boss"].includes(profile.role)) {
    return NextResponse.json({ error: "Forbidden: boss/admin only" }, { status: 403 });
  }

  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { lead_ids, archive_reason } = body;
  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();

  let query = supabase.from("leads").update({
    archived: true,
    archived_at: now,
    archive_batch_id: batchId,
    archive_reason: archive_reason || "Mohamed old leads cleanup",
  });

  if (lead_ids && Array.isArray(lead_ids) && lead_ids.length > 0) {
    query = query.in("id", lead_ids);
  } else {
    // Find Mohamed's user_id
    const { data: mohamed } = await supabase.from("profiles").select("id").ilike("full_name", "%mohamed%").single();
    if (!mohamed) return NextResponse.json({ error: "Mohamed not found in profiles" }, { status: 404 });
    
    // Archive all leads assigned to Mohamed that are not already archived
    query = query.eq("assigned_to", mohamed.id).is("archived", null);
  }

  const { error, count } = await query.select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    archived_count: (count ?? 0) || 0,
    archive_batch_id: batchId,
  });
}

// GET /api/leads/archive?batch_id=xxx — Lookup archived leads by batch
export async function GET(request: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const batchId = request.nextUrl.searchParams.get("batch_id");
  if (!batchId) return NextResponse.json({ error: "batch_id required" }, { status: 400 });

  const { data, error } = await supabase
    .from("leads")
    .select("id, customer_name, phone, archived_at, archive_reason")
    .eq("archive_batch_id", batchId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ leads: data, count: data.length });
}
