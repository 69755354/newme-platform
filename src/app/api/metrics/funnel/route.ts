import { NextResponse } from 'next/server'
import { createServerSupabase } from '@/models/supabase-server'

export const dynamic = 'force-dynamic'

const MILESTONE_ORDER = ['new', 'contacted', 'qualified', 'pending_decision', 'won', 'lost'] as const

function normalizeMilestone(milestone: string): string {
  if (milestone === 'solution' || milestone === 'quotation' || milestone === 'meeting') {
    return 'pending_decision'
  }
  return milestone
}

export async function GET() {
  try {
    const supabase = await createServerSupabase()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }

    if (profile.role !== 'admin' && profile.role !== 'boss') {
      return NextResponse.json({ error: 'Forbidden — admin or boss only' }, { status: 403 })
    }

    const { data: leads, error: leadsError } = await supabase
      .from('leads')
      .select('current_milestone, final_status')

    if (leadsError) {
      return NextResponse.json({ error: leadsError.message }, { status: 500 })
    }

    const grouped: Record<string, number> = {}

    for (const lead of leads ?? []) {
      let bucket: string
      if (lead.final_status === 'won' || lead.final_status === 'lost') {
        bucket = lead.final_status
      } else if (lead.current_milestone) {
        bucket = normalizeMilestone(lead.current_milestone)
      } else {
        continue
      }
      grouped[bucket] = (grouped[bucket] || 0) + 1
    }

    const total = Object.values(grouped).reduce((sum, count) => sum + count, 0)

    const known = MILESTONE_ORDER.filter((m) => grouped[m] !== undefined)
    const unknown = Object.keys(grouped).filter(
      (m) => !MILESTONE_ORDER.includes(m as (typeof MILESTONE_ORDER)[number]),
    )
    const ordered = [...known, ...unknown]

    const funnel = ordered.map((milestone) => {
      const count = grouped[milestone] || 0
      const percentage = total > 0 ? Math.round((count / total) * 1000) / 10 : 0
      return { milestone, count, percentage }
    })

    return NextResponse.json({ funnel, total })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
