import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createClient } from "@/lib/supabase";

export async function GET(request: NextRequest) {
  const supabase = createClient();
  const authHeader = request.headers.get("authorization");
  const { data: { user } } = authHeader?.startsWith("Bearer ")
    ? await supabase.auth.getUser(authHeader.slice(7))
    : await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Query current user's role from profiles
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const role = profile.role;
  const isAdmin = role === "admin" || role === "boss";

  const { searchParams } = new URL(request.url);
  const leadId = searchParams.get("lead_id");
  const limit = parseInt(searchParams.get("limit") || "30", 10);

  let query = supabaseAdmin
    .from("activities")
    .select("id,lead_id,type,content,created_at,user_id,metadata")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (isAdmin) {
    // Admin/boss: keep existing behavior (read all activities)
    if (leadId) {
      query = query.eq("lead_id", leadId);
    }
  } else {
    // Non-admin: fetch the leads assigned to the current user
    const { data: assignedLeads, error: leadsError } = await supabaseAdmin
      .from("leads")
      .select("id")
      .eq("assigned_to", user.id);

    if (leadsError) {
      return NextResponse.json({ error: leadsError.message }, { status: 500 });
    }

    const assignedLeadIds = (assignedLeads ?? []).map(
      (lead: { id: string }) => lead.id
    );

    if (leadId) {
      // Validate that the requested lead belongs to the current user
      if (!assignedLeadIds.includes(leadId)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      query = query.eq("lead_id", leadId);
    } else {
      // Restrict to the user's assigned leads only
      if (assignedLeadIds.length === 0) {
        return NextResponse.json([]);
      }
      query = query.in("lead_id", assignedLeadIds);
    }
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
