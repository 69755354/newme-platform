'use server'

import { revalidatePath } from 'next/cache'
import { getActionAuthContext } from '@/lib/action-auth-context'
import { isVoided } from '@/lib/payment-state.mjs'
import type { Json } from '@/types/database'

/**
 * The pages whose server-rendered totals a settlement changes.
 *
 * Round-4 B8, the cache half: POST /api/payments/[id]/void revalidated these three
 * and the two settlement actions revalidated nothing, so confirming a payment
 * moved projects.paid_amount, kpi_targets.actual_amount and
 * contracts.first_payment_status in the database while a previously-visited
 * /contracts or /dashboard kept rendering the figures from before the write.
 * Allocation is the same story: it is the writer that decides
 * first_payment_status, per 20260817000000 §12.
 *
 * The payments dashboard itself re-fetches /api/payments/list after every write and
 * that route is force-dynamic and no-store, so it is never the stale one.
 */
const SETTLEMENT_PATHS = ['/contracts', '/payments', '/dashboard']

function revalidateSettlementPaths() {
  for (const path of SETTLEMENT_PATHS) revalidatePath(path)
}

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
  const { supabase, user, role } = await getActionAuthContext()

  const allowedRoles = ['admin', 'boss', 'finance']
  if (!role || !allowedRoles.includes(role)) throw new Error('Forbidden')

  // Verify the payment exists, is not reversed, and is not already confirmed.
  //
  // R5: `select('id, confirmed')` gave this precheck no column with which to see a
  // reversal, and void_payment() clears `confirmed` — so a voided payment passed the
  // check and confirm_payment() refused it with 22023 'a voided payment cannot be
  // confirmed'. The message the operator saw was that raw SQLSTATE text, one
  // round-trip later. voided_at is tested first because a reversal is terminal: a row
  // carrying both voided_at and confirmed = true (representable only through a
  // compat-mode direct write) is reversed money, not confirmed money.
  const { data: payment, error: paymentErr } = await supabase
    .from('payments')
    .select('id, confirmed, voided_at')
    .eq('id', paymentId)
    .single()

  if (paymentErr || !payment) throw new Error('Payment not found')
  // The routine's own wording, so the toast reads the same whether the precheck or
  // the database refused it.
  if (isVoided(payment)) throw new Error('a voided payment cannot be confirmed')
  if (payment.confirmed) throw new Error('payment is already confirmed')

  // Call the RPC function to confirm the payment with cascading updates
  const { data: result, error: rpcErr } = await supabase.rpc('confirm_payment', {
    p_payment_id: paymentId,
    p_confirmer_id: user.id,
  })

  if (rpcErr) throw new Error(rpcErr.message || 'Failed to confirm payment')

  revalidateSettlementPaths()
  return { data: result }
}

/**
 * Allocate a confirmed payment to installment plans (admin/boss/finance only).
 */
export async function allocatePayment(paymentId: string, allocations: AllocationItem[]) {
  const { supabase, user, role } = await getActionAuthContext()

  const allowedRoles = ['admin', 'boss', 'finance']
  if (!role || !allowedRoles.includes(role)) throw new Error('Forbidden')

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

  // Verify the payment exists and can still be allocated.
  //
  // R5: with only `confirmed` selected, every reversed payment was refused with
  // "Payment must be confirmed before allocation" — true, because void_payment()
  // clears the flag, and useless, because confirming it is exactly what
  // confirm_payment() refuses for a voided payment. That pair of messages is a loop
  // with no exit. Testing voided_at first names the terminal state instead, and also
  // covers the row a compat-mode direct write can leave carrying both voided_at and
  // confirmed = true, which allocate_payment()'s own guard order reports as
  // unconfirmed.
  const { data: payment, error: paymentErr } = await supabase
    .from('payments')
    .select('id, confirmed, voided_at, contract_id')
    .eq('id', paymentId)
    .single()

  if (paymentErr || !payment) throw new Error('Payment not found')
  if (isVoided(payment)) throw new Error('a voided payment cannot be allocated')
  if (!payment.confirmed) throw new Error('payment must be confirmed before allocation')

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

  revalidateSettlementPaths()
  return { data: result }
}
