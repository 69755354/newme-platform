'use server'

import { createServerSupabase } from '@/lib/supabase-server'

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
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  // Fetch user role
  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .single()

  if (profileErr || !profile) throw new Error('Profile not found')

  const userRole = profile.role

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
    p_notes: notes || null,
  })

  if (rpcErr) throw new Error(rpcErr.message || 'Approval RPC failed')

  // Send notification
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const notificationType = action === 'approve' ? 'contract_approved' : 'contract_rejected'

    const { data: contractInfo } = await supabase
      .from('contracts')
      .select('contract_no, sales_id')
      .eq('id', contractId)
      .single()

    await fetch(`${baseUrl}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: notificationType,
        contract_id: contractId,
        contract_no: contractInfo?.contract_no,
        action,
        step: currentStep,
        approver_name: profile.full_name || 'Unknown',
        target_user_id: contractInfo?.sales_id,
      }),
    })
  } catch {
    // Notification failure is non-critical
  }

  return rpcResult
}

/**
 * Revoke a contract (admin/boss only).
 */
export async function revokeContract(contractId: string, reason: string) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  // Verify admin/boss role
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  const isAdminOrBoss = profile?.role && ['admin', 'boss'].includes(profile.role)
  if (!isAdminOrBoss) throw new Error('Only admin or boss can revoke contracts')

  if (!reason || typeof reason !== 'string') {
    throw new Error('reason is required')
  }

  // Fetch the contract
  const { data: contract, error: contractErr } = await supabase
    .from('contracts')
    .select('id, contract_no, status, sales_id')
    .eq('id', contractId)
    .single()

  if (contractErr || !contract) throw new Error('Contract not found')

  if (contract.status === 'superseded') throw new Error('Contract is already superseded')
  if (contract.status === 'revoked') throw new Error('Contract is already revoked')

  const newStatus = 'revoking'

  // Update contract status
  const { error: updateErr } = await supabase
    .from('contracts')
    .update({
      status: newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', contractId)

  if (updateErr) throw new Error('Failed to update contract status')

  // Send notifications
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    await fetch(`${baseUrl}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'contract_revoked',
        contract_id: contractId,
        contract_no: contract.contract_no,
        reason,
        revoked_by: user.id,
      }),
    })
  } catch {
    // Notification failure is non-critical
  }

  return { success: true, contract_id: contractId, status: newStatus }
}
