// GET /api/alerts — Active lead alerts with 30s cache
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { getCached, setCache } from "@/lib/api-cache";

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

  const isManagement = ["admin", "boss", "operator"].includes(profile.role);
  const cacheKey = `alerts:${isManagement ? profile.role : "sales"}:${isManagement ? "all" : user.id}`;

  // ── Cache hit ──
  const cached = getCached<{ alerts: unknown[]; summary: unknown }>(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  const { searchParams } = new URL(request.url);
  const severity = searchParams.get("severity");
  const alertType = searchParams.get("type");

  // Field whitelist — only columns actually used by AlertPanel
  let query = supabase
    .from("lead_alerts")
    .select("id,customer_name,alert_type,alert_message,severity,assigned_to")
    .not("alert_type", "is", null)
    .order("severity", { ascending: true })
    .limit(30);

  if (severity) {
    query = query.eq("severity", severity);
  }
  if (alertType) {
    query = query.eq("alert_type", alertType);
  }

  if (!isManagement) {
    query = query.eq("assigned_to", user.id);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[alerts] Query error:", error);
    return NextResponse.json({ error: "Failed to fetch alerts" }, { status: 500 });
  }

  const summary = {
    total: data?.length ?? 0,
    red: data?.filter((a: any) => a.severity === "red").length ?? 0,
    yellow: data?.filter((a: any) => a.severity === "yellow").length ?? 0,
    byType: {} as Record<string, number>,
  };
  data?.forEach((a: any) => {
    summary.byType[a.alert_type] = (summary.byType[a.alert_type] || 0) + 1;
  });

  const result = { alerts: data, summary };

  // ── Cache write (30s) ──
  setCache(cacheKey, result, 30);

  return NextResponse.json(result);
}
