// RBAC: user (authenticated)
// GET /api/dashboard/team-ownership — Team Lead Ownership stats (30s cache)
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { getCached, setCache } from "@/lib/api-cache.mjs";
import { fetchCountedLeads } from "@/lib/fetch-all-rows.mjs";
import { LEAD_METRIC_COLUMNS, summarizeLeads, type MetricLead } from "@/lib/lead-metrics.mjs";

export async function GET(request: Request) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Get requester's role for cache key
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = profile?.role || "unknown";
  const isManagement = ["admin", "boss", "operator"].includes(role);
  const cacheKey = `team-ownership:${role}:${isManagement ? "all" : user.id}`;

  // ── Cache hit ──
  const cached = getCached(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  // Sales callers receive only their own ownership row; management sees the team.
  let profilesQuery = supabase
    .from("profiles")
    .select("id, full_name, role")
    .in("role", ["admin", "sales", "boss", "operator"])
    .eq("is_active", true);
  if (!isManagement) profilesQuery = profilesQuery.eq("id", user.id);
  const { data: profiles } = await profilesQuery;

  if (!profiles) return NextResponse.json({ users: [] });

  // Per-user lead counts from one read of the counted (non-archived) leads and
  // the shared definitions in src/lib/lead-metrics.mjs - the same won / lost /
  // active figures as the dashboard leaderboard and every analytics panel.
  const leadsResult = await fetchCountedLeads(
    supabase,
    LEAD_METRIC_COLUMNS,
    { assignedTo: isManagement ? null : user.id },
  );
  if (leadsResult.error) {
    console.error("team-ownership leads fetch failed:", leadsResult.error);
    return NextResponse.json({ error: "Failed to load team ownership" }, { status: 500 });
  }
  const summary = summarizeLeads(leadsResult.data as MetricLead[]);

  const results = profiles.map((p) => {
    const mine = summary.byAssignee[p.id];
    return {
      user_id: p.id,
      full_name: p.full_name,
      role: p.role,
      assigned_leads: mine?.total ?? 0,
      active_leads: mine?.active ?? 0,
      won_leads: mine?.won ?? 0,
      lost_leads: mine?.lost ?? 0,
      imported_leads: mine?.imported ?? 0,
    };
  });

  // Filter: users with any leads (assigned or created/imported)
  const filtered = results.filter((r) => r.assigned_leads > 0 || r.imported_leads > 0);
  const result = { users: filtered };

  // ── Cache write (30s) ──
  setCache(cacheKey, result, 30);

  return NextResponse.json(result);
}
