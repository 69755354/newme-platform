import { NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"

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

  const isSales = profile.role === "sales"
  const nowIso = new Date().toISOString()

  const taskCols = "id,lead_id,title,due_at,status,source,created_at,assignee_id"

  // Inbox follows open tasks rather than the retired lead follow-up fields.
  let inboxQuery = supabase
    .from("tasks")
    .select("lead_id,title,leads!inner(id,customer_name,phone,location,final_status)")
    .is("completed_at", null)
    .order("due_at", { ascending: true })
    .limit(20)

  if (isSales) inboxQuery = inboxQuery.eq("assignee_id", user.id)
  const { data: inboxTasks } = await inboxQuery
  const inboxItems = (inboxTasks ?? []).flatMap((task: any) => {
    const lead = Array.isArray(task.leads) ? task.leads[0] : task.leads
    if (!lead || lead.final_status) return []
    return [{
      id: lead.id,
      customer_name: lead.customer_name,
      phone: lead.phone,
      location: lead.location,
      next_action: task.title,
    }]
  })

  // tasks
  const { data: tasksItems } = await supabase
    .from("tasks")
    .select(taskCols)
    .eq("assignee_id", user.id)
    .is("completed_at", null)
    .order("due_at", { ascending: true })
    .limit(20)

  // overdue
  const { data: overdueItems } = await supabase
    .from("tasks")
    .select(taskCols)
    .eq("assignee_id", user.id)
    .is("completed_at", null)
    .lt("due_at", nowIso)
    .order("due_at", { ascending: true })
    .limit(20)

  // progress
  let progQuery = supabase.from("leads").select("current_milestone")
  if (isSales) progQuery = progQuery.eq("assigned_to", user.id)
  const { data: progressRows } = await progQuery

  const progress: Record<string, number> = {}
  for (const row of progressRows || []) {
    const k = row.current_milestone || "new"
    progress[k] = (progress[k] || 0) + 1
  }

  // Convert progress Record to array matching frontend ProgressGroup interface
  const totalLeads = (progressRows || []).length
  const progressArray = Object.entries(progress).map(([current_milestone, count]) => ({
    current_milestone,
    count,
    percentage: totalLeads > 0 ? Math.round((count / totalLeads) * 100) : 0,
  }))

  // features
  const { data: featureRows } = await supabase
    .from("user_features")
    .select("feature_key, enabled")
    .eq("user_id", user.id)

  const features: Record<string, boolean> = {}
  for (const f of featureRows || []) features[f.feature_key] = Boolean(f.enabled)

  return NextResponse.json({
    inbox: inboxItems ?? [],
    tasks: tasksItems ?? [],
    overdue: overdueItems ?? [],
    progress: progressArray,
    profile: { id: profile.id, name: profile.full_name, role: profile.role },
    features,
  })
}
