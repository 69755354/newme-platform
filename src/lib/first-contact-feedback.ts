import { supabaseAdmin } from "@/lib/supabase-admin";
import { enqueueMetaCrmEventForLead } from "@/lib/meta-crm-events";
import { enqueueWebsiteQuoteForProgress, enqueueWhatsAppProgressWithDelivery } from "@/lib/website-capi-valued";

/** Best-effort ad feedback for a First Contact completed by a logged contact. Never throws. */
export async function enqueueFirstContactFeedback(leadId: string): Promise<void> {
  try {
    await enqueueMetaCrmEventForLead(supabaseAdmin, leadId, "first_contact");
    await enqueueWhatsAppProgressWithDelivery(supabaseAdmin, leadId, "first_contact");
    await enqueueWebsiteQuoteForProgress(supabaseAdmin, leadId, "first_contact");
  } catch { /* tracking must never fail a contact record */ }
}
