// S39: a logged contact counts as the first contact. When the lead is still at "new", logging one contact record
// completes the First Contact milestone (default note) and moves the lead to "contacted" through the audited
// transition routine. Nothing here ever fails the contact record itself: every problem comes back as a reason.
import { advanceStageForMilestone } from "./milestone-stage-advance.mjs";
import { addDaysToDateKey, dubaiDateKey } from "./dubai-time.mjs";

export const DEFAULT_NEXT_ACTION = "call";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase the signed-in user's client
 * @param {{ leadId: string, userId: string, now?: Date }} input
 * @returns {Promise<{ advanced: boolean, stage: string | null, reason: string | null, milestone: boolean }>}
 */
export async function completeFirstContactAfterLog(supabase, { leadId, userId, now = new Date() }) {
  try {
    const { data: lead } = await supabase.from("leads")
      .select("stage, final_status, quality, next_action, next_followup_date").eq("id", leadId).single();
    if (!lead || lead.stage !== "new" || lead.final_status === "won" || lead.final_status === "lost") {
      return { advanced: false, stage: lead?.stage ?? null, reason: null, milestone: false };
    }
    let current = lead;
    // The follow-up rule (next action + next follow-up date) stops any stage move; a one-tap log fills the usual
    // defaults (call tomorrow, Dubai date) instead of asking the salesperson.
    if (!current.next_action || !current.next_followup_date) {
      const patch = {
        next_action: current.next_action || DEFAULT_NEXT_ACTION,
        next_followup_date: current.next_followup_date || addDaysToDateKey(dubaiDateKey(now), 1),
      };
      const { error } = await supabase.from("leads").update(patch).eq("id", leadId);
      if (error) return { advanced: false, stage: "new", reason: "next_followup_required", milestone: false };
      current = { ...current, ...patch };
    }
    let milestone = false;
    const { data: existing } = await supabase.from("lead_milestones").select("id, completed_at")
      .eq("lead_id", leadId).eq("milestone_key", "first_contact").maybeSingle();
    if (!existing) {
      const { error } = await supabase.from("lead_milestones").insert({
        lead_id: leadId, milestone_key: "first_contact", completed_by: userId, notes: "Contact logged",
      });
      milestone = !error;
    }
    const result = await advanceStageForMilestone(supabase, {
      leadId, milestoneKey: "first_contact", lead: current, hasCompleteContact: true, note: "Contact logged",
    });
    return { ...result, milestone };
  } catch {
    return { advanced: false, stage: null, reason: "stage_update_failed", milestone: false };
  }
}
