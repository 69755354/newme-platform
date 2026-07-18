// RBAC: user (authenticated)
import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

interface SalesTeamMember {
  name: string;
  fullName: string;
  progress: number;
  level: string;
}

interface NeedsAttentionLead {
  leadId: string;
  customerName: string;
  projectType: string;
  budget: number;
  reason: string;
}

export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (!profile || !['admin', 'boss'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // Execute all 8 independent queries in parallel
    const [
      { data: targetLeads },
      { data: wonLeads },
      { data: salesProfiles },
      { data: allLeads },
      { data: allMilestones },
      { count: overdueFollowUps },
      { count: todayFollowUps },
      { data: unassignedLeads },
    ] = await Promise.all([
      // Q2: Month Target
      supabase
        .from('leads')
        .select('customer_budget')
        .gte('expected_sign_date', monthStart.toISOString())
        .lt('expected_sign_date', monthEnd.toISOString())
        .is('final_status', null),
      // Q3: Month Completed
      supabase
        .from('leads')
        .select('customer_budget')
        .eq('final_status', 'won')
        .gte('updated_at', monthStart.toISOString()),
      // Q4: Sales Profiles
      supabase
        .from('profiles')
        .select('id, full_name')
        .eq('role', 'sales'),
      // Q5: All Leads
      supabase
        .from('leads')
        .select('id, assigned_to'),
      // Q6: All Milestones
      supabase
        .from('lead_milestones')
        .select('id, lead_id')
        .not('completed_at', 'is', null),
      // Q7: Overdue Follow-ups
      supabase
        .from('tasks')
        .select('*', { count: 'exact', head: true })
        .is('completed_at', null)
        .lt('due_at', new Date().toISOString()),
      // Q8: Today's Follow-ups — leads whose next_followup_date is today (server local timezone).
      //     Column is DATE, so compare against a local YYYY-MM-DD string.
      supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('next_followup_date', todayStr),
      // Q9: Needs Attention
      supabase
        .from('leads')
        .select('id, customer_name, project_type, customer_budget')
        .is('assigned_to', null)
        .order('customer_budget', { ascending: false, nullsFirst: false })
        .limit(10),
    ]);

    const monthTarget = (targetLeads ?? []).reduce(
      (sum, l) => sum + (l.customer_budget ?? 0),
      0
    );

    const monthCompleted = (wonLeads ?? []).reduce(
      (sum, l) => sum + (l.customer_budget ?? 0),
      0
    );

    const monthProgress = monthTarget > 0 ? (monthCompleted / monthTarget) * 100 : 0;

    const milestoneCountByLead = new Map<string, number>();
    for (const m of allMilestones ?? []) {
      milestoneCountByLead.set(m.lead_id, (milestoneCountByLead.get(m.lead_id) ?? 0) + 1);
    }

    const leadsByAssignee = new Map<string, string[]>();
    for (const l of allLeads ?? []) {
      if (l.assigned_to) {
        const arr = leadsByAssignee.get(l.assigned_to) ?? [];
        arr.push(l.id);
        leadsByAssignee.set(l.assigned_to, arr);
      }
    }

    const salesTeam: SalesTeamMember[] = (salesProfiles ?? [])
      .map((p) => {
        const leadIds = leadsByAssignee.get(p.id) ?? [];
        const milestoneCount = leadIds.reduce(
          (sum, id) => sum + (milestoneCountByLead.get(id) ?? 0),
          0
        );
        return {
          name: (p.full_name ?? '').split(' ')[0],
          fullName: p.full_name ?? '',
          progress: milestoneCount,
          level: getLevel(milestoneCount),
        };
      })
      .sort((a, b) => b.progress - a.progress);

    const needsAttention: NeedsAttentionLead[] = (unassignedLeads ?? []).map((l) => ({
      leadId: l.id,
      customerName: l.customer_name ?? '',
      projectType: l.project_type ?? '',
      budget: l.customer_budget ?? 0,
      reason: 'Unassigned lead',
    }));

    return NextResponse.json({
      monthTarget,
      monthCompleted,
      monthProgress,
      salesTeam,
      overdueFollowUps: overdueFollowUps ?? 0,
      todayFollowUps: todayFollowUps ?? 0,
      needsAttention,
    });
  } catch (error) {
    console.error('Command center error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch command center data' },
      { status: 500 }
    );
  }
}

function getLevel(milestones: number): string {
  if (milestones >= 20) return 'Expert';
  if (milestones >= 10) return 'Senior';
  if (milestones >= 5) return 'Intermediate';
  return 'Beginner';
}
