// RBAC: user (authenticated)
import { NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"
import { getCached, setCache } from "@/lib/api-cache"

const PAGE_SIZE = 20

export async function GET(request: Request) {
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
    .select("role")
    .eq("id", user.id)
    .single()

  if (profileError || !profile) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const role = profile.role
  const userId = user.id

  const { searchParams } = new URL(request.url)
  const statusFilter = searchParams.get("status") || "all"
  const assigneeFilter = searchParams.get("assignee") || "all"
  const page = parseInt(searchParams.get("page") || "0", 10)

  const cacheKey = `tasks:list:${role}:${userId}:${statusFilter}:${assigneeFilter}:${page}`
  const cached = getCached(cacheKey)
  if (cached) return NextResponse.json(cached)

  const [profilesResult, tasksResult] = await Promise.all([
    supabase.from("profiles").select("id, full_name").order("full_name"),
    (async () => {
      let q = supabase
        .from("tasks")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (statusFilter !== "all") {
        q = q.eq("status", statusFilter)
      }
      if (assigneeFilter !== "all") {
        q = q.eq("assigned_to", assigneeFilter)
      }

      return q
    })(),
  ])

  const { data: tasks, error: tasksErr, count } = tasksResult

  if (tasksErr) {
    console.error("tasks fetch failed:", tasksErr)
    return NextResponse.json({ error: "Failed to fetch tasks" }, { status: 500 })
  }

  const responseData = {
    tasks: (tasks ?? []) as any[],
    profiles: (profilesResult.data ?? []) as any[],
    totalCount: count ?? 0,
  }

  setCache(cacheKey, responseData, 30)
  return NextResponse.json(responseData)
}
