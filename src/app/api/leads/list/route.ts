// RBAC: authenticated organization member, or audited platform support session.
import { NextResponse } from "next/server";
import type { Database } from "@/types/database";
import {
  filterLeadTransferCandidateQuery,
  getVisibleLeadOwnerIds,
} from "@/lib/lead-transfer-candidates.mjs";
import {
  LeadOrganizationAccessError,
  resolveLeadOrganizationAccess,
} from "@/lib/lead-organization-access";
import { RequestAuthError } from "@/lib/request-auth-context";
import { supabaseAdmin } from "@/lib/supabase-admin";

type LeadListRow = Pick<
  Database["public"]["Tables"]["leads"]["Row"],
  "id" | "customer_name" | "phone" | "source" | "stage" | "final_status"
  | "quotation_value" | "location" | "property_type" | "project_type"
  | "project_status" | "property_size_sqm" | "ai_quality" | "lead_status"
  | "assigned_to" | "win_probability" | "last_contact_date"
  | "next_followup_date" | "next_action" | "followup_count" | "created_at"
  | "updated_at" | "recovery_candidate" | "transfer_candidate"
  | "sales_manager_review" | "hold_since" | "lost_reason"
  | "decision_maker" | "decision_date" | "competitor" | "campaign_name"
  | "source_platform" | "quality" | "poor_reason"
>;
type SalesUserRow = Pick<
  Database["public"]["Tables"]["profiles"]["Row"],
  "id" | "email" | "role" | "full_name" | "is_active"
>;
type OwnerProfileRow = Pick<
  Database["public"]["Tables"]["profiles"]["Row"],
  "id" | "full_name"
>;

export async function GET(request: Request) {
  let access;
  try {
    access = await resolveLeadOrganizationAccess(
      request,
      "lead:read",
      "lead_list",
      null,
    );
  } catch (error) {
    if (error instanceof LeadOrganizationAccessError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { error: "lead_organization_access_unavailable" },
      { status: 503 },
    );
  }

  const supabase = access.client;
  const user = access.context.user;
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const role = access.context.role;
  const userId = user.id;
  const search = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const safeSearch = search.replace(/[%_,().]/g, "").slice(0, 100);

  let leadsQuery = supabase
    .from("leads")
    .select(
      "id,customer_name,phone,source,stage,final_status,quotation_value,location,property_type,project_type,project_status,property_size_sqm,ai_quality,lead_status,assigned_to,win_probability,last_contact_date,next_followup_date,next_action,followup_count,created_at,updated_at,recovery_candidate,transfer_candidate,sales_manager_review,hold_since,lost_reason,decision_maker,decision_date,competitor,campaign_name,source_platform,quality,poor_reason",
    )
    .eq("organization_id", access.organizationId);
  if (safeSearch) {
    leadsQuery = leadsQuery.or(
      `customer_name.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%,phone.ilike.%${safeSearch}%`,
    );
  }
  if (role === "sales") {
    leadsQuery = leadsQuery.eq("assigned_to", userId);
  }
  const leadsPromise = leadsQuery
    .order("updated_at", { ascending: false })
    .limit(500);

  let salesUsersPromise;
  if (access.supportSessionId) {
    salesUsersPromise = Promise.resolve({
      data: [] as SalesUserRow[],
      error: null,
    });
  } else {
    const { data: organizationMemberships, error: membershipError } =
      await supabaseAdmin
        .from("memberships")
        .select("user_id")
        .eq("organization_id", access.organizationId)
        .eq("status", "active");
    if (membershipError) {
      return NextResponse.json(
        { error: "organization_memberships_fetch_failed" },
        { status: 503 },
      );
    }

    const organizationMemberUserIds = [
      ...new Set((organizationMemberships ?? []).map(({ user_id }) => user_id)),
    ];
    if (organizationMemberUserIds.length === 0) {
      salesUsersPromise = Promise.resolve({
        data: [] as SalesUserRow[],
        error: null,
      });
    } else {
      const candidateQuery = supabase
        .from("profiles")
        .select("id,email,role,full_name,is_active")
        .in("id", organizationMemberUserIds);
      salesUsersPromise = filterLeadTransferCandidateQuery(
        candidateQuery as never,
      ) as typeof candidateQuery;
    }
  }

  const [
    { data: leads, error: leadsError },
    { data: salesUsers, error: salesUsersError },
  ] = await Promise.all([leadsPromise, salesUsersPromise]);

  if (leadsError) {
    return NextResponse.json({ error: "leads_fetch_failed" }, { status: 503 });
  }
  if (salesUsersError) {
    return NextResponse.json(
      { error: "lead_transfer_candidates_fetch_failed" },
      { status: 503 },
    );
  }

  const ownerIds = getVisibleLeadOwnerIds(leads || []);
  let ownerProfiles: OwnerProfileRow[] = [];
  if (ownerIds.length > 0) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id,full_name")
      .in("id", ownerIds);
    if (error) {
      return NextResponse.json(
        { error: "lead_owner_profiles_fetch_failed" },
        { status: 503 },
      );
    }
    ownerProfiles = data ?? [];
  }

  return NextResponse.json({
    userId,
    role,
    organizationId: access.organizationId,
    leads: (leads ?? []) as LeadListRow[],
    salesUsers: (salesUsers ?? []) as SalesUserRow[],
    ownerProfiles,
  });
}
