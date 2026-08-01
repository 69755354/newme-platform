// RBAC: user (authenticated)
import { NextResponse } from "next/server"
import { getCached, setCache } from "@/lib/api-cache"
import { filterLeadTransferCandidateQuery } from "@/lib/lead-transfer-candidates.mjs"
import {
  LeadOrganizationAccessError,
  resolveLeadOrganizationAccess,
} from "@/lib/lead-organization-access"
import { activeOrganizationMemberIds } from "@/lib/organization-member-admin"
import { RequestAuthError } from "@/lib/request-auth-context"

export async function GET(request: Request) {
  let access
  try {
    access = await resolveLeadOrganizationAccess(
      request,
      "lead:read",
      "settings_data",
      null,
    )
  } catch (error) {
    if (error instanceof LeadOrganizationAccessError) {
      return NextResponse.json({ error: error.code }, { status: error.status })
    }
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status })
    }
    return NextResponse.json(
      { error: "settings_organization_access_unavailable" },
      { status: 503 },
    )
  }
  if (access.supportSessionId) {
    return NextResponse.json(
      { error: "support_settings_not_permitted" },
      { status: 403 },
    )
  }

  const supabase = access.client
  const role = access.context.role
  const userId = access.context.user.id
  const organizationId = access.organizationId
  let memberIds: string[]
  try {
    memberIds = await activeOrganizationMemberIds(organizationId)
  } catch {
    return NextResponse.json(
      { error: "organization_memberships_fetch_failed" },
      { status: 503 },
    )
  }

  const { searchParams } = new URL(request.url)
  const period = searchParams.get("period") || ""

  const cacheKey = `settings:data:${organizationId}:${role}:${userId}:${period}`
  const cached = getCached(cacheKey)
  if (cached) return NextResponse.json(cached)

  const kpiPromise = period && memberIds.length > 0
    ? supabase
        .from("kpi_targets")
        .select("*, profiles(full_name)")
        .eq("period", period)
        .in("assigned_to", memberIds)
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
      .eq("organization_id", organizationId)
      .order("updated_at", { ascending: false })
      .limit(1000),
    memberIds.length > 0
      ? eligibleProfilesQuery.in("id", memberIds)
      : Promise.resolve({ data: [], error: null }),
    kpiPromise,
  ])

  if (leadsResult.error || profilesResult.error || kpiResult.error) {
    return NextResponse.json(
      { error: "settings_data_fetch_failed" },
      { status: 503 },
    )
  }

  const responseData = {
    leads: leadsResult.data ?? [],
    profiles: profilesResult.data ?? [],
    kpiTargets: kpiResult.data ?? [],
  }

  setCache(cacheKey, responseData, 30)
  return NextResponse.json(responseData)
}
