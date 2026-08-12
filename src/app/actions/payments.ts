'use server'

import { createServerSupabase } from '@/lib/supabase-server'
import type { Json } from '@/types/database'

interface AllocationItem {
  plan_id: string
  amount: number
}

/**
 * Recording a payment is not a server action.
 *
 * There used to be a `createPayment` here, called by the payments dashboard. It
 * inserted into `payments` directly and carried no idempotency key, so the same
 * form submitted twice recorded two payments. Reproduced on an isolated
 * PostgreSQL 17 against this branch's migrations, as the sales identity owning
 * the fixture contract: the same insert twice gave `sqlstate=00000 rows=2`.
 * Under the round-4 payment guard in strict mode that same insert instead raises
 * `22023 a payment must carry request_key, the idempotency key of the creating
 * request` — so the button was heading for two payments today and none later.
 *
 * The single recording boundary is `POST /api/payments`, which requires a
 * caller-minted key, stores it as `payments.request_key`, and is the only place
 * that can tell an honest retry from a key reused for a different payment.
 * Confirming and allocating stay here because they already go through
 * `confirm_payment()` and `allocate_payment()`.
 */

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
  if (!profile.role || !allowedRoles.includes(profile.role)) throw new Error('Forbidden')

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
  if (!profile?.role || !allowedRoles.includes(profile.role)) throw new Error('Forbidden')

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

  // RPC payload must match the generated JSON contract.
  const allocationPayload: Json = allocations.map(({ plan_id, amount }) => ({ plan_id, amount }));
  const { data: result, error: rpcErr } = await supabase.rpc('allocate_payment', {
    p_payment_id: paymentId,
    p_allocations: allocationPayload,
    p_allocated_by: user.id,
  })

  if (rpcErr) throw new Error(rpcErr.message || 'Failed to allocate payment')

  return { data: result }
}
