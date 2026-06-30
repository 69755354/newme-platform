// POST /api/leads/archive — Soft-archive leads (Mohamed or specific lead_ids)
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

/**
 * Verify the caller is boss/admin. Returns a 403 NextResponse when forbidden,
 * or null when allowed. Shared by POST and GET so both enforce the same role.
 */
async function requireBoss(
  supabase: SupabaseClient,
  userId: string,
): Promise<NextResponse | null> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();
  if (!profile || !["admin", "boss"].includes(profile.role)) {
    return NextResponse.json({ error: "Forbidden: boss/admin only" }, { status: 403 });
  }
  return null;
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check role — only boss/admin can archive
  const forbidden = await requireBoss(supabase, user.id);
  if (forbidden) return forbidden;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { lead_ids, archive_reason } = body;
  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const reason = archive_reason || "Mohamed old leads cleanup";

  let query = supabase.from("leads").update({
    archived: true,
    archived_at: now,
    archive_batch_id: batchId,
    archive_reason: reason,
  });

  if (lead_ids && Array.isArray(lead_ids) && lead_ids.length > 0) {
    query = query.in("id", lead_ids);
  } else {
    // Find Mohamed's user_id — scope to management roles + limit(1) for a precise,
    // deterministic match (avoids matching sales reps or erroring on multiple rows).
    const { data: candidates } = await supabase
      .from("profiles")
      .select("id")
      .ilike("full_name", "%mohamed%")
      .in("role", ["admin", "boss"])
      .limit(1);
    const mohamed = candidates?.[0];
    if (!mohamed) return NextResponse.json({ error: "Mohamed not found in profiles" }, { status: 404 });

    // Archive all leads assigned to Mohamed that are not already archived.
    // `archived` is BOOLEAN NOT NULL DEFAULT false — un-archived rows hold false,
    // never null, so we filter with .eq("archived", false).
    query = query.eq("assigned_to", mohamed.id).eq("archived", false);
  }

  // `.update().select()` returns { data, error } — there is no `count` field.
  // Derive the affected row count from the returned data array.
  const { data, error } = await query.select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const archivedCount = data?.length ?? 0;

  // Audit trail (best-effort). Batch operations have no single lead, so lead_id
  // is null. Uses the service-role client so logging never trips RLS.
  if (archivedCount > 0) {
    const summary = `Archived ${archivedCount} leads (batch: ${batchId}, reason: ${reason})`;

    // activities.type is constrained by activities_type_check; "note_added" is not
    // an allowed value, so we use "note".
    const { error: activityErr } = await supabaseAdmin.from("activities").insert({
      lead_id: null,
      type: "note",
      content: summary,
      user_id: user.id,
    });
    if (activityErr) console.error("[leads/archive] activities insert failed:", activityErr.message);

    const { error: eventErr } = await supabaseAdmin.from("business_events").insert({
      lead_id: null,
      event_type: "leads_archived",
      description: summary,
      event_data: { batch_id: batchId, count: archivedCount, archive_reason: reason },
      user_id: user.id,
    });
    if (eventErr) console.error("[leads/archive] business_events insert failed:", eventErr.message);
  }

  return NextResponse.json({
    archived_count: archivedCount,
    archive_batch_id: batchId,
  });
}

// GET /api/leads/archive?batch_id=xxx — Lookup archived leads by batch
export async function GET(request: NextRequest) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Role check — batch archive lookups are boss/admin only
  const forbidden = await requireBoss(supabase, user.id);
  if (forbidden) return forbidden;

  const batchId = request.nextUrl.searchParams.get("batch_id");
  if (!batchId) return NextResponse.json({ error: "batch_id required" }, { status: 400 });

  const { data, error } = await supabase
    .from("leads")
    .select("id, customer_name, phone, archived_at, archive_reason")
    .eq("archive_batch_id", batchId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ leads: data, count: data.length });
}
