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

  // For each user, count leads. Use a FRESH builder per metric — PostgrestFilterBuilder
  // mutates in place, so reusing one would leak filters across queries. head:true + exact
  // count is required so the query returns a count instead of null.
  const results = await Promise.all(
    profiles.map(async (p) => {
      // assigned
      const { count: assigned } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("assigned_to", p.id)
        .eq("archived", false);
      // active (assigned, not archived, final_status IS NULL)
      const { count: active } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("assigned_to", p.id)
        .eq("archived", false)
        .is("final_status", null);
      // won
      const { count: won } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("assigned_to", p.id)
        .eq("archived", false)
        .or("final_status.eq.won,stage.eq.won");
      // lost
      const { count: lost } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("assigned_to", p.id)
        .eq("archived", false)
        .or("final_status.eq.lost,stage.eq.lost");
      // imported (leads this person imported via Excel)
      const { count: created } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("imported_by", p.id);

      return {
        user_id: p.id,
        full_name: p.full_name,
        role: p.role,
        assigned_leads: assigned || 0,
        active_leads: active || 0,
        won_leads: won || 0,
        lost_leads: lost || 0,
        imported_leads: created || 0,
      };
    })
  );

  // Filter: users with any leads (assigned or created/imported)
  const filtered = results.filter((r) => r.assigned_leads > 0 || r.imported_leads > 0);

  return NextResponse.json({ users: filtered });
}
