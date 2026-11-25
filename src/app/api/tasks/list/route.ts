// RBAC: user (authenticated)
import { NextResponse } from "next/server"
import { getCached, setCache } from "@/lib/api-cache.mjs"
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  requestAuthErrorResponse,
} from "@/lib/request-auth-context"
import { excludeSystemAccountsQuery } from "@/lib/system-accounts.mjs"
import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * S41 (F15): names of the assignees on this page, read with the service client because a salesperson's own profiles
 * read may not include colleagues, which left the page showing "02db8b32" ids. Best effort: on failure the page shows a
 * neutral label, never an id.
 */
async function assigneeNames(tasks: Array<{ assignee_id?: string | null }>): Promise<Array<{ id: string; full_name: string | null }>> {
  const ids = [...new Set(tasks.map((task) => task.assignee_id).filter((id): id is string => Boolean(id)))]
  if (ids.length === 0) return []
  try {
    const { data, error } = await supabaseAdmin.from("profiles").select("id, full_name").in("id", ids)
    if (error || !Array.isArray(data)) return []
    return data as Array<{ id: string; full_name: string | null }>
  } catch {
    return []
  }
}

const PAGE_SIZE = 20

export async function GET(request: Request) {
  try {
    const context = await getRequestAuthContext(request)
    const { supabase, user, role } = context
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init))
    const userId = user.id

    const { searchParams } = new URL(request.url)
    const statusFilter = searchParams.get("status") || "all"
    const assigneeFilter = searchParams.get("assignee") || "all"
    const page = parseInt(searchParams.get("page") || "0", 10)

    const cacheKey = `tasks:list:${role}:${userId}:${statusFilter}:${assigneeFilter}:${page}`
    const cached = getCached<Record<string, unknown>>(cacheKey)
    if (cached) return respond(cached)

    const [profilesResult, tasksResult] = await Promise.all([
      excludeSystemAccountsQuery(
        supabase.from("profiles").select("id, full_name"),
        { viewerId: userId },
      ).order("full_name"),
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
          q = q.eq("assignee_id", assigneeFilter)
        }

        return q
      })(),
    ])

    const { data: tasks, error: tasksErr, count } = tasksResult

    if (tasksErr) {
      console.error("tasks fetch failed:", tasksErr)
      return respond({ error: "Failed to fetch tasks" }, { status: 500 })
    }

    const responseData = {
      tasks: tasks ?? [],
      profiles: profilesResult.data ?? [],
      assignees: await assigneeNames((tasks ?? []) as Array<{ assignee_id?: string | null }>),
      totalCount: count ?? 0,
    }

    setCache(cacheKey, responseData, 30)
    return respond(responseData)
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
