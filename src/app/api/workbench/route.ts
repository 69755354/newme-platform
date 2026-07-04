import { NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"
import { getCached, setCache } from "@/lib/api-cache"

export async function GET() {
  const supabase = await createServerSupabase()

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
  const leadNameById: Record<string, string> = {}
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

  const responseData = {
    inbox: inboxItems,
    tasks: tasksWithNames,
    overdue: overdueWithNames,
    alerts: alertsItems,
    progress: progressArray,
    profile: { id: profile.id, name: profile.full_name, role: profile.role },
    features,
  }

  setCache(cacheKey, responseData, 30)
  return NextResponse.json(responseData)
}
