// RBAC: user (boss, admin)
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
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
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
  if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
    return NextResponse.json(
      { error: "lead_ids required; preview an owner and explicitly approve the returned IDs" },
      { status: 400 },
    );
  }
  const approvedLeadIds = [...new Set(
    lead_ids.filter((id: unknown): id is string => typeof id === "string" && id.length > 0),
  )];
  if (approvedLeadIds.length !== lead_ids.length || approvedLeadIds.length > 500) {
    return NextResponse.json({ error: "lead_ids must contain 1-500 unique IDs" }, { status: 400 });
  }

  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const reason = archive_reason || "Mohamed old leads cleanup";

  let query = supabase.from("leads").update({
    archived: true,
    archived_at: now,
    archive_batch_id: batchId,
    archive_reason: reason,
  });

  // Archive only the immutable ID set approved from preview. Never resolve a
  // person by display name and never silently broaden the selection.
  query = query.in("id", approvedLeadIds).eq("archived", false);

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
    requested_count: approvedLeadIds.length,
    archived_count: archivedCount,
    skipped_count: approvedLeadIds.length - archivedCount,
    archive_batch_id: batchId,
  });
}

// GET /api/leads/archive?owner_id=xxx — Preview an immutable archive selection
// GET /api/leads/archive?batch_id=xxx — Lookup a completed archive batch
export async function GET(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const forbidden = await requireBoss(supabase, user.id);
  if (forbidden) return forbidden;

  const batchId = request.nextUrl.searchParams.get("batch_id");
  if (batchId) {
    const { data, error } = await supabase
      .from("leads")
      .select("id, customer_name, phone, assigned_to, archived_at, archive_reason")
      .eq("archive_batch_id", batchId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ mode: "batch", batch_id: batchId, leads: data, count: data.length });
  }

  const ownerId = request.nextUrl.searchParams.get("owner_id");
  if (!ownerId) {
    return NextResponse.json({ error: "owner_id or batch_id required" }, { status: 400 });
  }
  const { data: owner, error: ownerError } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .eq("id", ownerId)
    .single();
  if (ownerError || !owner) {
    return NextResponse.json({ error: "Owner profile not found" }, { status: 404 });
  }

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, customer_name, phone, assigned_to, stage, created_at")
    .eq("assigned_to", owner.id)
    .eq("archived", false)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    mode: "preview",
    owner: { id: owner.id, full_name: owner.full_name, role: owner.role },
    lead_ids: leads.map((lead) => lead.id),
    leads,
    count: leads.length,
    truncated: leads.length === 500,
  });
}

// DELETE /api/leads/archive?batch_id=xxx — Roll back one completed batch
export async function DELETE(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const forbidden = await requireBoss(supabase, user.id);
  if (forbidden) return forbidden;

  const batchId = request.nextUrl.searchParams.get("batch_id");
  if (!batchId) return NextResponse.json({ error: "batch_id required" }, { status: 400 });

  const { data, error } = await supabase
    .from("leads")
    .update({
      archived: false,
      archived_at: null,
      archive_batch_id: null,
      archive_reason: null,
    })
    .eq("archive_batch_id", batchId)
    .eq("archived", true)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const restoredCount = data?.length ?? 0;
  if (restoredCount > 0) {
    const summary = `Restored ${restoredCount} archived leads (batch: ${batchId})`;
    const { error: activityError } = await supabaseAdmin.from("activities").insert({
      lead_id: null,
      type: "note",
      content: summary,
      user_id: user.id,
    });
    if (activityError) {
      console.error("[leads/archive] rollback activity insert failed:", activityError.message);
    }
  }

  return NextResponse.json({ archive_batch_id: batchId, restored_count: restoredCount });
}
