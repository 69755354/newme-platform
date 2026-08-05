// RBAC: cron (x-cron-secret)
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

const MILESTONE_ORDER = ['new', 'contacted', 'qualified', 'pending_decision'] as const

function normalizeMilestone(milestone: string): string {
  if (milestone === 'solution' || milestone === 'quotation' || milestone === 'meeting') {
    return 'pending_decision'
  }
  return milestone
}

export async function GET(req: NextRequest) {
  try {
    const cronSecret = req.headers.get('x-cron-secret')
    if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const snapshotDate = new Date().toISOString().split('T')[0]

    const { data: activeLeads, error: fetchError } = await supabaseAdmin
      .from('leads')
      .select('current_milestone')
      .is('final_status', null)
      .eq('archived', false)

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    const grouped: Record<string, { count: number; total_value: number }> = {}
    for (const lead of activeLeads ?? []) {
      const milestone = normalizeMilestone(lead.current_milestone || 'new')
      if (!grouped[milestone]) grouped[milestone] = { count: 0, total_value: 0 }
      grouped[milestone].count += 1
    }

    // Delete today's existing records (idempotent)
    const { error: deleteError } = await supabaseAdmin
      .from('crm_daily_funnel_snapshot')
      .delete()
      .eq('snapshot_date', snapshotDate)

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 })
    }

    const knownMilestones = MILESTONE_ORDER.filter((m) => grouped[m])
    const unknownMilestones = Object.keys(grouped).filter(
      (m) => !MILESTONE_ORDER.includes(m as (typeof MILESTONE_ORDER)[number]),
    )
    const ordered = [...knownMilestones, ...unknownMilestones]

    const records = ordered.map((milestone) => ({
      snapshot_date: snapshotDate,
      current_milestone: milestone,
      lead_count: grouped[milestone].count,
      total_value: 0,
    }))

    if (records.length > 0) {
      const { error: insertError } = await supabaseAdmin
        .from('crm_daily_funnel_snapshot')
        .insert(records)

      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 })
      }
    }

    return NextResponse.json({ snapshotDate, records })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
