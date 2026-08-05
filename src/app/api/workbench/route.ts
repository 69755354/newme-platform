// RBAC: user (authenticated)
import { NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"
import { getCached, setCache } from "@/lib/api-cache"

// Dubai GST = UTC+4. All "day"/"week" math below is done in GST, then
// converted back to UTC ISO strings for DB queries.
const GST_OFFSET_MS = 4 * 3600 * 1000

function dubaiTomorrowBounds(): { startIso: string; endIso: string } {
  const now = new Date()
  const gst = new Date(now.getTime() + GST_OFFSET_MS)
  const tomorrowGst = new Date(gst)
  tomorrowGst.setUTCDate(gst.getUTCDate() + 1)
  tomorrowGst.setUTCHours(0, 0, 0, 0)
  const startMs = tomorrowGst.getTime() - GST_OFFSET_MS
  const endGst = new Date(tomorrowGst)
  endGst.setUTCHours(23, 59, 59, 999)
  const endMs = endGst.getTime() - GST_OFFSET_MS
  return { startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() }
}

function dubaiWeekBounds(): { startIso: string; endIso: string } {
  // Dubai Mon-Sat workweek. Upper bound is exclusive (start of next Monday),
  // matching the canonical /api/dashboard/weekly-review implementation.
  const now = new Date()
  const gst = new Date(now.getTime() + GST_OFFSET_MS)
  const dow = gst.getUTCDay() // 0=Sun..6=Sat
  const monOffset = (dow + 6) % 7 // days since Monday
  const mondayGst = new Date(gst)
  mondayGst.setUTCDate(gst.getUTCDate() - monOffset)
  mondayGst.setUTCHours(0, 0, 0, 0)
  const startMs = mondayGst.getTime() - GST_OFFSET_MS
  const endMs = startMs + 7 * 24 * 3600 * 1000
  return { startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() }
}

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
    .select("id, full_name, role")
    .eq("id", user.id)
    .single()

  if (profileError || !profile) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const cacheKey = `workbench:${profile.role}:${user.id}`
  const cached = getCached(cacheKey)
  if (cached) return NextResponse.json(cached)

  const isSales = profile.role === "sales"
  const nowIso = new Date().toISOString()
  const taskCols = "id,lead_id,title,due_at,status,source,created_at,assignee_id"

  // ── Phase 3: all data queries in parallel ──
  const [
    inboxResult,
    tasksResult,
    overdueResult,
    alertsResult,
    progressResult,
    featuresResult,
  ] = await Promise.all([
    // inbox
    (() => {
      let q = supabase
        .from("leads")
        .select("id,customer_name,phone,current_milestone,next_followup_date,next_action,updated_at")
        .eq("archived", false)
        .is("final_status", null)
      if (isSales) q = q.eq("assigned_to", user.id)
      return q
        .order("next_followup_date", { ascending: true, nullsFirst: false })
        .order("updated_at", { ascending: false })
        .limit(20)
    })(),

    // tasks
    supabase
      .from("tasks")
      .select(taskCols)
      .eq("assignee_id", user.id)
      .is("completed_at", null)
      .order("due_at", { ascending: true })
      .limit(20),

    // overdue
    supabase
      .from("tasks")
      .select(taskCols)
      .eq("assignee_id", user.id)
      .is("completed_at", null)
      .lt("due_at", nowIso)
      .order("due_at", { ascending: true })
      .limit(20),

    // alerts
    supabase
      .from("leads")
      .select("id,customer_name,phone,next_followup_date,no_answer_flag")
      .eq("assigned_to", user.id)
      .eq("archived", false)
      .is("final_status", null)
      .or(`no_answer_flag.eq.true,next_followup_date.lt.${nowIso}`)
      .order("next_followup_date", { ascending: true, nullsFirst: false })
      .limit(20),

    // progress
    (() => {
      let q = supabase.from("leads").select("current_milestone")
      if (isSales) q = q.eq("assigned_to", user.id)
      return q
    })(),

    // features
    supabase
      .from("user_features")
      .select("feature_key, enabled")
      .eq("user_id", user.id),
  ])

  // ── Process inbox ──
  const inboxItems = ((inboxResult.data ?? []) as any[]).map((lead: any) => ({
    id: lead.id,
    customer_name: lead.customer_name,
    phone: lead.phone,
    current_milestone: lead.current_milestone,
    next_followup_date: lead.next_followup_date,
    next_action: lead.next_action,
    updated_at: lead.updated_at,
  }))

  const tasksItems = (tasksResult.data ?? []) as any[]
  const overdueItems = (overdueResult.data ?? []) as any[]

  // ── Phase 4: lead names for tasks/overdue ──
  const taskLeadIds = Array.from(
    new Set(
      [...tasksItems, ...overdueItems]
        .map((t: any) => t.lead_id as string)
        .filter(Boolean),
    ),
  )
  const leadNameById: Record<string, string | null> = {}
  if (taskLeadIds.length > 0) {
    const { data: leadRows } = await supabase
      .from("leads")
      .select("id,customer_name")
      .in("id", taskLeadIds)
    for (const l of leadRows ?? []) leadNameById[l.id] = l.customer_name
  }

  const withLeadName = (t: any) => ({
    ...t,
    lead_name: t.lead_id ? leadNameById[t.lead_id] ?? null : null,
  })
  const tasksWithNames = tasksItems.map(withLeadName)
  const overdueWithNames = overdueItems.map(withLeadName)

  // ── Process alerts ──
  const nowMs = Date.now()
  const alertsItems = ((alertsResult.data ?? []) as any[]).map((lead: any) => {
    let days_overdue: number | null = null
    if (lead.next_followup_date) {
      const diff = nowMs - new Date(lead.next_followup_date).getTime()
      days_overdue = diff > 0 ? Math.floor(diff / 86400000) : 0
    }
    return {
      id: lead.id,
      customer_name: lead.customer_name,
      phone: lead.phone,
      next_followup_date: lead.next_followup_date,
      no_answer_flag: Boolean(lead.no_answer_flag),
      days_overdue,
    }
  })

  // ── Process progress ──
  const progressRows = (progressResult.data ?? []) as any[]
  const progress: Record<string, number> = {}
  for (const row of progressRows) {
    const k = row.current_milestone || "new"
    progress[k] = (progress[k] || 0) + 1
  }
  const totalLeads = progressRows.length
  const progressArray = Object.entries(progress).map(([current_milestone, count]) => ({
    current_milestone,
    count,
    percentage: totalLeads > 0 ? Math.round((count / totalLeads) * 100) : 0,
  }))

  // ── Process features ──
  const features: Record<string, boolean> = {}
  for (const f of (featuresResult.data ?? [])) features[f.feature_key] = Boolean(f.enabled)

  // ── Tomorrow's tasks (Dubai GST) ──
  const tomorrowBounds = dubaiTomorrowBounds()
  const { data: tomorrowRows } = await supabase
    .from("tasks")
    .select("id,lead_id,title,due_at,assignee_id,status")
    .eq("assignee_id", user.id)
    .neq("status", "done")
    .gte("due_at", tomorrowBounds.startIso)
    .lte("due_at", tomorrowBounds.endIso)
    .order("due_at", { ascending: true })
    .limit(20)

  const tomorrowLeadIds = Array.from(
    new Set(
      ((tomorrowRows ?? []) as any[])
        .map((t) => t.lead_id as string | null)
        .filter((v): v is string => Boolean(v)),
    ),
  )
  const tomorrowLeadNameById: Record<string, string | null> = {}
  if (tomorrowLeadIds.length > 0) {
    const { data: tomorrowLeadRows } = await supabase
      .from("leads")
      .select("id,customer_name")
      .in("id", tomorrowLeadIds)
    for (const l of tomorrowLeadRows ?? []) tomorrowLeadNameById[l.id] = l.customer_name
  }
  const tomorrowTasks = ((tomorrowRows ?? []) as any[]).map((t) => ({
    id: t.id,
    title: t.title,
    lead_id: (t.lead_id as string | null) ?? null,
    lead_name: t.lead_id ? (tomorrowLeadNameById[t.lead_id] ?? null) : null,
    due_at: t.due_at as string | null,
  }))

  // ── My weekly stats (current user, Dubai Mon-Sat workweek) ──
  const weekBounds = dubaiWeekBounds()
  const [
    { data: contactedRows },
    { count: qualityJudgedCount },
    { count: stageAdvancedCount },
    { count: pendingQualityCount },
  ] = await Promise.all([
    supabase
      .from("follow_up_logs")
      .select("lead_id")
      .eq("user_id", user.id)
      .gte("created_at", weekBounds.startIso)
      .lt("created_at", weekBounds.endIso),
    supabase
      .from("business_events")
      .select("*", { count: "exact", head: true })
      .eq("event_type", "quality_checked")
      .eq("user_id", user.id)
      .gte("created_at", weekBounds.startIso)
      .lt("created_at", weekBounds.endIso),
    supabase
      .from("business_events")
      .select("*", { count: "exact", head: true })
      .eq("event_type", "stage_change")
      .eq("user_id", user.id)
      .gte("created_at", weekBounds.startIso)
      .lt("created_at", weekBounds.endIso),
    supabase
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("assigned_to", user.id)
      .eq("quality", "pending"),
  ])
  const contactedDistinct = new Set(
    ((contactedRows ?? []) as any[]).map((r) => r.lead_id as string),
  ).size
  const myWeeklyStats = {
    contacted_leads: contactedDistinct,
    quality_judged: qualityJudgedCount ?? 0,
    pending_quality: pendingQualityCount ?? 0,
    stage_advanced: stageAdvancedCount ?? 0,
    period_start: weekBounds.startIso,
    period_end: weekBounds.endIso,
    label: "本周表现",
  }

  const responseData = {
    inbox: inboxItems,
    tasks: tasksWithNames,
    overdue: overdueWithNames,
    alerts: alertsItems,
    progress: progressArray,
    tomorrowTasks,
    myWeeklyStats,
    profile: { id: profile.id, name: profile.full_name, role: profile.role },
    features,
  }

  setCache(cacheKey, responseData, 30)
  return NextResponse.json(responseData)
}
