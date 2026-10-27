'use server'

import { getActionAuthContext } from '@/lib/action-auth-context'
import {
  classifyLeadReassignResult,
  deriveLeadTransferKey,
  isLeadTransferConflict,
  isLeadUpdatedAtToken,
  LEAD_TRANSFER_BATCH_KEY_PATTERN,
} from '@/lib/lead-transfer-batch.mjs'

/**
 * The lead-assignment actions behind the settings screen.
 *
 * Round-4 finding R6. All four of these used to write leads.assigned_to directly
 * through the caller's own client:
 *
 *     supabase.from('leads').update({ assigned_to: userId }).eq('id', leadId)
 *
 * That statement is reachable because policy_leads_update_admin has no WITH
 * CHECK clause and its USING clause tests the *actor* — an admin, boss or
 * operator — rather than the row, so reusing it as the check lets those roles
 * write any column of any lead. Three things followed:
 *
 *   * No compare-and-set. The operator picked a lead off a list, and by the time
 *     the write landed somebody else may have moved it; the write won anyway and
 *     nobody was told.
 *   * No audit trail. public.transfer_history, activities, business_events and
 *     the new owner's notification are written by public.reassign_lead_atomic()
 *     and by nothing else. Leads moved from this screen moved with no record of
 *     who moved them or where they came from.
 *   * No eligibility check beyond the enforce_active_lead_transfer_candidate
 *     trigger, so 'finance' and other non-sales roles were only blocked by that
 *     trigger's role list rather than by the routine's.
 *
 * Every action now goes through an audited routine, one lead at a time, with the
 * token the caller compared against and an idempotency key derived from the
 * caller's batch key. Assignments use reassign_lead_atomic(); unassignments use
 * unassign_lead_atomic(), whose separate audit contract does not require a
 * transfer_history.to_user_id value.
 *
 * What makes any of this real is the trigger in
 * supabase/migrations/20260817180000_leads_updated_at_is_server_owned.sql: before
 * it, leads.updated_at was written only by writers that named it, so a token read
 * before a direct write still matched after it and every comparison here would
 * have passed. supabase/replay/23_lead_assignment_cas.sh measures both
 * directions on PG 17.
 *
 * Instead of throwing on the first problem, these return a report. A bulk action
 * over 50 leads has 50 independent outcomes, and Next.js redacts a thrown
 * server-action message in production, so throwing would tell the operator
 * neither how many leads moved nor which ones did not.
 */

/** One lead and the updated_at the caller decided against. */
export interface LeadTransferTarget {
  id: string
  expectedUpdatedAt: string
}

export interface LeadTransferReport {
  /** Moved now, with the updated_at the routine left behind. */
  transferred: { id: string; updatedAt: string | null }[]
  /** This batch key already moved the lead on an earlier attempt. */
  replayed: string[]
  /** Already where the caller wanted it; nothing was written. */
  unchanged: string[]
  /** Refused: the lead changed after the caller read it. */
  conflicts: string[]
  /** Anything else, with the reason, per lead. */
  failed: { id: string; message: string }[]
}

const ASSIGNING_ROLES = ['admin', 'boss', 'operator']

function emptyReport(): LeadTransferReport {
  return { transferred: [], replayed: [], unchanged: [], conflicts: [], failed: [] }
}

function requireBatchKey(batchKey: string) {
  if (!LEAD_TRANSFER_BATCH_KEY_PATTERN.test(batchKey)) {
    // Minting one here would give every retry a fresh key, which is the defect
    // the key exists to close. The caller owns it; a caller without one is a bug.
    throw new Error('batchKey must be a UUID')
  }
}

/**
 * Send one lead through reassign_lead_atomic() and fold the answer into a report.
 *
 * `p_reason` is the audit reason the routine stores in transfer_history and in
 * the business event, so it names the screen the decision came from.
 */
async function transferOne(
  supabase: Awaited<ReturnType<typeof getActionAuthContext>>['supabase'],
  report: LeadTransferReport,
  target: LeadTransferTarget,
  toUserId: string,
  batchKey: string,
  reason: string,
) {
  if (!isLeadUpdatedAtToken(target.expectedUpdatedAt)) {
    report.failed.push({ id: target.id, message: 'missing expectedUpdatedAt' })
    return
  }
  const { data, error } = await supabase.rpc('reassign_lead_atomic', {
    p_lead_id: target.id,
    p_new_assignee: toUserId,
    p_expected_updated_at: target.expectedUpdatedAt,
    p_idempotency_key: deriveLeadTransferKey(batchKey, target.id),
    p_reason: reason,
  })
  if (error) {
    if (isLeadTransferConflict(error)) report.conflicts.push(target.id)
    else report.failed.push({ id: target.id, message: error.message })
    return
  }
  const row = (data ?? {}) as { updated_at?: string | null }
  switch (classifyLeadReassignResult(data)) {
    case 'replayed':
      report.replayed.push(target.id)
      break
    case 'unchanged':
      report.unchanged.push(target.id)
      break
    default:
      report.transferred.push({ id: target.id, updatedAt: row.updated_at ?? null })
  }
}

/**
 * Assign a single lead to a user.
 *
 * `expectedUpdatedAt` is the updated_at of the row the operator was looking at,
 * so a lead that moved between the page load and the click is refused rather
 * than overwritten.
 */
export async function assignLead(
  leadId: string,
  userId: string,
  expectedUpdatedAt: string,
  batchKey: string,
): Promise<LeadTransferReport> {
  const { supabase, role } = await getActionAuthContext()

  if (!role || !ASSIGNING_ROLES.includes(role)) {
    throw new Error('Forbidden')
  }
  requireBatchKey(batchKey)

  const report = emptyReport()
  await transferOne(
    supabase,
    report,
    { id: leadId, expectedUpdatedAt },
    userId,
    batchKey,
    'settings_assign',
  )
  return report
}

/**
 * Bulk assign multiple leads to a user.
 *
 * The batching that used to be here (50 ids per `in` clause) is gone with the
 * statement it batched: each lead is now its own audited transaction, because
 * transfer_history needs the previous owner of each row and one `in` clause
 * cannot produce that.
 */
export async function bulkAssignLeads(
  leads: LeadTransferTarget[],
  targetUserId: string,
  batchKey: string,
): Promise<LeadTransferReport> {
  const { supabase, role } = await getActionAuthContext()

  if (!role || !ASSIGNING_ROLES.includes(role)) {
    throw new Error('Forbidden')
  }
  requireBatchKey(batchKey)

  const report = emptyReport()
  for (const target of leads) {
    await transferOne(supabase, report, target, targetUserId, batchKey, 'settings_bulk_assign')
  }
  return report
}

/**
 * Bulk unassign multiple leads.
 *
 * Unassignment is not represented as a transfer: reassign_lead_atomic() rejects
 * a null assignee and transfer_history.to_user_id is NOT NULL. The dedicated
 * unassign_lead_atomic() routine instead owns its compare-and-set, idempotency,
 * activity, business-event and audit-log writes in one transaction.
 */
export async function bulkUnassignLeads(
  leads: LeadTransferTarget[],
  batchKey: string,
): Promise<LeadTransferReport> {
  const { supabase, role } = await getActionAuthContext()

  if (!role || !ASSIGNING_ROLES.includes(role)) {
    throw new Error('Forbidden')
  }
  requireBatchKey(batchKey)

  const report = emptyReport()
  for (const target of leads) {
    if (!isLeadUpdatedAtToken(target.expectedUpdatedAt)) {
      report.failed.push({ id: target.id, message: 'missing expectedUpdatedAt' })
      continue
    }
    const { data, error } = await supabase.rpc('unassign_lead_atomic', {
      p_lead_id: target.id,
      p_expected_updated_at: target.expectedUpdatedAt,
      p_idempotency_key: deriveLeadTransferKey(batchKey, target.id),
      p_reason: 'settings_bulk_unassign',
    })

    if (error) {
      if (isLeadTransferConflict(error)) report.conflicts.push(target.id)
      else report.failed.push({ id: target.id, message: error.message })
      continue
    }
    const row = (data ?? {}) as { updated_at?: string | null }
    switch (classifyLeadReassignResult(data)) {
      case 'replayed':
        report.replayed.push(target.id)
        break
      case 'unchanged':
        report.unchanged.push(target.id)
        break
      default:
        report.transferred.push({ id: target.id, updatedAt: row.updated_at ?? null })
    }
  }
  return report
}

/**
 * Transfer all leads from one user to another.
 *
 * The lead set is enumerated here rather than supplied by the caller, because
 * "all of A's leads" means the ones A holds when this runs, not the ones a screen
 * happened to list. Each lead's token is therefore read in this request, so the
 * compare-and-set protects against a write that interleaves with this loop — it
 * cannot protect against a decision made from a stale screen, and the caller
 * never made a per-lead decision to be stale about.
 */
export async function transferAllLeads(
  fromUserId: string,
  toUserId: string,
  batchKey: string,
): Promise<LeadTransferReport> {
  const { supabase, role } = await getActionAuthContext()

  if (!role || !ASSIGNING_ROLES.includes(role)) {
    throw new Error('Forbidden')
  }
  requireBatchKey(batchKey)

  const { data: owned, error } = await supabase
    .from('leads')
    .select('id, updated_at')
    .eq('assigned_to', fromUserId)
  if (error) throw new Error(error.message)

  const report = emptyReport()
  for (const lead of owned ?? []) {
    await transferOne(
      supabase,
      report,
      { id: lead.id, expectedUpdatedAt: lead.updated_at as string },
      toUserId,
      batchKey,
      'settings_transfer_all',
    )
  }
  return report
}
