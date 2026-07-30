'use server'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { finalizeTriggerCreatedUserProfile } from '@/lib/user-profile-provisioning'
import { resolveActiveLeadReassignmentTarget } from '@/lib/lead-reassignment.mjs'
import { cookies } from 'next/headers'
import {
  activeOrganizationMemberIds,
  requireOrganizationMembership,
  resolveOrganizationMemberAdminAccess,
} from '@/lib/organization-member-admin'

const VALID_ROLES = ['admin', 'boss', 'sales', 'designer', 'operator', 'finance']

interface AddTeamMemberInput {
  full_name: string
  email: string
  password: string
  role: string
  phone?: string
}

async function actionRequest(): Promise<Request> {
  const cookieStore = await cookies()
  return new Request('http://newme.internal/server-action', {
    headers: { cookie: cookieStore.toString() },
  })
}

/**
 * Add a new team member.
 */
export async function addTeamMember(data: AddTeamMemberInput) {
  const access = await resolveOrganizationMemberAdminAccess(await actionRequest())

  // Validation
  if (!data.email || !data.password || !data.full_name || !data.role) {
    throw new Error('Missing required fields: email, password, full_name, role')
  }
  if (!VALID_ROLES.includes(data.role)) {
    throw new Error(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`)
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

  const profileResult = await finalizeTriggerCreatedUserProfile(authData.user.id, {
    email: data.email,
    fullName: data.full_name,
    role: data.role,
    phone: data.phone,
  })

  if (!profileResult.ok) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id)
    throw new Error('Failed to create profile')
  }

  const { data: updatedMembership, error: membershipError } = await supabaseAdmin
    .from('memberships')
    .insert({
      organization_id: access.organizationId,
      user_id: authData.user.id,
      status: 'active',
      invited_by_membership_id: access.callerMembershipId,
      accepted_at: new Date().toISOString(),
    })
  if (membershipError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id)
    throw new Error(`Failed to create organization membership: ${membershipError.message}`)
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
  const access = await resolveOrganizationMemberAdminAccess(await actionRequest())

  // Cannot delete self
  if (access.context.user.id === userId) {
    throw new Error('Cannot delete yourself')
  }
  const membership = await requireOrganizationMembership(
    access.organizationId,
    userId,
  )

  const memberIds = (await activeOrganizationMemberIds(access.organizationId))
    .filter((memberId) => memberId !== userId)
  const reassignTo = memberIds.length === 0
    ? null
    : await resolveActiveLeadReassignmentTarget(
        supabaseAdmin
          .from('profiles')
          .select('id,role,is_active')
          .in('id', memberIds) as never,
      )
  const logTarget = reassignTo ?? 'null (no eligible receiver available)'

  // Reassign leads assigned to this user
  const { data: orphanedLeads, error: orphanedLeadsErr } = await supabaseAdmin
    .from('leads')
    .select('id')
    .eq('organization_id', access.organizationId)
    .eq('assigned_to', userId)
  if (orphanedLeadsErr) throw new Error(`Failed to load leads for reassignment: ${orphanedLeadsErr.message}`)
  if (orphanedLeads && orphanedLeads.length > 0) {
    const leadIds = orphanedLeads.map((l: any) => l.id)
    const { error: leadErr } = await supabaseAdmin
      .from('leads')
      .update({ assigned_to: reassignTo })
      .eq('organization_id', access.organizationId)
      .in('id', leadIds)
    if (leadErr) throw new Error(`Failed to reassign leads: ${leadErr.message}`)
    console.log(`[user-delete] Reassigned or unassigned ${leadIds.length} lead(s) from user ${userId} to ${logTarget}`)
  }

  const now = new Date().toISOString()
  const { data: updatedMembership, error: membershipError } = await supabaseAdmin
    .from('memberships')
    .update({
      status: 'inactive',
      deactivated_at: now,
      recovery_deadline: new Date(Date.now() + 90 * 86400000).toISOString(),
      updated_at: now,
      version: membership.version + 1,
    })
    .eq('id', membership.id)
    .eq('organization_id', access.organizationId)
    .eq('version', membership.version)
    .select('id')
    .maybeSingle()
  if (membershipError || !updatedMembership) {
    throw new Error(membershipError?.message || 'Membership changed concurrently')
  }

  return { success: true }
}

/**
 * Reset a user's password (admin/boss only).
 */
export async function resetUserPassword(userId: string, password: string) {
  if (!password || password.length < 6) {
    throw new Error('Password must be at least 6 characters')
  }

  const access = await resolveOrganizationMemberAdminAccess(await actionRequest())
  await requireOrganizationMembership(access.organizationId, userId)

  // Reset target user's password
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password })
  if (error) throw new Error(error.message)

  // Invalidate sessions by marking password change time
  await supabaseAdmin
    .from('profiles')
    .update({ password_changed_at: new Date().toISOString() })
    .eq('id', userId)

  return { success: true }
}
