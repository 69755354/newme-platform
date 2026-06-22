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
  const today = new Date().toISOString().split("T")[0]
  const nowIso = new Date().toISOString()

  const inboxCols = "id,customer_name,phone,source,stage,current_milestone,quality,next_followup_date,next_action,property_type,location,assigned_to,created_at"
  const taskCols = "id,lead_id,title,due_at,status,source,created_at,assignee_id"

  // inbox
  let inboxQuery = supabase
    .from("leads")
    .select(inboxCols)
    .or(`and(next_followup_date.lte.${today},stage.not.in.(won,lost)),current_milestone.not.in.(won,lost)`)
    .order("next_followup_date", { ascending: true })
    .limit(20)

  if (isSales) inboxQuery = inboxQuery.eq("assigned_to", user.id)
  const { data: inboxItems } = await inboxQuery

  // tasks
  const { data: tasksItems } = await supabase
    .from("tasks")
    .select(taskCols)
    .eq("assignee_id", user.id)
    .eq("status", "pending")
    .order("due_at", { ascending: true })
    .limit(20)

  // overdue
  const { data: overdueItems } = await supabase
    .from("tasks")
    .select(taskCols)
    .eq("assignee_id", user.id)
    .eq("status", "pending")
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

  // features
  const { data: featureRows } = await supabase
    .from("user_features")
    .select("feature_key, enabled")
    .eq("user_id", user.id)

  const features: Record<string, boolean> = {}
  for (const f of featureRows || []) features[f.feature_key] = Boolean(f.enabled)

  return NextResponse.json({
    panels: {
      inbox: { label: "Needs Follow-up", count: inboxItems?.length ?? 0, items: inboxItems ?? [] },
      tasks: { label: "My Tasks", count: tasksItems?.length ?? 0, items: tasksItems ?? [] },
      overdue: { label: "Overdue", count: overdueItems?.length ?? 0, items: overdueItems ?? [] },
      progress: { label: "My Pipeline", items: progress },
    },
    profile: { id: profile.id, name: profile.full_name, role: profile.role },
    features,
  })
}
