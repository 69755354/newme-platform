'use server'

import { createServerSupabase } from '@/models/supabase-server'

/**
 * Assign a single lead to a user.
 */
export async function assignLead(leadId: string, userId: string) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || !['admin', 'boss', 'operator'].includes(profile.role)) {
    throw new Error('Forbidden')
  }

  const { error } = await supabase
    .from('leads')
    .update({ assigned_to: userId })
    .eq('id', leadId)

  if (error) throw new Error(error.message)
}

/**
 * Bulk assign multiple leads to a user. Handles batching internally (50 per batch).
 */
export async function bulkAssignLeads(leadIds: string[], targetUserId: string) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || !['admin', 'boss', 'operator'].includes(profile.role)) {
    throw new Error('Forbidden')
  }

  const batchSize = 50
  for (let i = 0; i < leadIds.length; i += batchSize) {
    const batch = leadIds.slice(i, i + batchSize)
    const { error } = await supabase
      .from('leads')
      .update({ assigned_to: targetUserId })
      .in('id', batch)

    if (error) throw new Error(error.message)
  }
}

/**
 * Bulk unassign multiple leads. Handles batching internally (50 per batch).
 */
export async function bulkUnassignLeads(leadIds: string[]) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || !['admin', 'boss', 'operator'].includes(profile.role)) {
    throw new Error('Forbidden')
  }

  const batchSize = 50
  for (let i = 0; i < leadIds.length; i += batchSize) {
    const batch = leadIds.slice(i, i + batchSize)
    const { error } = await supabase
      .from('leads')
      .update({ assigned_to: null })
      .in('id', batch)

    if (error) throw new Error(error.message)
  }
}

/**
 * Transfer all leads from one user to another.
 */
export async function transferAllLeads(fromUserId: string, toUserId: string) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || !['admin', 'boss', 'operator'].includes(profile.role)) {
    throw new Error('Forbidden')
  }

  const { error } = await supabase
    .from('leads')
    .update({ assigned_to: toUserId })
    .eq('assigned_to', fromUserId)

  if (error) throw new Error(error.message)
}
