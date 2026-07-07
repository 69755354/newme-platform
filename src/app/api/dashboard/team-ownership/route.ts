// GET /api/dashboard/team-ownership — Team Lead Ownership stats (30s cache)
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/models/supabase-server";
import { getCached, setCache } from "@/models/api-cache";

export async function GET() {
  const supabase = await createServerSupabase();
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

  // Get all relevant users
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .in("role", ["admin", "sales", "boss", "operator"])
    .eq("is_active", true);

  if (!profiles) return NextResponse.json({ users: [] });

  // Per-user lead counts — parallelized per-user (5 queries each via Promise.all)
  const results = await Promise.all(
    profiles.map(async (p) => {
      const [assigned, active, won, lost, created] = await Promise.all([
        supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("assigned_to", p.id)
          .eq("archived", false),
        supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("assigned_to", p.id)
          .eq("archived", false)
          .is("final_status", null),
        supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("assigned_to", p.id)
          .eq("archived", false)
          .or("final_status.eq.won,stage.eq.won"),
        supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("assigned_to", p.id)
          .eq("archived", false)
          .or("final_status.eq.lost,stage.eq.lost"),
        supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("imported_by", p.id),
      ]);

      return {
        user_id: p.id,
        full_name: p.full_name,
        role: p.role,
        assigned_leads: assigned.count || 0,
        active_leads: active.count || 0,
        won_leads: won.count || 0,
        lost_leads: lost.count || 0,
        imported_leads: created.count || 0,
      };
    })
  );

  // Filter: users with any leads (assigned or created/imported)
  const filtered = results.filter((r) => r.assigned_leads > 0 || r.imported_leads > 0);
  const result = { users: filtered };

  // ── Cache write (30s) ──
  setCache(cacheKey, result, 30);

  return NextResponse.json(result);
}
