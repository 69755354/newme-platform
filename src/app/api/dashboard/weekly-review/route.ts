// RBAC: user (admin, boss, operator)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

export interface WeeklyReviewRow {
  user_id: string;
  full_name: string | null;
  assigned_leads: number;
  contacted: number;
  pending_quality: number;
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

function joinedFullName(value: unknown): string | null {
  const profile = Array.isArray(value) ? value[0] : value;
  if (!profile || typeof profile !== "object" || !("full_name" in profile)) return null;
  return typeof profile.full_name === "string" ? profile.full_name : null;
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
  if (!start || !end || start >= end) return null;
  return { start, end };
}

export async function GET(req: NextRequest) {
  try {
    const supabase = await createServerSupabase();
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

    // L1: 6 metrics via parallel queries
    const [
      { count: newLeadsCount },
      { data: contactedData },
      { count: qualityJudgedCount },
      { count: stageAdvancedCount },
      { count: wonCount },
      { count: lostCount },
    ] = await Promise.all([
      supabase.from("leads").select("*", { count: "exact", head: true })
        .gte("created_at", startIso).lt("created_at", endIso),
      supabase.from("follow_up_logs").select("lead_id")
        .gte("created_at", startIso).lt("created_at", endIso),
      supabase.from("business_events").select("*", { count: "exact", head: true })
        .eq("event_type", "quality_checked")
        .gte("created_at", startIso).lt("created_at", endIso),
      supabase.from("business_events").select("*", { count: "exact", head: true })
        .eq("event_type", "stage_change")
        .gte("created_at", startIso).lt("created_at", endIso),
      supabase.from("business_events").select("*", { count: "exact", head: true })
        .eq("event_type", "stage_change").eq("event_data->>to", "won")
        .gte("created_at", startIso).lt("created_at", endIso),
      supabase.from("business_events").select("*", { count: "exact", head: true })
        .eq("event_type", "stage_change").eq("event_data->>to", "lost")
        .gte("created_at", startIso).lt("created_at", endIso),
    ]);

    const contactedDistinct = new Set((contactedData ?? []).map((r: any) => r.lead_id)).size;

    // L2 per-sales rollup
    const { data: profilesAll } = await supabase.from("profiles").select("id, full_name, role");
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

    const { data: contactedLogs } = await supabase.from("follow_up_logs")
      .select("lead_id, leads!inner(assigned_to)")
      .gte("created_at", startIso).lt("created_at", endIso);

    const { data: pendingQuality } = await supabase.from("leads").select("assigned_to")
      .eq("quality", "pending").not("assigned_to", "is", null)
      .gte("created_at", startIso).lt("created_at", endIso);

    const { data: stageEvents } = await supabase.from("business_events").select("event_data, user_id, lead_id")
      .in("event_type", ["stage_change", "transfer", "owner_change"])
      .gte("created_at", startIso).lt("created_at", endIso);

    const { data: overdueTasks } = await supabase.from("tasks").select("assignee_id")
      .lt("due_at", new Date().toISOString()).neq("status", "done").not("assignee_id", "is", null)
      .gte("created_at", startIso).lt("created_at", endIso);

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
          assigned_leads: 0, contacted: 0, pending_quality: 0,
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
    for (const t of overdueTasks ?? []) { if (t.assignee_id) { const row = ensure(t.assignee_id); if (row) row.overdue_tasks++; } }

    const l2 = Array.from(perUser.values())
      .filter(r => true) // Show all sales/boss even with 0 activity
      .sort((a, b) => b.stage_advanced - a.stage_advanced);

    // L3: leads created during the period, grouped by owner.
    let leadsAssignedQuery = supabase.from("leads")
      .select("id, customer_name, assigned_to, stage, last_contact_date, quality")
      .gte("created_at", startIso).lt("created_at", endIso)
      .limit(500);
    if (isSalesScope) leadsAssignedQuery = leadsAssignedQuery.eq("assigned_to", user.id);
    const { data: leadsAssigned, error: leadsAssignedErr } = await leadsAssignedQuery;
    if (leadsAssignedErr) {
      console.error("[weekly-review] leads query error:", leadsAssignedErr);
    }

    // Resolve owner full_name for each assigned_to via separate profiles query.
    const assignedIds = [...new Set((leadsAssigned ?? []).map((r: any) => r.assigned_to).filter(Boolean))];
    const { data: ownerProfiles } = assignedIds.length > 0
      ? await supabase.from("profiles").select("id, full_name").in("id", assignedIds)
      : { data: [] };
    const ownerNameMap = new Map<string, string>();
    for (const p of ownerProfiles ?? []) ownerNameMap.set(p.id, p.full_name ?? "");

    const contactCountByLead = new Map<string, number>();
    for (const log of contactedLogs ?? []) {
      contactCountByLead.set(log.lead_id, (contactCountByLead.get(log.lead_id) ?? 0) + 1);
    }
    const lastNoteByLead = new Map<string, string>();
    for (const log of (await supabase.from("follow_up_logs")
      .select("lead_id, summary")
      .gte("created_at", startIso).lt("created_at", endIso)
      .order("created_at", { ascending: false })).data ?? []) {
      if (!lastNoteByLead.has(log.lead_id)) {
        lastNoteByLead.set(log.lead_id, (log as any).summary ?? "");
      }
    }
    const nextByLead = new Map<string, string>();
    for (const t of (await supabase.from("tasks")
      .select("lead_id, due_at")
      .gt("due_at", new Date().toISOString())
      .neq("status", "done")
      .order("due_at", { ascending: true })).data ?? []) {
      if (!nextByLead.has((t as any).lead_id)) nextByLead.set((t as any).lead_id, t.due_at);
    }

    const l3_by_user: Record<string, WeeklyReviewLeadRow[]> = {};
    for (const row of leadsAssigned ?? []) {
      const owner = row.assigned_to ?? "_unassigned";
      if (!l3_by_user[owner]) l3_by_user[owner] = [];
      l3_by_user[owner].push({
        id: row.id,
        customer_name: row.customer_name ?? null,
        assigned_to: row.assigned_to,
        owner_name: ownerNameMap.get(row.assigned_to) ?? null,
        stage: row.stage ?? null,
        last_contact_date: row.last_contact_date ?? null,
        contact_count: contactCountByLead.get(row.id) ?? 0,
        quality: row.quality ?? null,
        last_note: lastNoteByLead.get(row.id) ?? null,
        next_follow_up_at: nextByLead.get(row.id) ?? null,
      });
    }
    for (const k of Object.keys(l3_by_user)) {
      l3_by_user[k].sort((a, b) => (b.contact_count - a.contact_count));
    }

    // Also group stage-changed leads by their sales owner so L2 and L3 use
    // the same attribution model.
    const leadById = new Map<string, any>();
    for (const lead of leadsAssigned ?? []) leadById.set(lead.id, lead);

    // Fetch leads involved in stage changes that are NOT in leadsAssigned
    // (leads created outside the period but with stage changes inside it).
    const missingLeadIds = [...new Set(
      (stageEvents ?? [])
        .map((ev: any) => ev.lead_id as string | null)
        .filter((lid): lid is string => !!lid && !leadById.has(lid))
    )];
    if (missingLeadIds.length > 0) {
      const { data: missingLeads } = await supabase.from("leads")
        .select("id, customer_name, assigned_to, stage, last_contact_date, quality")
        .in("id", missingLeadIds)
        .limit(100);
      for (const ml of missingLeads ?? []) {
        leadById.set(ml.id, ml);
        if (ml.assigned_to && !ownerNameMap.has(ml.assigned_to)) {
          ownerNameMap.set(ml.assigned_to, null as any); // placeholder; name lookup will be null
        }
      }
    }

    for (const ev of stageEvents ?? []) {
      const lid = (ev as any).lead_id as string | null;
      if (!lid) continue;
      const lead = leadById.get(lid);
      const owner = lead?.assigned_to as string | null;
      if (!lead || !owner || !isSalesUser(owner)) continue;
      if (!l3_by_user[owner]) l3_by_user[owner] = [];
      // Avoid duplicate: only add if not already under this owner.
      const already = l3_by_user[owner].some((l: any) => l.id === lead.id);
      if (already) continue;
      l3_by_user[owner].push({
        id: lead.id,
        customer_name: lead.customer_name ?? null,
        assigned_to: lead.assigned_to,
        owner_name: ownerNameMap.get(lead.assigned_to) ?? null,
        stage: lead.stage ?? null,
        last_contact_date: lead.last_contact_date ?? null,
        contact_count: contactCountByLead.get(lead.id) ?? 0,
        quality: lead.quality ?? null,
        last_note: lastNoteByLead.get(lead.id) ?? null,
        next_follow_up_at: nextByLead.get(lead.id) ?? null,
      });
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
        quality_judged: isSalesScope ? 0 : qualityJudgedCount ?? 0,
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
