import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/activities
 * Server-side activities fetch (bypasses RLS via service role).
 * Query params: lead_id (optional), limit (default 30)
 */
export async function GET(request: NextRequest) {
  // Auth check — must be authenticated
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const leadId = searchParams.get("lead_id");
  const limit = parseInt(searchParams.get("limit") || "30", 10);

  let query = supabase
    .from("activities")
    .select("id,lead_id,type,content,created_at,user_id,metadata")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (leadId) {
    query = query.eq("lead_id", leadId);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
