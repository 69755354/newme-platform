'use server'

import { createServerSupabase } from '@/lib/supabase-server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveActiveLeadReassignmentTarget } from '@/lib/lead-reassignment.mjs'

const VALID_ROLES = ['admin', 'boss', 'sales', 'designer', 'operator', 'finance']

interface AddTeamMemberInput {
  full_name: string
  email: string
  password: string
  role: string
  phone?: string
}

/**
 * Add a new team member.
 */
export async function addTeamMember(data: AddTeamMemberInput) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  // Role check
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || !['admin', 'boss', 'sales'].includes(profile.role)) {
    throw new Error('Forbidden')
  }

  // Validation
  if (!data.email || !data.password || !data.full_name || !data.role) {
    throw new Error('Missing required fields: email, password, full_name, role')
  }
  if (!VALID_ROLES.includes(data.role)) {
    throw new Error(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`)
  }
  if (profile.role === 'sales' && data.role !== 'sales') {
    throw new Error('Sales managers can only create users with sales role.')
  }

  // Create auth user via admin API
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email: data.email,
    password: data.password,
    email_confirm: true,
    user_metadata: { full_name: data.full_name, role: data.role, phone: data.phone },
  })

  if (authError) {
    throw new Error(authError.message || 'Failed to create auth user')
  }
  if (!authData.user) {
    throw new Error('Failed to create user')
  }

  // Insert into public.profiles
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .insert({
      id: authData.user.id,
      email: data.email,
      full_name: data.full_name,
      role: data.role,
      phone: data.phone || null,
      is_active: true,
      force_password_change: true,
    })

  if (profileError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id)
    throw new Error('Failed to create profile')
  }

  // Notify admins about new team member
  try {
    const { getAdminUserIds, createNotificationsBulk } = await import('@/lib/notifications')
    const adminIds = await getAdminUserIds()
    if (adminIds.length > 0) {
      await createNotificationsBulk(
        adminIds.map((id) => ({
          userId: id,
          type: 'team_member_added',
          title: `New team member: ${data.full_name}`,
          body: `${data.full_name} added as ${data.role}`,
          relatedId: authData.user.id,
          relatedType: 'user',
        }))
      )
    }
  } catch {
    // non-critical: ignore notification errors
  }

  return {
    id: authData.user.id,
    email: data.email,
    full_name: data.full_name,
    role: data.role,
    phone: data.phone || null,
  }
}

/**
 * Remove (soft-delete) a team member.
 */
export async function removeTeamMember(userId: string) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  // Role check
  const { data: caller } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!caller || !['admin', 'boss'].includes(caller.role)) {
    throw new Error('Forbidden')
  }

  // Cannot delete self
  if (user.id === userId) {
    throw new Error('Cannot delete yourself')
  }

  const reassignTo = await resolveActiveLeadReassignmentTarget(
    supabaseAdmin.from('profiles').select('id,role,is_active').neq('id', userId) as never,
  )
  const logTarget = reassignTo ?? 'null (no eligible receiver available)'

  // Reassign leads assigned to this user
  const { data: orphanedLeads, error: orphanedLeadsErr } = await supabaseAdmin
    .from('leads')
    .select('id')
    .eq('assigned_to', userId)
  if (orphanedLeadsErr) throw new Error(`Failed to load leads for reassignment: ${orphanedLeadsErr.message}`)
  if (orphanedLeads && orphanedLeads.length > 0) {
    const leadIds = orphanedLeads.map((l: any) => l.id)
    const { error: leadErr } = await supabaseAdmin
      .from('leads')
      .update({ assigned_to: reassignTo })
      .in('id', leadIds)
    if (leadErr) throw new Error(`Failed to reassign leads: ${leadErr.message}`)
    console.log(`[user-delete] Reassigned or unassigned ${leadIds.length} lead(s) from user ${userId} to ${logTarget}`)
  }

  // Reassign contracts where this user is sales_id
  const { data: orphanedContracts, error: orphanedContractsErr } = await supabaseAdmin
    .from('contracts')
    .select('id')
    .eq('sales_id', userId)
  if (orphanedContractsErr) throw new Error(`Failed to load contracts for reassignment: ${orphanedContractsErr.message}`)
  if (orphanedContracts && orphanedContracts.length > 0) {
    const contractIds = orphanedContracts.map((c: any) => c.id)
    const { error: contractErr } = await supabaseAdmin
      .from('contracts')
      .update({ sales_id: reassignTo })
      .in('id', contractIds)
    if (contractErr) throw new Error(`Failed to reassign contracts: ${contractErr.message}`)
    console.log(`[user-delete] Reassigned ${contractIds.length} contract(s) from user ${userId} to ${logTarget}`)
  }

  // Soft-delete: mark as inactive
  const { error: profileErr } = await supabaseAdmin
    .from('profiles')
    .update({ is_active: false })
    .eq('id', userId)

  if (profileErr) throw new Error(profileErr.message)

  return { success: true }
}

/**
 * Reset a user's password (admin/boss only).
 */
export async function resetUserPassword(userId: string, password: string) {
  if (!password || password.length < 6) {
    throw new Error('Password must be at least 6 characters')
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const { createClient } = await import('@supabase/supabase-js')
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  // Role check: only admin/boss
  const { data: profile } = await adminClient
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || !['admin', 'boss'].includes(profile.role)) {
    throw new Error('Forbidden')
  }

  // Reset target user's password
  const { error } = await adminClient.auth.admin.updateUserById(userId, { password })
  if (error) throw new Error(error.message)

  // Invalidate sessions by marking password change time
  await adminClient
    .from('profiles')
    .update({ password_changed_at: new Date().toISOString() })
    .eq('id', userId)

  return { success: true }
}
