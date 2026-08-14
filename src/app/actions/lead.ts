"use server";

import { getActionAuthContext } from "@/lib/action-auth-context";

/**
 * Server action: add a quick note to a lead's activities.
 *
 * R1 · the refusals from getActionAuthContext() land in the existing catch, so a
 * forced, revoked or unauthenticated session gets `false` and writes nothing —
 * the same answer this action already gave for "no user".
 */
export async function addLeadNote(leadId: string, note: string): Promise<boolean> {
  try {
    const { supabase, user } = await getActionAuthContext();

    await supabase.from("activities").insert({
      lead_id: leadId,
      type: "note",
      content: note,
      user_id: user.id,
    });

    return true;
  } catch {
    return false;
  }
}
