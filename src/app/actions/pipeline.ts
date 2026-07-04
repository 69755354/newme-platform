'use server'

import { createServerSupabase } from '@/lib/supabase-server'

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabase>>

async function assertCanOperateOnLead(
  supabase: ServerSupabaseClient,
  userId: string,
  leadId: string
) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single()

  if (profile && ['admin', 'boss', 'operator'].includes(profile.role)) return

  if (profile?.role === 'sales') {
    const { data: lead } = await supabase
      .from('leads')
      .select('assigned_to')
      .eq('id', leadId)
      .single()

    if (lead?.assigned_to === userId) return
  }

  throw new Error('Forbidden: you do not have permission to operate on this lead')
}

/**
 * Write a business event for a lead (stage change, status update, etc.).
 */
export async function writeBusinessEvent(
  leadId: string,
  eventType: string,
  description: string,
  eventData?: Record<string, any>
) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  const { error } = await supabase.from('business_events').insert({
    lead_id: leadId,
    event_type: eventType,
    description,
    event_data: eventData || {},
    user_id: user.id,
  })

  if (error) throw new Error(error.message || 'Failed to write business event')
  return { success: true }
}

/**
 * Update a lead's stage or final_status (won/lost).
 */
export async function updateLeadStage(
  leadId: string,
  updates: { stage?: string; final_status?: string }
) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  // Role + ownership gate
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  const isPrivileged = profile?.role && ['admin', 'boss', 'operator'].includes(profile.role)
  if (!isPrivileged) {
    const { data: lead } = await supabase.from('leads').select('assigned_to').eq('id', leadId).single()
    if (!lead || lead.assigned_to !== user.id) throw new Error('Forbidden')
  }

  const now = new Date().toISOString()
  const data: Record<string, any> = {
    ...updates,
    updated_at: now,
    last_contact_date: now,
  }

  if (updates.final_status === 'won' || updates.final_status === 'lost') {
    data.decision_date = now
  }

  const { error } = await supabase.from('leads').update(data).eq('id', leadId)
  if (error) throw new Error(error.message || 'Failed to update lead stage')

  return { success: true }
}

/**
 * Cascade-update related quotations when a lead is moved to won/lost.
 */
export async function updateRelatedQuotations(leadId: string, isLost: boolean) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  await assertCanOperateOnLead(supabase, user.id, leadId)

  const now = new Date().toISOString()
  const { error } = await supabase
    .from('quotations')
    .update({ status: isLost ? 'draft' : undefined, updated_at: now })
    .eq('lead_id', leadId)
    .neq('status', 'accepted')

  if (error) throw new Error(error.message || 'Failed to update quotations')
  return { success: true }
}

/**
 * Log a stage-change activity for a lead.
 */
export async function logStageChangeActivity(
  leadId: string,
  oldStage: string,
  newStage: string,
  method: string = 'Kanban drag'
) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  await assertCanOperateOnLead(supabase, user.id, leadId)

  await supabase.from('activities').insert({
    lead_id: leadId,
    type: 'stage_change',
    content: `Stage changed from ${oldStage} to ${newStage} (${method})`,
    user_id: user.id,
  })

  return { success: true }
}
