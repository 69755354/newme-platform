// A saved quotation with an amount is the main signal back to Meta (Quoted: value = the quoted total), on the form,
// WhatsApp and website paths. Both quotation routes (the app's and the Hermes one) use this one function so they
// agree on when it is sent. It is not sent for a lead that is already won / lost (same rule as the Drive sheet sync's
// isFrozenFinal) or archived: a quote typed after the deal is closed must not look like a new quoted lead.
// Best effort: tracking never fails the quotation. `enqueuers` = { form, whatsapp, website }, each (db, leadId, key).
export const QUOTED_PROGRESS_KEY = "quotation_submitted";

export const isFrozenFinalLead = (lead) =>
  ["won", "lost"].includes(lead?.final_status) || ["won", "lost"].includes(lead?.stage);

/** Returns the paths it queued for (empty when skipped). */
export async function enqueueQuotedFeedback(db, leadId, amount, enqueuers) {
  try {
    if (!(Number(amount) > 0)) return [];
    const { data: lead, error } = await db.from("leads").select("stage, final_status, archived").eq("id", leadId).maybeSingle();
    if (error || !lead || isFrozenFinalLead(lead) || lead.archived) return [];
    const queued = [];
    for (const path of ["form", "whatsapp", "website"]) {
      try { await enqueuers[path](db, leadId, QUOTED_PROGRESS_KEY); queued.push(path); } catch { /* one path failing must not stop the others */ }
    }
    return queued;
  } catch {
    return [];
  }
}
