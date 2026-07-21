// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

/** POST /api/workflow/start-stage — mark a stage as in_progress, set deadline */
export async function POST(request: NextRequest) {
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { lead_id, stage_key } = await request.json();
    if (!lead_id || !stage_key) {
      return NextResponse.json({ error: "lead_id and stage_key required" }, { status: 400 });
    }

    // Permission check: user must be admin/boss OR assigned to this lead
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    const isAdminBoss = profile?.role === "admin" || profile?.role === "boss";

    if (!isAdminBoss) {
      const { data: lead } = await supabase
        .from("leads")
        .select("assigned_to")
        .eq("id", lead_id)
        .single();

      if (!lead || lead.assigned_to !== user.id) {
        return NextResponse.json({ error: "Forbidden: not assigned to this lead" }, { status: 403 });
      }
    }

    const now = new Date().toISOString();

    // Calculate deadline based on stage
    const deadlineHours: Record<string, number> = {
      basic_info: 24,
      requirements: 48,
      design_proposal: 24, // 24h follow-up timer
      contract: 48,
      decision: 72,
    };
    const hours = deadlineHours[stage_key] || 24;
    const deadline = new Date(Date.now() + hours * 3600 * 1000).toISOString();

    const { data, error } = await supabase
      .from("lead_workflow_stages")
      .update({
        status: "in_progress",
        started_at: now,
        deadline_at: deadline,
        updated_at: now,
      })
      .eq("lead_id", lead_id)
      .eq("stage_key", stage_key)
      .select()
      .single();

    if (error) {
      console.error("[Workflow] Start stage error:", error);
      return NextResponse.json({ error: "Failed to update stage" }, { status: 500 });
    }

    return NextResponse.json({ status: "ok", data });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** PUT /api/workflow/complete-stage — mark a stage as completed */
export async function PUT(request: NextRequest) {
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { lead_id, stage_key, notes } = await request.json();
    if (!lead_id || !stage_key) {
      return NextResponse.json({ error: "lead_id and stage_key required" }, { status: 400 });
    }

    // Permission check: user must be admin/boss OR assigned to this lead
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    const isAdminBoss = profile?.role === "admin" || profile?.role === "boss";

    if (!isAdminBoss) {
      const { data: lead } = await supabase
        .from("leads")
        .select("assigned_to")
        .eq("id", lead_id)
        .single();

      if (!lead || lead.assigned_to !== user.id) {
        return NextResponse.json({ error: "Forbidden: not assigned to this lead" }, { status: 403 });
      }
    }

    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("lead_workflow_stages")
      .update({
        status: "completed",
        completed_at: now,
        updated_at: now,
        notes: notes || null,
      })
      .eq("lead_id", lead_id)
      .eq("stage_key", stage_key)
      .select()
      .single();

    if (error) {
      console.error("[Workflow] Complete stage error:", error);
      return NextResponse.json({ error: "Failed to update stage" }, { status: 500 });
    }

    return NextResponse.json({ status: "ok", data });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
