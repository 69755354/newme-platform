// RBAC: cron (x-cron-secret)
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET(request: Request) {
  return handleCron(request)
}

export async function POST(request: Request) {
  return handleCron(request)
}

async function handleCron(request: Request) {
  const cronSecret = request.headers.get('x-cron-secret')
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)

    const { data: tasks, error: tasksError } = await supabaseAdmin
      .from('tasks')
      .select(`
        id,
        title,
        assignee_id,
        due_at,
        leads ( id, customer_name )
      `)
      .eq('status', 'pending')
      .gte('due_at', startOfDay.toISOString())
      .lte('due_at', endOfDay.toISOString())

    if (tasksError) {
      return NextResponse.json({ error: tasksError.message }, { status: 500 })
    }

    if (!tasks || tasks.length === 0) {
      return NextResponse.json({ checked: 0, notificationsCreated: 0 })
    }

    const tasksByAssignee = new Map<string, typeof tasks>()
    for (const task of tasks) {
      if (!task.assignee_id) continue
      const existing = tasksByAssignee.get(task.assignee_id)
      if (existing) existing.push(task)
      else tasksByAssignee.set(task.assignee_id, [task])
    }

    let notificationsCreated = 0

    for (const [assigneeId, assigneeTasks] of tasksByAssignee) {
      const count = assigneeTasks.length
      const previewItems = assigneeTasks.slice(0, 5).map((t) => {
        const name = t.leads?.[0]?.customer_name
        return name ? `${t.title}（${name}）` : t.title
      })
      const preview = previewItems.join('；')
      const suffix = count > 5 ? '等' : ''

      const { error: notifError } = await supabaseAdmin
        .from('notifications')
        .insert({
          user_id: assigneeId,
          type: 'reminder',
          title: `今日待办提醒（${count} 项）`,
          body: `您今天有 ${count} 项待办任务：${preview}${suffix}。`,
          related_id: assigneeTasks[0].id,
          related_type: 'task',
        })

      if (!notifError) notificationsCreated++
    }

    return NextResponse.json({
      checked: tasks.length,
      notificationsCreated,
    })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
