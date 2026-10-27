'use server'

import { createServerSupabase } from '@/lib/supabase-server'
import { getActionAuthContext } from '@/lib/action-auth-context'
import type { Database, Json } from '@/types/database'

type LeadUpdate = Database['public']['Tables']['leads']['Update']

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabase>>

async function assertCanOperateOnLead(
  supabase: ServerSupabaseClient,
  userId: string,
  role: string | null,
  leadId: string
) {
  // R1 · the role now arrives from getActionAuthContext(), which has already read
  // the caller's profile once. This used to re-read it, so an action ran two
  // queries for the same row and the second one could disagree with the first.
  if (role && ['admin', 'boss', 'operator'].includes(role)) return

  if (role === 'sales') {
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
  eventData?: Record<string, Json>
) {
  const { supabase, user } = await getActionAuthContext()

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
  const { supabase, user, role } = await getActionAuthContext()

  // Role + ownership gate
  const isPrivileged = role ? ['admin', 'boss', 'operator'].includes(role) : false
  if (!isPrivileged) {
    const { data: lead } = await supabase.from('leads').select('assigned_to').eq('id', leadId).single()
    if (!lead || lead.assigned_to !== user.id) throw new Error('Forbidden')
  }

  const now = new Date().toISOString()
  const data: LeadUpdate = {
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
  const { supabase, user, role } = await getActionAuthContext()

  await assertCanOperateOnLead(supabase, user.id, role, leadId)

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
  const { supabase, user, role } = await getActionAuthContext()

  await assertCanOperateOnLead(supabase, user.id, role, leadId)

  await supabase.from('activities').insert({
    lead_id: leadId,
    type: 'stage_change',
    content: `Stage changed from ${oldStage} to ${newStage} (${method})`,
    user_id: user.id,
  })

  return { success: true }
}
