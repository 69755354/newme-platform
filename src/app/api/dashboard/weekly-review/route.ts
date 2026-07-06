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

export interface WeeklyReviewResponse {
  range: "this_week" | "last_week" | "this_month";
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

function periodBounds(range: "this_week" | "last_week" | "this_month"): { start: Date; end: Date } {
  const now = new Date();
  if (range === "this_week") {
    // Dubai Mon-Sat workweek. Compute Monday-based week in UTC+4.
    const GST_OFFSET_MS = 4 * 3600 * 1000;
    const gst = new Date(now.getTime() + GST_OFFSET_MS);
    const dow = gst.getUTCDay(); // 0=Sun..6=Sat
    const monOffset = (dow + 6) % 7; // days since Monday
    const mondayGst = new Date(gst);
    mondayGst.setUTCDate(gst.getUTCDate() - monOffset);
    mondayGst.setUTCHours(0, 0, 0, 0);
    const startGstMs = mondayGst.getTime();
    const start = new Date(startGstMs - GST_OFFSET_MS);
    const end = new Date(start.getTime() + WEEK_MS);
    return { start, end };
  }
  if (range === "last_week") {
    const { start } = periodBounds("this_week");
    const last = new Date(start.getTime() - WEEK_MS);
    const end = new Date(start.getTime());
    return { start: last, end };
  }
  // this_month
  const GST_OFFSET_MS = 4 * 3600 * 1000;
  const gst = new Date(now.getTime() + GST_OFFSET_MS);
  const start = new Date(Date.UTC(gst.getUTCFullYear(), gst.getUTCMonth(), 1) - GST_OFFSET_MS);
  const end = new Date(Date.UTC(gst.getUTCFullYear(), gst.getUTCMonth() + 1, 1) - GST_OFFSET_MS);
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
    if (!["admin", "boss", "operator"].includes(role)) {
      return NextResponse.json({ error: "Forbidden: management only" }, { status: 403 });
    }

    const sp = new URL(req.url).searchParams;
    const rangeRaw = (sp.get("range") ?? "this_week").toLowerCase();
    const range: "this_week" | "last_week" | "this_month" =
      rangeRaw === "last_week" ? "last_week" :
      rangeRaw === "this_month" ? "this_month" : "this_week";

    const { start, end } = periodBounds(range);
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
    const { data: profilesAll } = await supabase.from("profiles").select("id, full_name");
    const salesMap = new Map<string, string>();
    for (const p of profilesAll ?? []) salesMap.set(p.id, p.full_name ?? "");

    const { data: assignedLeads } = await supabase.from("leads").select("id, assigned_to")
      .gte("created_at", startIso).lt("created_at", endIso).not("assigned_to", "is", null);

    const { data: contactedLogs } = await supabase.from("follow_up_logs")
      .select("lead_id, leads!inner(assigned_to)")
      .gte("created_at", startIso).lt("created_at", endIso);

    const { data: pendingQuality } = await supabase.from("leads").select("assigned_to")
      .eq("quality", "pending").not("assigned_to", "is", null);

    const { data: stageEvents } = await supabase.from("business_events").select("event_data, user_id, lead_id")
      .in("event_type", ["stage_change", "transfer", "owner_change"])
      .gte("created_at", startIso).lt("created_at", endIso);

    const { data: overdueTasks } = await supabase.from("tasks").select("assignee_id")
      .lt("due_at", new Date().toISOString()).neq("status", "done").not("assignee_id", "is", null);

    const perUser = new Map<string, WeeklyReviewRow>();
    const ensure = (uid: string) => {
      if (!perUser.has(uid)) {
        perUser.set(uid, {
          user_id: uid, full_name: salesMap.get(uid) ?? null,
          assigned_leads: 0, contacted: 0, pending_quality: 0,
          stage_advanced: 0, won: 0, lost: 0, overdue_tasks: 0,
        });
      }
      return perUser.get(uid)!;
    };
    for (const r of assignedLeads ?? []) if (r.assigned_to) ensure(r.assigned_to).assigned_leads++;
    const contactedByOwner = new Map<string, Set<string>>();
    for (const log of contactedLogs ?? []) {
      const owner = (log as any).leads?.assigned_to as string | null;
      if (!owner) continue;
      if (!contactedByOwner.has(owner)) contactedByOwner.set(owner, new Set());
      contactedByOwner.get(owner)!.add(log.lead_id);
    }
    for (const [uid, set] of contactedByOwner) ensure(uid).contacted = set.size;
    for (const r of pendingQuality ?? []) if (r.assigned_to) ensure(r.assigned_to).pending_quality++;
    for (const ev of stageEvents ?? []) {
      const actor = (ev as any).user_id as string | null;
      const to = (ev as any).event_data?.to;
      if (!actor) continue;
      const row = ensure(actor);
      row.stage_advanced++;
      if (to === "won") row.won++;
      else if (to === "lost") row.lost++;
    }
    for (const t of overdueTasks ?? []) if (t.assignee_id) ensure(t.assignee_id).overdue_tasks++;

    const l2 = Array.from(perUser.values()).sort((a, b) => b.stage_advanced - a.stage_advanced);

    // L3: leads created during the period, grouped by owner.
    const { data: leadsAssigned } = await supabase.from("leads")
      .select("id, customer_name, assigned_to, stage, last_contact_date, quality, profiles:assigned_to(full_name)")
      .gte("created_at", startIso).lt("created_at", endIso)
      .limit(200);

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
        owner_name: joinedFullName(row.profiles),
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

    // Also group leads by stage-change actor so the L3
    // expansion works for every L2 row.
    const leadById = new Map<string, any>();
    for (const lead of leadsAssigned ?? []) leadById.set(lead.id, lead);
    for (const ev of stageEvents ?? []) {
      const actor = (ev as any).user_id as string | null;
      const lid = (ev as any).lead_id as string | null;
      if (!actor || !lid) continue;
      const lead = leadById.get(lid);
      if (!lead) continue; // lead not in period scope, skip
      if (!l3_by_user[actor]) l3_by_user[actor] = [];
      // Avoid duplicate: only add if not already under this actor
      const already = l3_by_user[actor].some((l: any) => l.id === lead.id);
      if (already) continue;
      l3_by_user[actor].push({
        id: lead.id,
        customer_name: lead.customer_name ?? null,
        assigned_to: lead.assigned_to,
        owner_name: joinedFullName(lead.profiles),
        stage: lead.stage ?? null,
        last_contact_date: lead.last_contact_date ?? null,
        contact_count: contactCountByLead.get(lead.id) ?? 0,
        quality: lead.quality ?? null,
        last_note: lastNoteByLead.get(lead.id) ?? null,
        next_follow_up_at: nextByLead.get(lead.id) ?? null,
      });
    }

    return NextResponse.json({
      range,
      period_start: startIso,
      period_end: endIso,
      l1: {
        new_leads: newLeadsCount ?? 0,
        contacted_leads: contactedDistinct,
        quality_judged: qualityJudgedCount ?? 0,
        stage_advanced: stageAdvancedCount ?? 0,
        won: wonCount ?? 0,
        lost: lostCount ?? 0,
      },
      l2,
      l3_by_user,
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    console.error("[weekly-review] error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
