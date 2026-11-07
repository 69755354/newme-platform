// RBAC: user (authenticated)
// GET /api/leads/list — Aggregated leads list data
// Server-side auth.getUser() → profile role → every visible lead (paged, exact total; S3 #7) → profile data
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import type { Database } from "@/types/database";

type LeadListRow = Pick<Database["public"]["Tables"]["leads"]["Row"], "id" | "customer_name" | "phone" | "source" | "stage" | "final_status" | "quotation_value" | "location" | "property_type" | "project_type" | "project_status" | "property_size_sqm" | "ai_quality" | "lead_status" | "assigned_to" | "win_probability" | "last_contact_date" | "next_followup_date" | "next_action" | "followup_count" | "created_at" | "updated_at" | "recovery_candidate" | "transfer_candidate" | "sales_manager_review" | "hold_since" | "lost_reason" | "decision_maker" | "decision_date" | "competitor" | "campaign_name" | "source_platform" | "quality" | "poor_reason">;
type SalesUserRow = Pick<Database["public"]["Tables"]["profiles"]["Row"], "id" | "email" | "role" | "full_name" | "is_active">;
type OwnerProfileRow = Pick<Database["public"]["Tables"]["profiles"]["Row"], "id" | "full_name">;
import { fetchAllRows, LIST_MAX_ROWS } from "@/lib/fetch-all-rows.mjs";
import {
  filterLeadTransferCandidateQuery,
  getVisibleLeadOwnerIds,
} from "@/lib/lead-transfer-candidates.mjs";

export async function GET(request: Request) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);

  // 1. Auth
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Profile → role
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 403 });
  }

  if (!profile.role) {
    return NextResponse.json({ error: "Profile role not found" }, { status: 403 });
  }

  const role = profile.role;
  const userId: string = user.id;

  // ── Parallel batch: leads + transfer candidates + owner directory ──
  const LEAD_LIST_COLUMNS =
    "id,customer_name,phone,source,stage,final_status,quotation_value,location,property_type,project_type,project_status,property_size_sqm,ai_quality,lead_status,assigned_to,win_probability,last_contact_date,next_followup_date,next_action,followup_count,created_at,updated_at,recovery_candidate,transfer_candidate,sales_manager_review,hold_since,lost_reason,decision_maker,decision_date,competitor,campaign_name,source_platform,quality,poor_reason";
  // S3 #7: read every lead the caller may see (it used to stop at 500 without
  // saying so). Ordered with a tiebreaker so pages never overlap or skip.
  const leadsPromise = fetchAllRows((from, to, withCount) => {
    // Archived leads are out of the working set everywhere else (dashboard, analytics,
    // workbench); a batch restore goes through /api/leads/archive, not through this list.
    let leadsQuery = supabase.from("leads").select(LEAD_LIST_COLUMNS, withCount ? { count: "exact" } : undefined).eq("archived", false);
    if (role === "sales") {
      leadsQuery = leadsQuery.eq("assigned_to", userId);
    }
    return leadsQuery.order("updated_at", { ascending: false }).order("id", { ascending: true }).range(from, to);
  }, { maxRows: LIST_MAX_ROWS }).then((result) => ({ data: result.data as LeadListRow[], error: result.error, total: result.total, truncated: result.truncated }));

  const candidateQuery = supabase
    .from("profiles")
    .select("id,email,role,full_name,is_active");
  const salesUsersPromise = filterLeadTransferCandidateQuery(
    candidateQuery as never
  ) as typeof candidateQuery;
  const [
    { data: leads, error: leadsErr, total: leadsTotal, truncated: leadsTruncated },
    { data: salesUsers, error: salesErr },
  ] = await Promise.all([leadsPromise, salesUsersPromise]);

  if (leadsErr) {
    // A failed read must never look like "no leads".
    console.error("leads fetch failed:", leadsErr);
    return NextResponse.json({ error: "Failed to load leads" }, { status: 500 });
  }
  if (salesErr) console.error("salesUsers fetch failed:", salesErr);

  // Historical names are only needed for Cases the caller can already see.
  // Do not return an organization-wide personnel directory to a sales caller.
  const ownerIds = getVisibleLeadOwnerIds(leads || []);
  let ownerProfiles: OwnerProfileRow[] = [];
  if (ownerIds.length > 0) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id,full_name")
      .in("id", ownerIds);
    if (error) console.error("ownerProfiles fetch failed:", error);
    ownerProfiles = data || [];
  }

  const visibleLeads: LeadListRow[] = leads ?? [];
  const visibleSalesUsers: SalesUserRow[] = salesUsers ?? [];
  const result = {
    userId,
    role,
    leads: visibleLeads,
    total: leadsTotal,
    truncated: leadsTruncated,
    salesUsers: visibleSalesUsers,
    ownerProfiles,
  };


  return NextResponse.json(result);
}
