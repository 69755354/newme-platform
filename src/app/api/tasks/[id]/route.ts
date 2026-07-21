// RBAC: user (authenticated)
import { NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase-server'

const VALID_STATUSES = ['pending', 'completed', 'cancelled'] as const
type TaskStatus = (typeof VALID_STATUSES)[number]

const TASK_DETAIL_SELECT = `*`

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader)
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params

    const { data, error } = await supabase
      .from('tasks')
      .select(TASK_DETAIL_SELECT)
      .eq('id', id)
      .eq('assignee_id', user.id)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Task not found or not assigned to current user' }, { status: 404 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

interface UpdateTaskBody {
  status?: TaskStatus
  title?: string
  due_at?: string
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader)
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const body: UpdateTaskBody = await request.json()

    const updateData: Record<string, unknown> = {}

    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim().length === 0) {
        return NextResponse.json({ error: 'title must be a non-empty string' }, { status: 400 })
      }
      updateData.title = body.title.trim()
    }

    if (body.status !== undefined) {
      if (!VALID_STATUSES.includes(body.status as TaskStatus)) {
        return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 })
      }
      updateData.status = body.status
      updateData.completed_at = body.status === 'completed' ? new Date().toISOString() : null
    }

    if (body.due_at !== undefined) {
      const dueDate = new Date(body.due_at)
      if (isNaN(dueDate.getTime())) {
        return NextResponse.json({ error: 'due_at must be a valid ISO date string' }, { status: 400 })
      }
      if (dueDate.getTime() <= Date.now()) {
        return NextResponse.json({ error: 'due_at must be in the future (rule_002)' }, { status: 400 })
      }
      updateData.due_at = body.due_at
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No updatable fields provided. Allowed: status, title, due_at' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updateData)
      .eq('id', id)
      .eq('assignee_id', user.id)
      .select(TASK_DETAIL_SELECT)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Task not found or not assigned to current user' }, { status: 404 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
