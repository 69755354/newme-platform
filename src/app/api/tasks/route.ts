import { NextResponse } from 'next/server'
import { createServerSupabase } from '@/models/supabase-server'

const VALID_STATUSES = ['pending', 'completed', 'cancelled'] as const
type TaskStatus = (typeof VALID_STATUSES)[number]

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
    const supabase = await createServerSupabase()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

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
        return NextResponse.json(
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
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

interface BatchUpdateBody {
  ids: string[]
  status: 'completed' | 'cancelled'
}

export async function PATCH(request: Request) {
  try {
    const supabase = await createServerSupabase()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body: BatchUpdateBody = await request.json()
    const { ids, status } = body

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'ids must be a non-empty array' }, { status: 400 })
    }

    if (status !== 'completed' && status !== 'cancelled') {
      return NextResponse.json({ error: 'status must be "completed" or "cancelled"' }, { status: 400 })
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
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data, updated: data?.length ?? 0 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
