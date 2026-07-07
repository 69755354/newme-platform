'use server'

import { createServerSupabase } from '@/models/supabase-server'

interface CreatePaymentInput {
  contract_id: string
  amount: number
  payment_date: string
  payment_method: string
  reference_no?: string | null
  notes?: string | null
}

interface AllocationItem {
  plan_id: string
  amount: number
}

/**
 * Record a new payment against a contract.
 */
export async function createPayment(data: CreatePaymentInput) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  // Validation
  if (!data.contract_id) throw new Error('contract_id is required')
  if (!data.amount || typeof data.amount !== 'number' || data.amount <= 0) {
    throw new Error('Valid amount is required')
  }
  if (!data.payment_date) throw new Error('payment_date is required')
  if (!data.payment_method) throw new Error('payment_method is required')

  // Verify the contract exists
  const { data: contract, error: contractErr } = await supabase
    .from('contracts')
    .select('id, sales_id')
    .eq('id', data.contract_id)
    .single()

  if (contractErr || !contract) throw new Error('Contract not found')

  // Fetch user role for access control
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  const userRole = profile?.role
  const isPrivileged = userRole && ['admin', 'boss', 'finance', 'operator'].includes(userRole)

  // Sales can only record payments against their own contracts
  if (!isPrivileged && contract.sales_id !== user.id) {
    throw new Error('Forbidden')
  }

  const { data: payment, error: insertErr } = await supabase
    .from('payments')
    .insert({
      contract_id: data.contract_id,
      created_by: user.id,
      amount: data.amount,
      payment_date: data.payment_date,
      payment_method: data.payment_method,
      reference_no: data.reference_no || null,
      confirmed: false,
      notes: data.notes || null,
    })
    .select('id, amount')
    .single()

  if (insertErr) throw new Error('Failed to record payment')

  return { id: payment.id, amount: payment.amount }
}

/**
 * Confirm a payment (admin/boss/finance only).
 */
export async function confirmPayment(paymentId: string) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  // Fetch user role for access control
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile) throw new Error('Profile not found')

  const allowedRoles = ['admin', 'boss', 'finance']
  if (!allowedRoles.includes(profile.role)) throw new Error('Forbidden')

  // Verify the payment exists and is not already confirmed
  const { data: payment, error: paymentErr } = await supabase
    .from('payments')
    .select('id, confirmed')
    .eq('id', paymentId)
    .single()

  if (paymentErr || !payment) throw new Error('Payment not found')
  if (payment.confirmed) throw new Error('Payment is already confirmed')

  // Call the RPC function to confirm the payment with cascading updates
  const { data: result, error: rpcErr } = await supabase.rpc('confirm_payment', {
    p_payment_id: paymentId,
    p_confirmer_id: user.id,
  })

  if (rpcErr) throw new Error(rpcErr.message || 'Failed to confirm payment')

  return { data: result }
}

/**
 * Allocate a confirmed payment to installment plans (admin/boss/finance only).
 */
export async function allocatePayment(paymentId: string, allocations: AllocationItem[]) {
  const supabase = await createServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  // Fetch user role for access control
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile) throw new Error('Profile not found')

  const allowedRoles = ['admin', 'boss', 'finance']
  if (!allowedRoles.includes(profile.role)) throw new Error('Forbidden')

  // Validate allocations
  if (!allocations || !Array.isArray(allocations) || allocations.length === 0) {
    throw new Error('allocations must be a non-empty array of { plan_id, amount }')
  }
  for (const alloc of allocations) {
    if (!alloc.plan_id || typeof alloc.plan_id !== 'string') {
      throw new Error('Each allocation must have a valid plan_id')
    }
    if (!alloc.amount || typeof alloc.amount !== 'number' || alloc.amount <= 0) {
      throw new Error('Each allocation must have a positive amount')
    }
  }

  // Verify the payment exists and is confirmed
  const { data: payment, error: paymentErr } = await supabase
    .from('payments')
    .select('id, confirmed, contract_id')
    .eq('id', paymentId)
    .single()

  if (paymentErr || !payment) throw new Error('Payment not found')
  if (!payment.confirmed) throw new Error('Payment must be confirmed before allocation')

  const planIds = [...new Set(allocations.map((allocation) => allocation.plan_id))]
  const { data: plans, error: plansErr } = await supabase
    .from('installment_plans')
    .select('id, contract_id')
    .in('id', planIds)

  if (
    plansErr ||
    !plans ||
    plans.length !== planIds.length ||
    plans.some((plan) => plan.contract_id !== payment.contract_id)
  ) {
    throw new Error('All allocation plans must belong to the payment contract')
  }

  // Call the RPC function to allocate the payment
  const { data: result, error: rpcErr } = await supabase.rpc('allocate_payment', {
    p_payment_id: paymentId,
    p_allocations: allocations,
    p_allocated_by: user.id,
  })

  if (rpcErr) throw new Error(rpcErr.message || 'Failed to allocate payment')

  return { data: result }
}
