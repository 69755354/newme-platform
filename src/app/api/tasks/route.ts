// RBAC: user (authenticated)
import { NextResponse } from 'next/server'
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  requestAuthErrorResponse,
} from '@/lib/request-auth-context'
import {
  taskFollowupConflictResponse,
} from '@/lib/task-followup-conflict'

const VALID_STATUSES = ['pending', 'completed', 'cancelled'] as const
type TaskStatus = (typeof VALID_STATUSES)[number]
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const TASK_SELECT = `
  id,
  lead_id,
  title,
  assignee_id,
  due_at,
  status,
  source,
  completed_at,
  created_at,
  leads (
    id,
    customer_name
  )
`

export async function GET(request: Request) {
  try {
    const context = await getRequestAuthContext(request)
    const { supabase, user } = context
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init))

    const { searchParams } = new URL(request.url)
    const leadId = searchParams.get('lead_id')
    const statusParam = searchParams.get('status')
    const status: string = statusParam ?? 'pending'

    let query = supabase
      .from('tasks')
      .select(TASK_SELECT)
      .eq('assignee_id', user.id)

    if (status !== 'all') {
      if (!VALID_STATUSES.includes(status as TaskStatus)) {
        return respond(
          { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}, all` },
          { status: 400 }
        )
      }
      query = query.eq('status', status)
    }

    if (leadId) {
      query = query.eq('lead_id', leadId)
    }

    const { data, error } = await query.order('due_at', { ascending: true })

    if (error) {
      return respond({ error: error.message }, { status: 500 })
    }

    return respond({ data })
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

interface CreateTaskBody {
  id?: unknown
  lead_id?: unknown
  title?: unknown
  due_at?: unknown
}

export async function POST(request: Request) {
  try {
    const context = await getRequestAuthContext(request)
    const { supabase, user } = context
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init))

    const body: CreateTaskBody = await request.json()
    if (typeof body.id !== 'string' || !UUID_PATTERN.test(body.id)) {
      return respond({ error: 'id must be a UUID' }, { status: 400 })
    }
    if (typeof body.lead_id !== 'string' || !UUID_PATTERN.test(body.lead_id)) {
      return respond({ error: 'lead_id must be a UUID' }, { status: 400 })
    }
    if (typeof body.title !== 'string' || body.title.trim().length === 0 || body.title.trim().length > 200) {
      return respond({ error: 'title must be between 1 and 200 characters' }, { status: 400 })
    }
    if (typeof body.due_at !== 'string') {
      return respond({ error: 'due_at must be a valid future ISO date string' }, { status: 400 })
    }

    const dueDate = new Date(body.due_at)
    if (Number.isNaN(dueDate.getTime()) || dueDate.getTime() <= Date.now()) {
      return respond({ error: 'due_at must be a valid future ISO date string' }, { status: 400 })
    }

    const { data: visibleLead, error: leadError } = await supabase
      .from('leads')
      .select('id')
      .eq('id', body.lead_id)
      .maybeSingle()
    if (leadError) {
      return respond({ error: 'Unable to verify lead access' }, { status: 503 })
    }
    if (!visibleLead) {
      return respond({ error: 'Lead not found' }, { status: 404 })
    }

    const taskInput = {
      id: body.id,
      lead_id: body.lead_id,
      title: body.title.trim(),
      assignee_id: user.id,
      due_at: dueDate.toISOString(),
      status: 'pending' as const,
      completed_at: null,
      source: 'follow_up' as const,
    }
    const { data, error } = await supabase
      .from('tasks')
      .insert(taskInput)
      .select(TASK_SELECT)
      .single()

    if (!error && data) {
      return respond({ data, replayed: false }, { status: 201 })
    }

    if (error?.code === '23505') {
      const { data: existing, error: replayError } = await supabase
        .from('tasks')
        .select(TASK_SELECT)
        .eq('id', body.id)
        .eq('lead_id', body.lead_id)
        .eq('assignee_id', user.id)
        .maybeSingle()
      const exactReplay = !replayError
        && existing?.status === 'pending'
        && existing.completed_at === null
        && existing.source === taskInput.source
        && existing.title === taskInput.title
        && typeof existing.due_at === 'string'
        && new Date(existing.due_at).getTime() === dueDate.getTime()
      if (exactReplay) {
        return respond({ data: existing, replayed: true })
      }
      return respond({ error: 'Task id is already in use' }, { status: 409 })
    }

    return respond({ error: 'Failed to create follow-up task' }, { status: 500 })
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

interface BatchUpdateBody {
  ids: string[]
  status: 'completed' | 'cancelled'
}

export async function PATCH(request: Request) {
  try {
    const context = await getRequestAuthContext(request)
    const { supabase, user } = context
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init))

    const body: BatchUpdateBody = await request.json()
    const { ids, status } = body

    if (!Array.isArray(ids) || ids.length === 0) {
      return respond({ error: 'ids must be a non-empty array' }, { status: 400 })
    }

    if (status !== 'completed' && status !== 'cancelled') {
      return respond({ error: 'status must be "completed" or "cancelled"' }, { status: 400 })
    }

    const updateData: { status: string; completed_at: string | null } = {
      status,
      completed_at: status === 'completed' ? new Date().toISOString() : null,
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updateData)
      .in('id', ids)
      .eq('assignee_id', user.id)
      .select('id, status, completed_at')

    if (error) {
      const conflict = taskFollowupConflictResponse(error)
      if (conflict) return respond(conflict.body, { status: conflict.status })
      return respond({ error: error.message }, { status: 500 })
    }

    return respond({ data, updated: data?.length ?? 0 })
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
