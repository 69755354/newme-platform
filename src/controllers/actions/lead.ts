"use server";

import { createServerSupabase } from "@/models/supabase-server";

/**
 * Server action: add a quick note to a lead's activities.
 */
export async function addLeadNote(leadId: string, note: string): Promise<boolean> {
  try {
    const supabase = await createServerSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return false;

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
