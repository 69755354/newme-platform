// RBAC: user (admin, boss, operator)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

export interface WeeklyReviewRow {
  user_id: string;
  full_name: string | null;
  assigned_leads: number;
  contacted: number;
  pending_quality: number;
  quality_judged: number;
  stage_advanced: number;
  won: number;
  lost: number;
  overdue_tasks: number;
}

export interface WeeklyReviewLeadRow {
  id: string;
  customer_name: string | null;
  assigned_to: string | null;
  owner_name: string | null;
  stage: string | null;
  last_contact_date: string | null;
  contact_count: number;
  quality: string | null;
  last_note: string | null;
  next_follow_up_at: string | null;
  period_reasons: string[];
  overdue_count: number;
  stage_advance_count: number;
}

type ReviewRange = "today" | "this_week" | "last_week" | "this_month" | "custom";

export interface WeeklyReviewResponse {
  range: ReviewRange;
  period_start: string;
  period_end: string;
  l1: {
    new_leads: number;
    contacted_leads: number;
    quality_judged: number;
    stage_advanced: number;
    won: number;
    lost: number;
  };
  l2: WeeklyReviewRow[];
  l3_by_user: Record<string, WeeklyReviewLeadRow[]>;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;
const GST_OFFSET_MS = 4 * 3600 * 1000;

function joinedFullName(value: unknown): string | null {
  const profile = Array.isArray(value) ? value[0] : value;
  if (!profile || typeof profile !== "object" || !("full_name" in profile)) return null;
  return typeof profile.full_name === "string" ? profile.full_name : null;
}

function joinedAssignedTo(value: unknown): string | null {
  const lead = Array.isArray(value) ? value[0] : value;
  if (!lead || typeof lead !== "object" || !("assigned_to" in lead)) return null;
  return typeof lead.assigned_to === "string" ? lead.assigned_to : null;
}

function gstDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day) - GST_OFFSET_MS);
}

function parseGstDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = gstDate(year, month - 1, day);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function periodBounds(range: ReviewRange, customStart?: string | null, customEnd?: string | null): { start: Date; end: Date } | null {
  const now = new Date();
  const gst = new Date(now.getTime() + GST_OFFSET_MS);
  if (range === "today") {
    const start = gstDate(gst.getUTCFullYear(), gst.getUTCMonth(), gst.getUTCDate());
    return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
  }
  if (range === "this_week") {
    const dow = gst.getUTCDay();
    const mondayGst = new Date(gst);
    mondayGst.setUTCDate(gst.getUTCDate() - ((dow + 6) % 7));
    const start = gstDate(mondayGst.getUTCFullYear(), mondayGst.getUTCMonth(), mondayGst.getUTCDate());
    return { start, end: new Date(start.getTime() + WEEK_MS) };
  }
  if (range === "last_week") {
    const thisWeek = periodBounds("this_week");
    if (!thisWeek) return null;
    return { start: new Date(thisWeek.start.getTime() - WEEK_MS), end: thisWeek.start };
  }
  if (range === "this_month") {
    return {
      start: gstDate(gst.getUTCFullYear(), gst.getUTCMonth(), 1),
      end: gstDate(gst.getUTCFullYear(), gst.getUTCMonth() + 1, 1),
    };
  }
  const start = parseGstDate(customStart ?? null);
  const end = parseGstDate(customEnd ?? null);
  if (!start || !end || start > end) return null;
  return { start, end: new Date(end.getTime() + 24 * 3600 * 1000) };
}

export async function GET(req: NextRequest) {
  try {
    const bearerToken = req.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = req.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (!profile) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const role = profile.role as string;
    if (!["admin", "boss", "operator", "sales"].includes(role) && !["user", "salesperson"].includes(role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const isSalesScope = role === "sales" || role === "user" || role === "salesperson";

    const sp = new URL(req.url).searchParams;
    const rangeRaw = (sp.get("range") ?? "today").toLowerCase();
    const range: ReviewRange = ["today", "this_week", "last_week", "this_month", "custom"].includes(rangeRaw)
      ? rangeRaw as ReviewRange
      : "today";
    const bounds = periodBounds(range, sp.get("start"), sp.get("end"));
    if (!bounds) {
      return NextResponse.json({ error: "Invalid custom range" }, { status: 400 });
    }
    const { start, end } = bounds;
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    // L1: every aggregate is scoped in the database for a sales caller.
    const [
      { count: newLeadsCount },
      { data: contactedData },
      { data: qualityEvents },
      { count: stageAdvancedCount },
      { count: wonCount },
      { count: lostCount },
    ] = await Promise.all([
      (isSalesScope
        ? supabase.from("leads").select("id", { count: "exact", head: true })
          .eq("assigned_to", user.id)
        : supabase.from("leads").select("id", { count: "exact", head: true }))
        .gte("created_at", startIso).lt("created_at", endIso),
      (isSalesScope
        ? supabase.from("follow_up_logs").select("lead_id, leads!inner(assigned_to)")
          .eq("leads.assigned_to", user.id)
        : supabase.from("follow_up_logs").select("lead_id"))
        .gte("created_at", startIso).lt("created_at", endIso),
      (isSalesScope
        ? supabase.from("business_events").select("lead_id, leads!inner(assigned_to)")
          .eq("leads.assigned_to", user.id)
        : supabase.from("business_events").select("lead_id, leads!inner(assigned_to)"))
        .eq("event_type", "quality_checked")
        .gte("created_at", startIso).lt("created_at", endIso),
      (isSalesScope
        ? supabase.from("business_events").select("id, leads!inner(assigned_to)", { count: "exact", head: true })
          .eq("leads.assigned_to", user.id)
        : supabase.from("business_events").select("id", { count: "exact", head: true }))
        .eq("event_type", "stage_change")
        .gte("created_at", startIso).lt("created_at", endIso),
      (isSalesScope
        ? supabase.from("business_events").select("id, leads!inner(assigned_to)", { count: "exact", head: true })
          .eq("leads.assigned_to", user.id)
        : supabase.from("business_events").select("id", { count: "exact", head: true }))
        .eq("event_type", "stage_change").eq("event_data->>to", "won")
        .gte("created_at", startIso).lt("created_at", endIso),
      (isSalesScope
        ? supabase.from("business_events").select("id, leads!inner(assigned_to)", { count: "exact", head: true })
          .eq("leads.assigned_to", user.id)
        : supabase.from("business_events").select("id", { count: "exact", head: true }))
        .eq("event_type", "stage_change").eq("event_data->>to", "lost")
        .gte("created_at", startIso).lt("created_at", endIso),
    ]);

    const contactedDistinct = new Set((contactedData ?? []).map((r: any) => r.lead_id)).size;
    const qualityJudgedDistinct = new Set((qualityEvents ?? []).map((r) => r.lead_id)).size;

    // L2 per-sales rollup
    let profilesQuery = supabase.from("profiles").select("id, full_name, role");
    if (isSalesScope) profilesQuery = profilesQuery.eq("id", user.id);
    const { data: profilesAll } = await profilesQuery;
    const salesMap = new Map<string, string>();
    const roleMap = new Map<string, string>();
    for (const p of profilesAll ?? []) {
      salesMap.set(p.id, p.full_name ?? "");
      roleMap.set(p.id, (p as any).role as string);
    }

    let assignedLeadsQuery = supabase.from("leads").select("id, assigned_to")
      .gte("created_at", startIso).lt("created_at", endIso).not("assigned_to", "is", null);
    if (isSalesScope) assignedLeadsQuery = assignedLeadsQuery.eq("assigned_to", user.id);
    const { data: assignedLeads } = await assignedLeadsQuery;

    let contactedLogsQuery = supabase.from("follow_up_logs")
      .select("lead_id, leads!inner(assigned_to)")
      .gte("created_at", startIso).lt("created_at", endIso);
    if (isSalesScope) contactedLogsQuery = contactedLogsQuery.eq("leads.assigned_to", user.id);
    const { data: contactedLogs } = await contactedLogsQuery;

    let pendingQualityQuery = supabase.from("leads").select("id, assigned_to")
      .eq("quality", "pending").not("assigned_to", "is", null)
      .gte("created_at", startIso).lt("created_at", endIso);
    if (isSalesScope) pendingQualityQuery = pendingQualityQuery.eq("assigned_to", user.id);
    const { data: pendingQuality } = await pendingQualityQuery;

    let stageEventsQuery = supabase.from("business_events")
      .select("event_data, user_id, lead_id, leads!inner(assigned_to)")
      .eq("event_type", "stage_change")
      .gte("created_at", startIso).lt("created_at", endIso);
    if (isSalesScope) stageEventsQuery = stageEventsQuery.eq("leads.assigned_to", user.id);
    const { data: stageEvents } = await stageEventsQuery;

    const overdueEndIso = new Date(Math.min(end.getTime(), Date.now())).toISOString();
    let overdueTasksQuery = supabase.from("tasks")
      .select("lead_id, due_at, leads!inner(assigned_to)")
      .neq("status", "done").not("lead_id", "is", null)
      .gte("due_at", startIso).lt("due_at", overdueEndIso);
    if (isSalesScope) overdueTasksQuery = overdueTasksQuery.eq("leads.assigned_to", user.id);
    const { data: overdueTasks } = await overdueTasksQuery;

    // Attribute stage outcomes to the lead owner, not the user who happened to
    // perform the update (for example an admin assisting a salesperson).
    const stageLeadIds = [...new Set(
      (stageEvents ?? []).map((event: any) => event.lead_id as string | null).filter(Boolean),
    )] as string[];
    const { data: stageEventLeads } = stageLeadIds.length > 0
      ? await supabase.from("leads").select("id, assigned_to").in("id", stageLeadIds)
      : { data: [] };
    const stageOwnerByLead = new Map<string, string>();
    for (const lead of stageEventLeads ?? []) {
      if (lead.assigned_to) stageOwnerByLead.set(lead.id, lead.assigned_to);
    }

    const perUser = new Map<string, WeeklyReviewRow>();
    // Sales membership comes from profile roles, never hard-coded user IDs.
    // "user" is the legacy sales-representative role; keep explicit aliases for
    // newer environments and include boss because the existing report did.
    const SALES_ROLES = new Set(["user", "sales", "salesperson", "boss"]);
    const isSalesUser = (uid: string) => SALES_ROLES.has(roleMap.get(uid) ?? "");
    const ensure = (uid: string) => {
      if (!isSalesUser(uid)) return null;
      if (!perUser.has(uid)) {
        perUser.set(uid, {
          user_id: uid, full_name: salesMap.get(uid) ?? null,
          assigned_leads: 0, contacted: 0, pending_quality: 0, quality_judged: 0,
          stage_advanced: 0, won: 0, lost: 0, overdue_tasks: 0,
        });
      }
      return perUser.get(uid)!;
    };
    // Pre-init the active sales roster so zero-activity users remain visible.
    for (const uid of salesMap.keys()) ensure(uid);
    for (const r of assignedLeads ?? []) { const row = ensure(r.assigned_to); if (row) row.assigned_leads++; }
    const contactedByOwner = new Map<string, Set<string>>();
    for (const log of contactedLogs ?? []) {
      const owner = (log as any).leads?.assigned_to as string | null;
      if (!owner) continue;
      if (!contactedByOwner.has(owner)) contactedByOwner.set(owner, new Set());
      contactedByOwner.get(owner)!.add(log.lead_id);
    }
    for (const [uid, set] of contactedByOwner) { const row = ensure(uid); if (row) row.contacted = set.size; }
    const qualityByOwner = new Map<string, Set<string>>();
    for (const event of qualityEvents ?? []) {
      const owner = joinedAssignedTo(event.leads);
      const leadId = event.lead_id as string | null;
      if (!owner || !leadId) continue;
      if (!qualityByOwner.has(owner)) qualityByOwner.set(owner, new Set());
      qualityByOwner.get(owner)!.add(leadId);
    }
    for (const [uid, set] of qualityByOwner) { const row = ensure(uid); if (row) row.quality_judged = set.size; }
    for (const r of pendingQuality ?? []) { if (r.assigned_to) { const row = ensure(r.assigned_to); if (row) row.pending_quality++; } }
    for (const ev of stageEvents ?? []) {
      const owner = stageOwnerByLead.get((ev as any).lead_id as string);
      const to = (ev as any).event_data?.to;
      if (!owner) continue;
      const row = ensure(owner);
      if (!row) continue;
      row.stage_advanced++;
      if (to === "won") row.won++;
      else if (to === "lost") row.lost++;
    }
    const overdueByOwner = new Map<string, number>();
    for (const task of overdueTasks ?? []) {
      const owner = joinedAssignedTo(task.leads);
      if (owner) overdueByOwner.set(owner, (overdueByOwner.get(owner) ?? 0) + 1);
    }
    for (const [owner, count] of overdueByOwner) {
      const row = ensure(owner);
      if (row) row.overdue_tasks = count;
    }

    const l2 = Array.from(perUser.values())
      .filter(r => true) // Show all sales/boss even with 0 activity
      .sort((a, b) => b.stage_advanced - a.stage_advanced);

    // L3 is built from the same period facts as L2 so every non-zero metric
    // can be explained by the expanded Lead rows.
    const relevantLeadIds = new Set<string>();
    const reasonsByLead = new Map<string, Set<string>>();
    const addReason = (leadId: string | null | undefined, reason: string) => {
      if (!leadId) return;
      relevantLeadIds.add(leadId);
      if (!reasonsByLead.has(leadId)) reasonsByLead.set(leadId, new Set());
      reasonsByLead.get(leadId)!.add(reason);
    };

    for (const lead of assignedLeads ?? []) addReason(lead.id, "new");
    for (const log of contactedLogs ?? []) addReason(log.lead_id, "contacted");
    for (const lead of pendingQuality ?? []) addReason(lead.id, "pending_quality");
    for (const event of qualityEvents ?? []) addReason(event.lead_id, "quality_judged");
    const stageAdvanceCountByLead = new Map<string, number>();
    for (const event of stageEvents ?? []) {
      const leadId = event.lead_id as string | null;
      const to = (event as any).event_data?.to;
      addReason(leadId, "stage_advanced");
      if (leadId) {
        stageAdvanceCountByLead.set(leadId, (stageAdvanceCountByLead.get(leadId) ?? 0) + 1);
      }
      if (to === "won" || to === "lost") addReason(leadId, to);
    }
    for (const task of overdueTasks ?? []) addReason(task.lead_id, "overdue");

    const relevantIds = Array.from(relevantLeadIds);
    const relevantResult = relevantIds.length > 0
      ? await supabase.from("leads")
          .select("id, customer_name, assigned_to, stage, last_contact_date, quality")
          .in("id", relevantIds)
          .limit(500)
      : { data: [], error: null };
    const relevantLeads = relevantResult.data ?? [];
    if (relevantResult.error) {
      console.error("[weekly-review] L3 leads query error:", relevantResult.error);
    }

    const assignedIds = [...new Set(relevantLeads
      .map((row) => row.assigned_to)
      .filter((ownerId): ownerId is string => typeof ownerId === "string"))];
    const { data: ownerProfiles } = assignedIds.length > 0
      ? await supabase.from("profiles").select("id, full_name").in("id", assignedIds)
      : { data: [] };
    const ownerNameMap = new Map<string, string>();
    for (const profile of ownerProfiles ?? []) ownerNameMap.set(profile.id, profile.full_name ?? "");

    const contactCountByLead = new Map<string, number>();
    for (const log of contactedLogs ?? []) {
      contactCountByLead.set(log.lead_id, (contactCountByLead.get(log.lead_id) ?? 0) + 1);
    }

    const lastNoteByLead = new Map<string, string>();
    for (const log of (await supabase.from("follow_up_logs")
      .select("lead_id, summary, contact_result")
      .in("lead_id", relevantIds.length > 0 ? relevantIds : ["00000000-0000-0000-0000-000000000000"])
      .gte("created_at", startIso).lt("created_at", endIso)
      .order("created_at", { ascending: false })).data ?? []) {
      if (!lastNoteByLead.has(log.lead_id)) {
        lastNoteByLead.set(log.lead_id, log.summary || log.contact_result || "");
      }
    }

    const overdueCountByLead = new Map<string, number>();
    const nextByLead = new Map<string, string>();
    for (const task of overdueTasks ?? []) {
      const leadId = task.lead_id as string | null;
      if (!leadId) continue;
      overdueCountByLead.set(leadId, (overdueCountByLead.get(leadId) ?? 0) + 1);
      const dueAt = task.due_at as string;
      const existing = nextByLead.get(leadId);
      if (!existing || dueAt < existing) nextByLead.set(leadId, dueAt);
    }

    if (relevantIds.length > 0) {
      const { data: openTasks } = await supabase.from("tasks")
        .select("lead_id, due_at")
        .in("lead_id", relevantIds)
        .neq("status", "done")
        .order("due_at", { ascending: true });
      for (const task of openTasks ?? []) {
        const leadId = task.lead_id as string | null;
        if (!leadId || nextByLead.has(leadId)) continue;
        nextByLead.set(leadId, task.due_at);
      }
    }

    const l3_by_user: Record<string, WeeklyReviewLeadRow[]> = {};
    for (const lead of relevantLeads) {
      const owner = lead.assigned_to as string | null;
      if (!owner || !isSalesUser(owner)) continue;
      if (!l3_by_user[owner]) l3_by_user[owner] = [];
      l3_by_user[owner].push({
        id: lead.id,
        customer_name: lead.customer_name ?? null,
        assigned_to: owner,
        owner_name: ownerNameMap.get(owner) ?? null,
        stage: lead.stage ?? null,
        last_contact_date: lead.last_contact_date ?? null,
        contact_count: contactCountByLead.get(lead.id) ?? 0,
        quality: lead.quality ?? null,
        last_note: lastNoteByLead.get(lead.id) ?? null,
        next_follow_up_at: nextByLead.get(lead.id) ?? null,
        period_reasons: Array.from(reasonsByLead.get(lead.id) ?? []),
        overdue_count: overdueCountByLead.get(lead.id) ?? 0,
        stage_advance_count: stageAdvanceCountByLead.get(lead.id) ?? 0,
      });
    }
    for (const rows of Object.values(l3_by_user)) {
      rows.sort((a, b) => b.overdue_count - a.overdue_count || b.contact_count - a.contact_count);
    }

    const responseL2 = isSalesScope
      ? l2.filter((row) => row.user_id === user.id)
      : l2;
    const responseL3 = isSalesScope
      ? { [user.id]: l3_by_user[user.id] ?? [] }
      : l3_by_user;
    const personal = responseL2[0];

    return NextResponse.json({
      range,
      period_start: startIso,
      period_end: endIso,
      l1: {
        new_leads: isSalesScope ? personal?.assigned_leads ?? 0 : newLeadsCount ?? 0,
        contacted_leads: isSalesScope ? personal?.contacted ?? 0 : contactedDistinct,
        quality_judged: qualityJudgedDistinct,
        stage_advanced: isSalesScope ? personal?.stage_advanced ?? 0 : stageAdvancedCount ?? 0,
        won: isSalesScope ? personal?.won ?? 0 : wonCount ?? 0,
        lost: isSalesScope ? personal?.lost ?? 0 : lostCount ?? 0,
      },
      l2: responseL2,
      l3_by_user: responseL3,
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    console.error("[weekly-review] error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
