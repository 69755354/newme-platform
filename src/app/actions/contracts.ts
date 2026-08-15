'use server'

import { getActionAuthContext } from '@/lib/action-auth-context'
import { dispatchPersistedNotification } from '@/lib/notification-dispatch'

/**
 * Approve or reject a contract via the two-step approval workflow.
 *
 * Steps:
 *   admin_review — only admin / operator
 *   ceo_review   — only boss
 */
export async function approveContract(
  contractId: string,
  action: 'approve' | 'reject',
  notes?: string
) {
  const { supabase, user, role: userRole } = await getActionAuthContext()

  if (!userRole) throw new Error('Profile role not found')

  if (!action || !['approve', 'reject'].includes(action)) {
    throw new Error("action must be 'approve' or 'reject'")
  }

  // Fetch the pending approval record
  const { data: pendingApproval, error: approvalFetchErr } = await supabase
    .from('contract_approvals')
    .select('id, step, status')
    .eq('contract_id', contractId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (approvalFetchErr) throw new Error('Failed to determine approval step')
  if (!pendingApproval) throw new Error('No pending approval found for this contract')

  const currentStep = pendingApproval.step as string

  // Role-based access control
  if (currentStep === 'admin_review') {
    if (!['admin', 'operator'].includes(userRole)) {
      throw new Error('Only admin or operator can approve the admin_review step')
    }
  } else if (currentStep === 'ceo_review') {
    if (userRole !== 'boss') {
      throw new Error('Only boss can approve the ceo_review step')
    }
  } else {
    throw new Error(`Unknown approval step: ${currentStep}`)
  }

  // Call RPC
  const { data: rpcResult, error: rpcErr } = await supabase.rpc('approve_contract', {
    p_contract_id: contractId,
    p_approver_id: user.id,
    p_action: action,
    p_notes: notes || undefined,
  })

  if (rpcErr) throw new Error(rpcErr.message || 'Approval RPC failed')

  // Dispatch from the committed approval row; no loopback HTTP request or
  // caller-supplied recipient/copy is involved.
  try {
    const notificationType = action === 'approve' ? 'contract_approved' : 'contract_rejected'
    await dispatchPersistedNotification({
      actorId: user.id,
      input: {
        type: notificationType,
        contract_id: contractId,
      },
    })
  } catch (error) {
    console.error('contract_notification_failed', error instanceof Error ? error.message : 'unknown_error')
    // Notification failure is non-critical
  }

  return rpcResult
}

/**
 * Revocation is not a server action.
 *
 * There used to be a revokeContract() here that read the caller's role from
 * profiles and then issued `update contracts set status = 'revoking'` through the
 * caller's own client. Both halves were wrong in a way a replay on PG17 shows
 * rather than argues:
 *
 *   compat mode — the update succeeds, so the contract moves without
 *     revoke_contract()'s transition check or its `for update`; and the same
 *     statement from a *sales* session succeeds too (00000, status -> revoking),
 *     because the admin/boss rule existed only in this file's separate SELECT and
 *     never in the database. Anything that reached the table another way — a
 *     second call site, a script, a crafted request — was unauthorized.
 *   strict mode — trg_guard_contracts_write refuses it with 42501, so the
 *     contracts-list Revoke button could not revoke at all.
 *
 * The supported path is POST /api/contracts/[id]/revoke, which calls
 * revoke_contract(): it takes the row FOR UPDATE, resolves the actor from the
 * JWT subject and checks admin/boss inside the same transaction as the write.
 * Both the contracts list and the contract detail page use it.
 * tests/security/contract-revoke-boundary.test.mjs keeps this file free of
 * contract-status writes.
 */
