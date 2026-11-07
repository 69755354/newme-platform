// RBAC: user (authenticated)
import { createServerSupabase } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { fetchCountedLeads } from "@/lib/fetch-all-rows.mjs";
import { ADS_ATTRIBUTION_COLUMNS } from "@/lib/lead-metrics.mjs";

export async function GET(request: Request) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "sales";
  if (role === "sales") {
    return NextResponse.json({ role, leads: [] });
  }

  // Every counted (non-archived) lead, paged - this used to stop at the 500 most
  // recent rows without saying so - and only the columns the attribution tables
  // group and count by. /settings/ads reads the same rows the same way.
  const { data: leads, error } = await fetchCountedLeads(supabase, ADS_ATTRIBUTION_COLUMNS);

  if (error) {
    console.error("ads leads fetch failed:", error);
    return NextResponse.json({ error: "Failed to load leads" }, { status: 500 });
  }

  return NextResponse.json({ role, leads });
}
