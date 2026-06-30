import { NextRequest, NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createServerSupabase()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const leadId = (await context.params).id

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single()

    if (profileError || !profile) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // Authorization: management roles (admin/boss/operator/manager) may view any
    // lead's timeline. Everyone else (e.g. sales) may only view leads assigned
    // to them. Note: the leads owner column is `assigned_to`, NOT `owner_id`.
    const MANAGEMENT_ROLES = ["admin", "boss", "operator", "manager"]
    if (!MANAGEMENT_ROLES.includes(profile.role)) {
      const { data: ownLead } = await supabase
        .from("leads")
        .select("id")
        .eq("id", leadId)
        .eq("assigned_to", user.id)
        .maybeSingle()

      if (!ownLead) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
    }

    const { searchParams } = new URL(req.url)
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10))
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)))

    const [milestonesRes, followUpsRes, tasksRes, documentsRes, chatRes, activitiesRes, businessEventsRes] = await Promise.all([
      supabase.from("lead_milestones").select("*").eq("lead_id", leadId),
      supabase.from("follow_up_logs").select("*").eq("lead_id", leadId),
      supabase.from("tasks").select("*").eq("lead_id", leadId),
      supabase.from("lead_documents").select("*").eq("lead_id", leadId),
      supabase
        .from("chat_messages")
        .select("id, content, direction, created_at")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: true })
        .limit(200),
      supabase.from("activities").select("*").eq("lead_id", leadId),
      supabase.from("business_events").select("*").eq("lead_id", leadId),
    ])

    const events: Array<{
      id: string
      event_type: string
      description: string | null
      created_at: string
      metadata: Record<string, unknown>
    }> = []

    for (const m of milestonesRes.data || []) {
      events.push({
        id: `milestone-${m.id}`,
        event_type: "milestone",
        description: m.milestone_key ?? null,
        created_at: m.created_at,
        metadata: m,
      })
    }

    for (const f of followUpsRes.data || []) {
      events.push({
        id: `follow_up-${f.id}`,
        event_type: "follow_up",
        description: f.summary ?? null,
        created_at: f.created_at,
        metadata: f,
      })
    }

    for (const t of tasksRes.data || []) {
      events.push({
        id: `task-${t.id}`,
        event_type: "task",
        description: t.title ?? null,
        created_at: t.created_at,
        metadata: t,
      })
    }

    for (const d of documentsRes.data || []) {
      events.push({
        id: `document-${d.id}`,
        event_type: "document",
        description: d.file_name ?? null,
        created_at: d.created_at,
        metadata: d,
      })
    }

    for (const c of chatRes.data || []) {
      events.push({
        id: `chat-${c.id}`,
        event_type: "chat",
        description: c.content ?? null,
        created_at: c.created_at,
        metadata: { direction: c.direction ?? "inbound" },
      })
    }

    for (const a of activitiesRes.data || []) {
      events.push({
        id: `activity-${a.id}`,
        event_type: "activity",
        description: a.content ?? null,
        created_at: a.created_at,
        metadata: a,
      })
    }

    for (const be of businessEventsRes.data || []) {
      events.push({
        id: `business_event-${be.id}`,
        event_type: "business_event",
        description: be.description ?? null,
        created_at: be.created_at,
        metadata: be,
      })
    }

    events.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    const total = events.length
    const offset = (page - 1) * limit
    const paged = events.slice(offset, offset + limit)

    return NextResponse.json({
      events: paged,
      total,
      page,
      limit,
    })
  } catch (err) {
    console.error("[timeline] error:", err)
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    )
  }
}