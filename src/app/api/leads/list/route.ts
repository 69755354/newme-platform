// RBAC: user (authenticated)
// GET /api/leads/list — Aggregated leads list data
// Server-side auth.getUser() → profile role → leads (500 max) → profile data
import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import type { Database } from "@/types/database";

type LeadListRow = Pick<Database["public"]["Tables"]["leads"]["Row"], "id" | "customer_name" | "phone" | "source" | "stage" | "final_status" | "quotation_value" | "location" | "property_type" | "project_type" | "project_status" | "property_size_sqm" | "ai_quality" | "lead_status" | "assigned_to" | "win_probability" | "last_contact_date" | "next_followup_date" | "next_action" | "followup_count" | "created_at" | "updated_at" | "recovery_candidate" | "transfer_candidate" | "sales_manager_review" | "hold_since" | "lost_reason" | "decision_maker" | "decision_date" | "competitor" | "campaign_name" | "source_platform" | "quality" | "poor_reason">;
type SalesUserRow = Pick<Database["public"]["Tables"]["profiles"]["Row"], "id" | "email" | "role" | "full_name" | "is_active">;
type OwnerProfileRow = Pick<Database["public"]["Tables"]["profiles"]["Row"], "id" | "full_name">;
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
  let leadsQuery = supabase.from("leads").select(
    "id,customer_name,phone,source,stage,final_status,quotation_value,location,property_type,project_type,project_status,property_size_sqm,ai_quality,lead_status,assigned_to,win_probability,last_contact_date,next_followup_date,next_action,followup_count,created_at,updated_at,recovery_candidate,transfer_candidate,sales_manager_review,hold_since,lost_reason,decision_maker,decision_date,competitor,campaign_name,source_platform,quality,poor_reason"
  );
  if (role === "sales") {
    leadsQuery = leadsQuery.eq("assigned_to", userId);
  }
  const leadsPromise = leadsQuery.order("updated_at", { ascending: false }).limit(500);

  const candidateQuery = supabase
    .from("profiles")
    .select("id,email,role,full_name,is_active");
  const salesUsersPromise = filterLeadTransferCandidateQuery(
    candidateQuery as never
  ) as typeof candidateQuery;
  const [
    { data: leads, error: leadsErr },
    { data: salesUsers, error: salesErr },
  ] = await Promise.all([leadsPromise, salesUsersPromise]);

  if (leadsErr) console.error("leads fetch failed:", leadsErr);
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
    salesUsers: visibleSalesUsers,
    ownerProfiles,
  };


  return NextResponse.json(result);
}
