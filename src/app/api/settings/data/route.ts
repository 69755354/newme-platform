// RBAC: user (authenticated)
import { NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"
import { getCached, setCache } from "@/lib/api-cache"
import { filterLeadTransferCandidateQuery } from "@/lib/lead-transfer-candidates.mjs"

export async function GET(request: Request) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader)

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single()

  if (profileError || !profile) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const role = profile.role
  const userId = user.id

  const { searchParams } = new URL(request.url)
  const period = searchParams.get("period") || ""

  const cacheKey = `settings:data:${role}:${userId}:${period}`
  const cached = getCached(cacheKey)
  if (cached) return NextResponse.json(cached)

  const kpiPromise = period
    ? supabase.from("kpi_targets").select("*, profiles(full_name)").eq("period", period)
    : Promise.resolve({ data: [], error: null })

  const profilesQuery = supabase
    .from("profiles")
    .select("id,email,full_name,role,is_active")
  const eligibleProfilesQuery = filterLeadTransferCandidateQuery(
    profilesQuery as never
  ) as typeof profilesQuery

  const [leadsResult, profilesResult, kpiResult] = await Promise.all([
    supabase
      .from("leads")
      .select("id,customer_name,phone,stage,final_status,assigned_to,owner,sales_manager,location,source,quotation_value")
      .order("updated_at", { ascending: false })
      .limit(1000),
    eligibleProfilesQuery,
    kpiPromise,
  ])

  const responseData = {
    leads: (leadsResult.data ?? []) as any[],
    profiles: (profilesResult.data ?? []) as any[],
    kpiTargets: (kpiResult.data ?? []) as any[],
  }

  setCache(cacheKey, responseData, 30)
  return NextResponse.json(responseData)
}
