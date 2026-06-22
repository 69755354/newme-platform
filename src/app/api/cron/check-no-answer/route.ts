import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET(request: Request) {
  return handleCron(request)
}

export async function POST(request: Request) {
  return handleCron(request)
}

async function handleCron(request: Request) {
  try {
    const cronSecret = request.headers.get('x-cron-secret')
    if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: leads, error: leadsError } = await supabaseAdmin
      .from('leads')
      .select('id, assigned_to, customer_name')

    if (leadsError) {
      return NextResponse.json({ error: leadsError.message }, { status: 500 })
    }

    if (!leads || leads.length === 0) {
      return NextResponse.json({ checked: 0, markedNoAnswer: 0, notifications: 0 })
    }

    let markedNoAnswer = 0
    let notificationsCreated = 0

    for (const lead of leads) {
      const { data: recentLogs, error: logsError } = await supabaseAdmin
        .from('follow_up_logs')
        .select('id, no_answer')
        .eq('lead_id', lead.id)
        .order('created_at', { ascending: false })
        .limit(3)

      if (logsError || !recentLogs) continue
      if (recentLogs.length < 3) continue

      const allNoAnswer = recentLogs.every((log) => log.no_answer === true)
      if (!allNoAnswer) continue

      markedNoAnswer++

      await supabaseAdmin
        .from('leads')
        .update({ no_answer_flag: true })
        .eq('id', lead.id)

      if (lead.assigned_to) {
        const { error: notifError } = await supabaseAdmin
          .from('notifications')
          .insert({
            user_id: lead.assigned_to,
            type: 'warning',
            title: '客户连续3次未接听',
            body: `客户「${lead.customer_name ?? '未知'}」最近 3 次跟进均为未接听，请及时关注并调整跟进策略。`,
            related_id: lead.id,
            related_type: 'lead',
          })

        if (!notifError) notificationsCreated++
      }
    }

    return NextResponse.json({
      checked: leads.length,
      markedNoAnswer,
      notifications: notificationsCreated,
    })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
