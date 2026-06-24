// GET /api/dashboard/team-ownership — Team Lead Ownership stats (all roles with data)
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Get all relevant users
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .in("role", ["admin", "sales", "boss", "operator"])
    .eq("is_active", true);

  if (!profiles) return NextResponse.json({ users: [] });

  // For each user, count leads
  const results = await Promise.all(
    profiles.map(async (p) => {
      const base = supabase.from("leads").select("id, final_status, stage, archived");

      // assigned
      const { count: assigned } = await base.eq("assigned_to", p.id).is("archived", null);
      // created
      const { count: created } = await base.eq("created_by", p.id).is("archived", null);
      // active (not won/lost)
      const { count: active } = await base
        .eq("assigned_to", p.id)
        .is("archived", null)
        .is("final_status", null)
        .not("stage", "in", "(won,lost)");
      // won
      const { count: won } = await base.eq("assigned_to", p.id).or("final_status.eq.won,stage.eq.won");
      // lost
      const { count: lost } = await base.eq("assigned_to", p.id).or("final_status.eq.lost,stage.eq.lost");

      return {
        user_id: p.id,
        full_name: p.full_name,
        role: p.role,
        assigned_leads: assigned || 0,
        created_leads: created || 0,
        active_leads: active || 0,
        won_leads: won || 0,
        lost_leads: lost || 0,
      };
    })
  );

  // Filter: only users with any data
  const filtered = results.filter(
    (r) => r.assigned_leads > 0 || r.created_leads > 0
  );

  return NextResponse.json({ users: filtered });
}
