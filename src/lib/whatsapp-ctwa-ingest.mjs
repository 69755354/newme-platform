// Feeds verified WhatsApp events to the one database writer. Idempotent end to end: a
// replayed webhook, a retry after a partial failure and concurrent deliveries all leave
// one lead per customer phone (see record_whatsapp_ad_event in the S18 migration).
export function organicLeadsEnabled(env = process.env) {
  return env.WHATSAPP_ORGANIC_LEADS_ENABLED !== "false";
}

export function adLeadsEnabled(env = process.env) {
  return env.WHATSAPP_AD_LEADS_ENABLED !== "false";
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
    } catch {
      summary.failed++;
    }
  }
  return summary;
}
