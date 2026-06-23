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

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single()

    if (profileError || !profile) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const leadId = (await context.params).id

    // sales 只能看自己负责的 lead
    if (profile.role === "sales") {
      const { data: ownLead } = await supabase
        .from("leads")
        .select("id")
        .eq("id", leadId)
        .eq("owner_id", user.id)
        .maybeSingle()

      if (!ownLead) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
    }

    const { searchParams } = new URL(req.url)
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10))
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)))

    const [milestonesRes, followUpsRes, tasksRes, documentsRes, chatRes] = await Promise.all([
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
    ])

    const events: Array<{
      id: string
      eventType: string
      description: string | null
      created_at: string
      metadata: Record<string, unknown>
    }> = []

    for (const m of milestonesRes.data || []) {
      events.push({
        id: `milestone-${m.id}`,
        eventType: "milestone",
        description: m.milestone_key ?? null,
        created_at: m.created_at,
        metadata: m,
      })
    }

    for (const f of followUpsRes.data || []) {
      events.push({
        id: `follow_up-${f.id}`,
        eventType: "follow_up",
        description: f.summary ?? null,
        created_at: f.created_at,
        metadata: f,
      })
    }

    for (const t of tasksRes.data || []) {
      events.push({
        id: `task-${t.id}`,
        eventType: "task",
        description: t.title ?? null,
        created_at: t.created_at,
        metadata: t,
      })
    }

    for (const d of documentsRes.data || []) {
      events.push({
        id: `document-${d.id}`,
        eventType: "document",
        description: d.file_name ?? null,
        created_at: d.created_at,
        metadata: d,
      })
    }

    for (const c of chatRes.data || []) {
      events.push({
        id: `chat-${c.id}`,
        eventType: "chat",
        description: c.content ?? null,
        created_at: c.created_at,
        metadata: { direction: c.direction ?? "inbound" },
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