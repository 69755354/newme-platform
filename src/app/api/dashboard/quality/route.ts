// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

type CountResult = {
  count: number | null;
  error: { message: string } | null;
};

const asCountQuery = (query: unknown) => query as PromiseLike<CountResult>;

export async function GET(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const periodParam = request.nextUrl.searchParams.get("period");
  const periodMatch = periodParam?.match(PERIOD_PATTERN) ?? null;

  if (periodParam !== null && !periodMatch) {
    return NextResponse.json(
      { error: "Invalid period. Expected YYYY-MM." },
      { status: 400 },
    );
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "sales";
  const isCEO = role === "admin" || role === "boss" || role === "operator";
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const period = periodMatch
    ? {
        start: new Date(
          Date.UTC(Number(periodMatch[1]), Number(periodMatch[2]) - 1, 1),
        ).toISOString(),
        end: new Date(
          Date.UTC(Number(periodMatch[1]), Number(periodMatch[2]), 1),
        ).toISOString(),
      }
    : null;

  let totalQuery = supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("archived", false);
  let contactedQuery = supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("archived", false)
    .or("followup_count.gt.0,last_contact_date.not.is.null");
  let firstContactQuery = supabase
    .from("lead_milestones")
    .select("lead_id,leads!inner(id)", { count: "exact", head: true })
    .eq("milestone_key", "first_contact")
    .not("completed_at", "is", null)
    .eq("leads.archived", false);
  let missingFirstContactQuery = supabase
    .from("leads")
    .select("id,lead_milestones!left(id)", { count: "exact", head: true })
    .eq("archived", false)
    .is("final_status", null)
    .eq("lead_milestones.milestone_key", "first_contact")
    .not("lead_milestones.completed_at", "is", null)
    .is("lead_milestones", null);
  let noAnswerQuery = supabase
    .from("follow_up_logs")
    .select("id,leads!inner(id)", { count: "exact", head: true })
    .eq("no_answer", true)
    .eq("leads.archived", false);
  let followUpMissingQuery = supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("archived", false)
    .is("final_status", null)
    .eq("followup_count", 0)
    .is("last_contact_date", null);
  let overdueFollowUpQuery = supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("archived", false)
    .is("final_status", null)
    .or(
      `next_followup_date.lt.${today},and(last_contact_date.is.null,created_at.lt.${twoDaysAgo})`,
    );

  const qualityQuery = (quality: "pending" | "good" | "normal") => {
    let query = supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("archived", false)
      .eq("quality", quality);
    if (!isCEO) query = query.eq("assigned_to", user.id);
    return query;
  };

  if (!isCEO) {
    totalQuery = totalQuery.eq("assigned_to", user.id);
    contactedQuery = contactedQuery.eq("assigned_to", user.id);
    firstContactQuery = firstContactQuery.eq("leads.assigned_to", user.id);
    missingFirstContactQuery = missingFirstContactQuery.eq("assigned_to", user.id);
    noAnswerQuery = noAnswerQuery.eq("leads.assigned_to", user.id);
    followUpMissingQuery = followUpMissingQuery.eq("assigned_to", user.id);
    overdueFollowUpQuery = overdueFollowUpQuery.eq("assigned_to", user.id);
  }

  if (period) {
    noAnswerQuery = noAnswerQuery
      .gte("created_at", period.start)
      .lt("created_at", period.end);
  }

  const results = await Promise.all([
    asCountQuery(totalQuery),
    asCountQuery(contactedQuery),
    asCountQuery(firstContactQuery),
    asCountQuery(missingFirstContactQuery),
    asCountQuery(noAnswerQuery),
    asCountQuery(followUpMissingQuery),
    asCountQuery(overdueFollowUpQuery),
    asCountQuery(qualityQuery("pending")),
    asCountQuery(qualityQuery("good")),
    asCountQuery(qualityQuery("normal")),
  ]);

  const queryError = results.find((result) => result.error)?.error;
  if (queryError) {
    console.error("Quality dashboard API error:", queryError.message);
    return NextResponse.json(
      { error: "Failed to fetch quality metrics" },
      { status: 500 },
    );
  }

  const counts = results.map((result) => result.count ?? 0);
  const [
    totalLeads,
    contactedLeads,
    firstContactDone,
    missingFirstContact,
    noAnswerCount,
    followUpMissing,
    overdueFollowUp,
    pending,
    good,
    normal,
  ] = counts;
  const totalJudged = good + normal;
  const qualityScore =
    totalJudged === 0
      ? 0
      : Math.round((good * 100 + normal * 50) / totalJudged);

  return NextResponse.json({
    isCEO,
    totalLeads,
    contactedLeads,
    firstContactDone,
    missingFirstContact,
    noAnswerCount,
    followUpMissing,
    overdueFollowUp,
    qualityBreakdown: { pending, good, normal },
    qualityScore,
    period,
  });
}

