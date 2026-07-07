import { NextResponse } from "next/server";
import { createServerSupabase } from "@/models/supabase-server";

/**
 * GET /api/leads/follow-up-overdue
 * Returns leads where next_followup_date <= today AND stage is active (not won/lost).
 * Used by the notification cron and the "Needs Follow-up" filter.
 */
export async function GET() {
  const supabase = await createServerSupabase();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Verify user role
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 403 });

  const today = new Date().toISOString().split("T")[0];

  let query = supabase
    .from("leads")
    .select("*")
    .is("final_status", null)
    .lte("next_followup_date", today)
    .order("next_followup_date", { ascending: true });

  // Sales users only see their own leads
  if (profile.role === "sales") {
    query = query.eq("assigned_to", user.id);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[follow-up-overdue] Query error:", error);
    return NextResponse.json({ error: "Failed to fetch overdue follow-ups" }, { status: 500 });
  }

  return NextResponse.json({ leads: data, count: data?.length || 0, today });
}
