import { NextResponse } from 'next/server'
import { createServerSupabase } from '@/models/supabase-server'

export const dynamic = 'force-dynamic'

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

    const isAdminOrBoss = profile.role === 'admin' || profile.role === 'boss'
    const today = new Date().toISOString().split('T')[0]
    const todayStart = `${today}T00:00:00.000Z`
    const todayEnd = `${today}T23:59:59.999Z`

    const newLeadsQ = supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', todayStart)
      .lte('created_at', todayEnd)

    const totalActiveQ = supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .is('final_status', null)

    const wonTodayQ = supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('final_status', 'won')
      .gte('updated_at', todayStart)
      .lte('updated_at', todayEnd)

    const lostTodayQ = supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('final_status', 'lost')
      .gte('updated_at', todayStart)
      .lte('updated_at', todayEnd)

    const followUpsTodayQ = supabase
      .from('follow_up_logs')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', todayStart)
      .lte('created_at', todayEnd)

    const pendingTasksQ = supabase
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')

    const overdueTasksQ = supabase
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .lt('due_at', todayStart)

    // Sales users only see their own data
    if (!isAdminOrBoss) {
      newLeadsQ.eq('assigned_to', user.id)
      totalActiveQ.eq('assigned_to', user.id)
      wonTodayQ.eq('assigned_to', user.id)
      lostTodayQ.eq('assigned_to', user.id)
      followUpsTodayQ.eq('user_id', user.id)
      pendingTasksQ.eq('assignee_id', user.id)
      overdueTasksQ.eq('assignee_id', user.id)
    }

    const [newLeadsRes, totalActiveRes, wonTodayRes, lostTodayRes, followUpsTodayRes, pendingTasksRes, overdueTasksRes] =
      await Promise.all([newLeadsQ, totalActiveQ, wonTodayQ, lostTodayQ, followUpsTodayQ, pendingTasksQ, overdueTasksQ])

    return NextResponse.json({
      newLeads: newLeadsRes.count ?? 0,
      totalActive: totalActiveRes.count ?? 0,
      wonToday: wonTodayRes.count ?? 0,
      lostToday: lostTodayRes.count ?? 0,
      followUpsToday: followUpsTodayRes.count ?? 0,
      pendingTasks: pendingTasksRes.count ?? 0,
      overdueTasks: overdueTasksRes.count ?? 0,
    })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
