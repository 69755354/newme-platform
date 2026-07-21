// RBAC: user (authenticated)
import { NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase-server'

export async function GET(request: Request) {
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader)
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const leadId = searchParams.get('lead_id')
    const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100)
    const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0)

    const selectColumns = `
      id,
      lead_id,
      user_id,
      contact_type,
      summary,
      result,
      no_answer,
      next_action,
      created_at,
      leads (
        id,
        customer_name
      )
    `

    if (leadId) {
      const { data, error } = await supabase
        .from('follow_up_logs')
        .select(selectColumns)
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false })

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ data })
    }

    const { data, error, count } = await supabase
      .from('follow_up_logs')
      .select(selectColumns, { count: 'exact' })
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      data,
      pagination: { limit, offset, total: count ?? 0, has_more: offset + limit < (count ?? 0) },
    })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
