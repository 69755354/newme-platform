// Feeds verified WhatsApp events to the one database writer. Idempotent end to end: a
// replayed webhook, a retry after a partial failure and concurrent deliveries all leave
// one lead per customer phone (see record_whatsapp_ad_event in the S18 migration).
import { notifyNewLead } from "./lead-intake-notify.mjs";

export function organicLeadsEnabled(env = process.env) {
  return env.WHATSAPP_ORGANIC_LEADS_ENABLED !== "false";
}

export function adLeadsEnabled(env = process.env) {
  return env.WHATSAPP_AD_LEADS_ENABLED !== "false";
}

// S35: tell the dispatchers about a lead this message just created. A replayed delivery (duplicate) repairs a lost
// notification for a lead that is still unassigned; the per-person event key keeps it to one notification. Never throws.
async function pingNewLead(db, result) {
  try {
    if (!result?.lead_id || !(result.lead_created || result.duplicate)) return true;
    const { data: lead, error } = await db.from("leads").select("id, customer_name, assigned_to, created_at").eq("id", result.lead_id).maybeSingle();
    if (error || !lead) return false;
    if (!result.lead_created && lead.assigned_to) return true;
    await notifyNewLead(db, lead);
    return true;
  } catch {
    return false;
  }
}

export async function recordWhatsAppAdEvents(db, events, { createOrganic = true } = {}) {
  const summary = { recorded: 0, duplicate: 0, leads_created: 0, attributed: 0, queued: 0, failed: 0 };
  for (const event of events) {
    try {
      const { data, error } = await db.rpc("record_whatsapp_ad_event", { p_event: event, p_create_organic: createOrganic });
      if (error) throw new Error("rpc_failed");
      summary.recorded++;
      if (data?.duplicate) summary.duplicate++;
      if (data?.lead_created) summary.leads_created++;
      if (data?.attributed) summary.attributed++;
      if (data?.queued) summary.queued++;
      if (!(await pingNewLead(db, data))) summary.notify_failed = (summary.notify_failed ?? 0) + 1;
    } catch {
      summary.failed++;
    }
  }
  return summary;
}
