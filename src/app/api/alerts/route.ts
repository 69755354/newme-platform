import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/alerts
 * Returns active alerts from the lead_alerts view.
 * Admin/boss: all alerts. Sales: only their assigned leads.
 * Query params: ?severity=red&type=overdue_followup
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 403 });

  const isManagement = ["admin", "boss"].includes(profile.role);
  const { searchParams } = new URL(request.url);
  const severity = searchParams.get("severity");
  const alertType = searchParams.get("type");

  // Build query on lead_alerts view — only return rows with active alerts
  // P-03: select("*") — lead_alerts 视图列少，暂保留
  let query = supabase
    .from("lead_alerts")
    .select("*")
    .not("alert_type", "is", null)
    .order("severity", { ascending: true })
    .order("days_since_contact", { ascending: false });

  if (severity) {
    query = query.eq("severity", severity);
  }
  if (alertType) {
    query = query.eq("alert_type", alertType);
  }

  // Sales users only see their own leads
  if (!isManagement) {
    query = query.eq("assigned_to", user.id);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[alerts] Query error:", error);
    return NextResponse.json({ error: "Failed to fetch alerts" }, { status: 500 });
  }

  // Aggregate summary
  const summary = {
    total: data?.length ?? 0,
    red: data?.filter((a) => a.severity === "red").length ?? 0,
    yellow: data?.filter((a) => a.severity === "yellow").length ?? 0,
    byType: {} as Record<string, number>,
  };
  data?.forEach((a) => {
    summary.byType[a.alert_type] = (summary.byType[a.alert_type] || 0) + 1;
  });

  return NextResponse.json({ alerts: data, summary });
}
