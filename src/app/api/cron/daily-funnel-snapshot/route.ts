// RBAC: cron (x-cron-secret)
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getRequestedOrganizationId } from '@/lib/organization-context'

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
    const requestedOrganizationId = getRequestedOrganizationId(req)
    let organizationsQuery = supabaseAdmin
      .from('organizations')
      .select('id')
      .eq('status', 'active')
    if (requestedOrganizationId) {
      organizationsQuery = organizationsQuery.eq('id', requestedOrganizationId)
    }
    const { data: organizations, error: organizationsError } =
      await organizationsQuery
    if (organizationsError) {
      return NextResponse.json({ error: organizationsError.message }, { status: 500 })
    }
    if (requestedOrganizationId && organizations?.length !== 1) {
      return NextResponse.json({ error: 'active_organization_required' }, { status: 404 })
    }

    const records: Array<{
      organization_id: string
      snapshot_date: string
      current_milestone: string
      lead_count: number
      total_value: number
    }> = []

    for (const organization of organizations ?? []) {
      const { data: activeLeads, error: fetchError } = await supabaseAdmin
        .from('leads')
        .select('current_milestone')
        .eq('organization_id', organization.id)
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

      const { error: deleteError } = await supabaseAdmin
        .from('crm_daily_funnel_snapshot')
        .delete()
        .eq('organization_id', organization.id)
        .eq('snapshot_date', snapshotDate)
      if (deleteError) {
        return NextResponse.json({ error: deleteError.message }, { status: 500 })
      }

      const knownMilestones = MILESTONE_ORDER.filter((m) => grouped[m])
      const unknownMilestones = Object.keys(grouped).filter(
        (m) => !MILESTONE_ORDER.includes(m as (typeof MILESTONE_ORDER)[number]),
      )
      for (const milestone of [...knownMilestones, ...unknownMilestones]) {
        records.push({
          organization_id: organization.id,
          snapshot_date: snapshotDate,
          current_milestone: milestone,
          lead_count: grouped[milestone].count,
          total_value: 0,
        })
      }
    }

    if (records.length > 0) {
      const { error: insertError } = await supabaseAdmin
        .from('crm_daily_funnel_snapshot')
        .insert(records)
      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 })
      }
    }

    return NextResponse.json({
      snapshotDate,
      organizationCount: organizations?.length ?? 0,
      records,
    })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
