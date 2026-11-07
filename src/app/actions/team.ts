'use server'

import { getActionAuthContext } from '@/lib/action-auth-context'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { requireActiveLeadTransferCandidate } from '@/lib/lead-reassignment.mjs'
import { handOverMemberLeads, readHandoverTarget } from '@/lib/member-lead-handover.mjs'
import { AUDIT_ACTIONS, writeAuditLog } from '@/lib/audit-log'

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
  const { role, user } = await getActionAuthContext()

  // Role check
  if (!role || !['admin', 'boss'].includes(role)) {
    throw new Error('Forbidden')
  }

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

  // Complete the profile created by the auth.users trigger.
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .upsert({
      id: authData.user.id,
      email: data.email,
      full_name: data.full_name,
      role: data.role,
      phone: data.phone || null,
      is_active: true,
      force_password_change: true,
    }, { onConflict: 'id' })

  if (profileError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id)
    throw new Error('Failed to create profile')
  }

  // Application-layer audit (actor id only): who created which account, with which role.
  void writeAuditLog({
    actorId: user?.id,
    action: AUDIT_ACTIONS.USER_CREATED,
    targetType: 'user',
    targetId: authData.user.id,
    details: { role: data.role },
  })
  void writeAuditLog({
    actorId: user?.id,
    action: AUDIT_ACTIONS.ROLE_ASSIGNED,
    targetType: 'user',
    targetId: authData.user.id,
    details: { new_role: data.role, previous_role: 'none' },
  })

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
          // notifications_related_type_check has no 'user' value; the bell links by type.
          eventKey: `team_member_added:${authData.user.id}`,
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
 *
 * S3 #6: the administrator chooses who receives the member's leads — a named
 * active colleague, or `UNASSIGNED_QUEUE` to leave them unassigned in the admin
 * queue. There is no default receiver any more (it used to be the lowest UUID).
 * Every lead moves through the audited transfer routines; the member is only
 * deactivated when all of their leads were handed over. Failures come back as
 * a result (server-action exceptions are redacted in production).
 */
export async function removeTeamMember(
  userId: string,
  handover: { transferTo: string; batchKey: string },
): Promise<{ success: true; moved: number } | { success: false; code: string; conflicts?: number; failed?: number }> {
  const { user, role, supabase } = await getActionAuthContext()

  // Role check
  if (!role || !['admin', 'boss'].includes(role)) {
    throw new Error('Forbidden')
  }

  // Cannot delete self
  if (user.id === userId) {
    return { success: false, code: 'CANNOT_REMOVE_SELF' }
  }

  const choice = readHandoverTarget(handover?.transferTo, userId)
  if (!choice.ok) return { success: false, code: choice.code }
  if (choice.target) {
    try {
      await requireActiveLeadTransferCandidate(
        supabaseAdmin.from('profiles').select('id,role,is_active') as never,
        choice.target,
      )
    } catch {
      return { success: false, code: 'HANDOVER_TARGET_INVALID' }
    }
  }

  let report
  try {
    report = await handOverMemberLeads(supabase, {
      memberId: userId,
      target: choice.target,
      batchKey: handover.batchKey,
      reason: 'member_removed',
    })
  } catch {
    return { success: false, code: 'HANDOVER_FAILED' }
  }
  if (!report.complete) {
    // Nothing is deactivated while a lead is still with the member; the same
    // batch key retried replays the leads already moved.
    return { success: false, code: 'HANDOVER_INCOMPLETE', conflicts: report.conflicts.length, failed: report.failed.length }
  }

  // Contracts follow the chosen receiver. Left in the queue, a contract keeps
  // the salesperson who sold it (it is history, not open work).
  if (choice.target) {
    const { error: contractErr } = await supabaseAdmin
      .from('contracts')
      .update({ sales_id: choice.target })
      .eq('sales_id', userId)
    if (contractErr) return { success: false, code: 'CONTRACT_HANDOVER_FAILED' }
  }

  // Soft-delete: mark as inactive
  const { error: profileErr } = await supabaseAdmin
    .from('profiles')
    .update({ is_active: false })
    .eq('id', userId)

  if (profileErr) throw new Error(profileErr.message)

  const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(
    userId,
    { ban_duration: '876000h' },
  )
  if (authErr) throw new Error(`Failed to revoke auth access: ${authErr.message}`)

  return { success: true, moved: report.moved.length }
}

/**
 * Reset a user's password (admin/boss only).
 */
export async function resetUserPassword(userId: string, password: string) {
  if (!password || password.length < 6) {
    throw new Error('Password must be at least 6 characters')
  }

  // R1 · the caller's role now comes from the same place every other action gets
  // it, through the caller's own client rather than the service key. It used to
  // be read with adminClient, which meant an administrator reset resolved its own
  // authorization with a privilege that bypasses RLS to read a row the caller can
  // read anyway — and it skipped is_active and force_password_change entirely.
  //
  // It also comes first now. The service-role client below used to be built
  // before anything had authenticated the caller, so an unauthenticated, revoked
  // or forced session got a client holding SUPABASE_SERVICE_ROLE_KEY constructed
  // on its behalf before being turned away. Nothing was reachable through it, but
  // "authenticate, then take the privilege" is the order that stays true when the
  // next line is added.
  const { role } = await getActionAuthContext()

  // Role check: only admin/boss
  if (!role || !['admin', 'boss'].includes(role)) {
    throw new Error('Forbidden')
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const { createClient } = await import('@supabase/supabase-js')
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Reset target user's password
  const { error } = await adminClient.auth.admin.updateUserById(userId, { password })
  if (error) throw new Error(error.message)

  // A3 · the same two writes, in the same order, as
  // src/app/api/users/[id]/password/route.ts — this server action is the second
  // administrator reset path and had the same gap. password_changed_at is what the
  // restrictive session policy compares an access token's `iat` against;
  // force_password_change makes the target replace the password the administrator
  // chose. The result of the update was previously not even read, so a failure
  // here was reported to the caller as a successful reset.
  const { error: profileError } = await adminClient
    .from('profiles')
    .update({ password_changed_at: new Date().toISOString(), force_password_change: true })
    .eq('id', userId)

  // R2 · the timestamp failing does not make the revocation optional.
  //
  // This used to `throw` here, before the RPC, and the route did the same with a
  // 500. So the one failure that leaves the target's password already changed by
  // an administrator — and therefore the one where the target's live sessions are
  // most certainly not the target's any more — was also the one failure that
  // skipped the only step that removes them. The two writes are independent: the
  // timestamp is what makes an already-minted access token fail the iat check,
  // and the revocation is what deletes the refresh tokens. Losing the first is a
  // reason to try harder at the second, not to abandon it.
  //
  // Order is unchanged: timestamp first when it works, so the window in which a
  // pre-reset token is still accepted stays as short as it was.
  const { data: revocation, error: revokeError } = await adminClient.rpc('revoke_user_sessions', {
    p_user_id: userId,
    p_reason: 'admin_password_reset',
  })
  const sessionsRevoked =
    !revokeError && (revocation as { verified?: boolean } | null)?.verified === true

  // Fail closed: no verified revocation, no successful reset. See the migration
  // 20260817120000_admin_reset_session_revocation.sql for why an inherited GoTrue
  // side effect is not enough. The unrevoked case is reported first because it is
  // the more dangerous of the two: an unrecorded timestamp with the sessions gone
  // leaves nothing to sign in with, while a recorded timestamp with the sessions
  // intact leaves a refresh token that mints tokens whose iat passes the check.
  if (!sessionsRevoked) {
    throw new Error(
      "Password changed, but the target's existing sessions could not be verifiably revoked; retry or ban the identity in Supabase Auth before relying on this reset",
    )
  }

  if (profileError) {
    throw new Error(
      'Password changed and the existing sessions were revoked, but the revocation timestamp could not be recorded; '
        + 'force_password_change is unset too, so repeat the reset to make the target replace this password',
    )
  }

  return { success: true }
}
