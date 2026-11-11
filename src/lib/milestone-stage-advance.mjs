// S3 #1 — completing a milestone moves the lead stage forward.
//
// Before this, a salesperson could complete all seven lead-detail milestones
// and the lead stayed in stage "new": nothing connected milestones to
// leads.stage, so the kanban, lists and stage-based numbers never moved.
//
// After the milestone write has succeeded, the milestone route calls this. It
// uses the existing audited routine public.transition_lead_stage() (one step
// per call, compare-and-set on the current stage, idempotency key, audit
// event), so every database rule still applies. The mapping is the one the app
// already reports to Meta (META_CRM_STAGE_EVENTS): a milestone and a stage that
// report the same funnel event are the same business step.
//
// It never fails the milestone save: when a rule says "not yet" (first-contact
// gate, missing next follow-up, terminal lead, someone else moved it, role not
// allowed) it stops and returns a reason the page can show.

import { createHash } from "node:crypto";

export const MILESTONE_STAGE = Object.freeze({
  first_contact: "contacted",
  requirements: "requirement_confirmed",
  solution: "solution_submitted",
  quotation: "quotation_submitted",
});

export const STAGE_ORDER = Object.freeze([
  "new",
  "contacted",
  "requirement_confirmed",
  "solution_submitted",
  "quotation_submitted",
]);

const ASSESSED_QUALITY = new Set(["good", "normal", "poor"]);
const KEY_NAMESPACE = "b6c1f0a4-2d7e-4c39-8a51-3e9f0d2c7b18";

/** Deterministic RFC 4122 v5 key for one (lead, milestone, step), so a retried request replays. */
export function stageStepKey(leadId, milestoneKey, nextStage) {
  const ns = Buffer.from(KEY_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(`${leadId}:${milestoneKey}:${nextStage}`).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The next single stage to move to, or why not.
 * @returns {{ next: string } | { next: null, reason: string | null }}
 */
export function planStageStep({ stage, finalStatus, milestoneKey, quality, hasCompleteContact, nextAction, nextFollowupDate }) {
  const target = MILESTONE_STAGE[milestoneKey];
  if (!target) return { next: null, reason: null };
  if (finalStatus === "won" || finalStatus === "lost" || stage === "won" || stage === "lost") {
    return { next: null, reason: null };
  }
  const current = STAGE_ORDER.indexOf(stage);
  const wanted = STAGE_ORDER.indexOf(target);
  // negotiation / pending_decision are already past; no_answered / fake are off-funnel.
  if (current === -1 || current >= wanted) return { next: null, reason: null };
  if (stage === "new" && (!ASSESSED_QUALITY.has(quality) || !hasCompleteContact)) {
    return { next: null, reason: "first_contact_gate" };
  }
  // trg_enforce_followup rejects any lead update while these are empty.
  if (!nextAction || !nextFollowupDate) return { next: null, reason: "next_followup_required" };
  return { next: STAGE_ORDER[current + 1] };
}

/**
 * Move the lead forward, one audited step per call, until it reaches the stage
 * of the completed milestone. Never throws.
 * @returns {Promise<{ advanced: boolean, stage: string | null, reason: string | null }>}
 */
export async function advanceStageForMilestone(supabase, { leadId, milestoneKey, lead, hasCompleteContact, note }) {
  // The audit note defaults to the milestone wording. A caller that moves the stage for another
  // reason (the quotation route: "Quotation generated <quote_no>") passes its own.
  const auditNote = typeof note === "string" && note.trim() !== "" ? note.trim() : `Milestone completed: ${milestoneKey}`;
  let stage = lead?.stage ?? null;
  let advanced = false;
  for (let guard = 0; guard < STAGE_ORDER.length; guard += 1) {
    const plan = planStageStep({
      stage,
      finalStatus: lead?.final_status ?? null,
      milestoneKey,
      quality: lead?.quality ?? null,
      hasCompleteContact: Boolean(hasCompleteContact),
      nextAction: lead?.next_action ?? null,
      nextFollowupDate: lead?.next_followup_date ?? null,
    });
    if (!plan.next) return { advanced, stage, reason: plan.reason };
    let result;
    try {
      result = await supabase.rpc("transition_lead_stage", {
        p_lead_id: leadId,
        p_expected_stage: stage,
        p_next_stage: plan.next,
        p_note: auditNote,
        p_idempotency_key: stageStepKey(leadId, milestoneKey, plan.next),
      });
    } catch {
      return { advanced, stage, reason: "stage_update_failed" };
    }
    if (result?.error) {
      const message = String(result.error.message ?? "");
      const reason = message.includes("Forbidden") ? "not_permitted"
        : message.includes("concurrently") ? "changed_concurrently"
        : message.includes("Next action") || message.includes("follow") ? "next_followup_required"
        : message.includes("First Contact") || message.includes("first_contact") ? "first_contact_gate"
        : "stage_update_failed";
      return { advanced, stage, reason };
    }
    const committed = result?.data && typeof result.data.stage === "string" ? result.data.stage : plan.next;
    if (committed === stage) return { advanced, stage, reason: null };
    stage = committed;
    advanced = true;
  }
  return { advanced, stage, reason: null };
}
