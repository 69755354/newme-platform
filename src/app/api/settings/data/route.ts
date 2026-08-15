// RBAC: user (authenticated)
import { NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"
import { applyPrivateNoStore } from "@/lib/request-auth-context"
import { filterLeadTransferCandidateQuery } from "@/lib/lead-transfer-candidates.mjs"

/**
 * GET /api/settings/data — the KPI targets editor's data, plus the lead/owner lists.
 *
 * Round-4 finding R5. This is the read the KPI editor loads before it saves, and it
 * was held in src/lib/api-cache.ts for 30 seconds under
 * `settings:data:${role}:${userId}:${period}`, which nothing can evict.
 *
 * That is worse here than a stale figure. replace_kpi_targets() takes the period's
 * advisory lock and replaces the whole period from the submitted rows, carrying
 * forward the actual_amount that confirm_payment() and void_payment() maintain (B7,
 * R3). An editor that loaded a 30-second-old snapshot of the period and then saved it
 * is submitting a set assembled from figures that have since moved — and the operator
 * has no way to see that, because a re-load inside the window returns the same
 * snapshot. So this read is force-dynamic and no-store; the routine's lock decides
 * the outcome, and the form starts from what the routine will see.
 */
export const dynamic = "force-dynamic"

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

  // The profile lookup above is the authentication check — it must succeed for the
  // request to proceed. The role and the caller id were read only to compose the
  // cache key; the rows this route returns are scoped by RLS, not here.

  const { searchParams } = new URL(request.url)
  const period = searchParams.get("period") || ""

  const kpiPromise = period
    ? supabase
        .from("kpi_targets")
        .select("*, profiles!kpi_targets_assigned_to_fkey(full_name)")
        .eq("period", period)
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
      // R6 · updated_at is the compare-and-set token the assignment actions send
      // back to reassign_lead_atomic(). Without it on this read the screen has
      // nothing to compare against and the routine's check cannot fire.
      .select("id,customer_name,phone,stage,final_status,assigned_to,owner,sales_manager,location,source,quotation_value,updated_at")
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

  return applyPrivateNoStore(NextResponse.json(responseData))
}
