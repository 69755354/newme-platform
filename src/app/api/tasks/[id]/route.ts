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
import type { Database } from '@/types/database'

type TaskUpdate = Database['public']['Tables']['tasks']['Update']

const VALID_STATUSES = ['pending', 'completed', 'cancelled'] as const
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
const PRIVILEGED_TASK_ROLES = new Set(['admin', 'boss', 'operator'])
type TaskStatus = (typeof VALID_STATUSES)[number]

const TASK_DETAIL_SELECT = `*`

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const context = await getRequestAuthContext(request)
    const { supabase, user } = context
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init))

    const { id } = await params

    const { data, error } = await supabase
      .from('tasks')
      .select(TASK_DETAIL_SELECT)
      .eq('id', id)
      .eq('assignee_id', user.id)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return respond({ error: 'Task not found or not assigned to current user' }, { status: 404 })
      }
      return respond({ error: error.message }, { status: 500 })
    }

    return respond({ data })
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

interface UpdateTaskBody {
  status?: TaskStatus
  title?: string
  description?: string | null
  priority?: string | null
  assignee_id?: string | null
  due_at?: string
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const context = await getRequestAuthContext(request)
    const { supabase, user } = context
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init))

    const { id } = await params
    const body: UpdateTaskBody = await request.json()

    const updateData: TaskUpdate = {}

    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim().length === 0) {
        return respond({ error: 'title must be a non-empty string' }, { status: 400 })
      }
      updateData.title = body.title.trim()
    }

    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        return respond({ error: 'description must be a string or null' }, { status: 400 })
      }
      updateData.description = body.description
    }

    if (body.priority !== undefined) {
      if (body.priority !== null && !VALID_PRIORITIES.includes(body.priority as (typeof VALID_PRIORITIES)[number])) {
        return respond({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` }, { status: 400 })
      }
      updateData.priority = body.priority
    }

    if (body.assignee_id !== undefined) {
      if (body.assignee_id !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.assignee_id)) {
        return respond({ error: 'assignee_id must be a UUID or null' }, { status: 400 })
      }
      const isPrivileged = PRIVILEGED_TASK_ROLES.has(context.role)
      if (!isPrivileged && body.assignee_id !== user.id) {
        return respond({ error: 'Only task managers can change the assignee' }, { status: 403 })
      }
      if (isPrivileged && body.assignee_id !== null && body.assignee_id !== user.id) {
        const { data: targetProfile, error: targetError } = await supabase
          .from('profiles')
          .select('id, is_active')
          .eq('id', body.assignee_id)
          .maybeSingle()
        if (targetError) {
          return respond({ error: 'Unable to verify task assignee' }, { status: 503 })
        }
        if (!targetProfile || targetProfile.is_active !== true) {
          return respond({ error: 'Task assignee must be an active profile' }, { status: 400 })
        }
      }
      updateData.assignee_id = body.assignee_id
    }

    if (body.status !== undefined) {
      if (!VALID_STATUSES.includes(body.status as TaskStatus)) {
        return respond({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 })
      }
      updateData.status = body.status
      updateData.completed_at = body.status === 'completed' ? new Date().toISOString() : null
    }

    if (body.due_at !== undefined) {
      const dueDate = new Date(body.due_at)
      if (isNaN(dueDate.getTime())) {
        return respond({ error: 'due_at must be a valid ISO date string' }, { status: 400 })
      }
      if (dueDate.getTime() <= Date.now()) {
        return respond({ error: 'due_at must be in the future (rule_002)' }, { status: 400 })
      }
      updateData.due_at = body.due_at
    }

    if (Object.keys(updateData).length === 0) {
      return respond({ error: 'No updatable fields provided. Allowed: status, title, description, priority, assignee_id, due_at' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updateData)
      .eq('id', id)
      .eq('assignee_id', user.id)
      .select(TASK_DETAIL_SELECT)
      .single()

    if (error) {
      const conflict = taskFollowupConflictResponse(error)
      if (conflict) return respond(conflict.body, { status: conflict.status })
      if (error.code === 'PGRST116') {
        return respond({ error: 'Task not found or not assigned to current user' }, { status: 404 })
      }
      return respond({ error: error.message }, { status: 500 })
    }

    return respond({ data })
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
