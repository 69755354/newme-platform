// Meta Conversions API for Business Messaging (click-to-WhatsApp ads).
// Mirrors src/lib/meta-crm-events.ts (form leads): one outbox row per (lead, event),
// idempotent enqueue that never throws into a salesperson's action, and a sender that
// reads the server-side token from the environment only.
import { normalizeCtwaClid } from "./whatsapp-ctwa.mjs";
import { latestQuotationAmount } from "./quote-amount.mjs";
import { deterministicUuid, hashedContactKeys } from "./capi-hash.mjs";

export const WA_CAPI_EVENTS = Object.freeze(["LeadSubmitted", "QualifiedLead", "Purchase"]);
// Events that carry the deal amount. InitiateCheckout is the valued "quotation with an amount sent" signal: Meta's
// business-messaging list has no dedicated quote event, and Purchase must stay for the signed deal. It is not in
// WA_CAPI_EVENTS (the queue table's allow-list) so it travels through the business_events outbox instead (no schema change).
export const WA_VALUED_EVENTS = Object.freeze(["InitiateCheckout", "Purchase"]);

// Progress key (pipeline stage or lead-detail milestone) -> Meta event. This follows the form
// funnel in meta-crm-events.ts, where "Qualified" is the optimisation target and is reached at
// requirement_confirmed / requirements; "Contacted" has no business-messaging counterpart and,
// for a customer who wrote to us first, says nothing about quality, so it queues nothing.
// Later funnel steps also queue QualifiedLead (deduplicated) so a lead that skips ahead is
// still reported. "won" is Purchase and is handled with the contract amount.
export const WA_STAGE_EVENTS = Object.freeze({
  requirement_confirmed: "QualifiedLead", requirements: "QualifiedLead",
  solution_submitted: "QualifiedLead", solution: "QualifiedLead",
  quotation_submitted: "QualifiedLead", quotation: "QualifiedLead",
  negotiation: "QualifiedLead", pending_decision: "QualifiedLead", meeting: "QualifiedLead",
});

export const WA_CAPI_EVENT_MAX_AGE_SECONDS = 7 * 86_400;
const WABA_ID = /^[0-9]{5,32}$/;

export function buildWhatsAppCapiPayload({ eventId, wabaId, ctwaClid, eventName, eventTime, value = null, currency = null, hashedPhone = null }) {
  if (!WA_CAPI_EVENTS.includes(eventName) && !WA_VALUED_EVENTS.includes(eventName)) throw new Error("Invalid WhatsApp event name");
  if (typeof wabaId !== "string" || !WABA_ID.test(wabaId)) throw new Error("Invalid WhatsApp business account id");
  const clid = normalizeCtwaClid(ctwaClid);
  if (!clid) throw new Error("Invalid click id");
  if (!Number.isSafeInteger(eventTime) || eventTime <= 0) throw new Error("Invalid event time");
  const event = {
    event_name: eventName,
    event_time: eventTime,
    action_source: "business_messaging",
    messaging_channel: "whatsapp",
    user_data: { whatsapp_business_account_id: wabaId, ctwa_clid: clid },
  };
  if (typeof eventId === "string" && eventId) event.event_id = eventId;
  // Optional SHA-256 phone hash (see hashedContactKeys); anything else is ignored, never sent in clear.
  if (Array.isArray(hashedPhone) && hashedPhone.length && hashedPhone.every((h) => /^[0-9a-f]{64}$/.test(h))) event.user_data.ph = hashedPhone;
  if (WA_VALUED_EVENTS.includes(eventName)) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0 || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
      throw new Error("A valued event needs a value and a currency");
    }
    event.custom_data = { currency, value: amount };
  }
  return { data: [event] };
}

/** Sends one payload with the server-side token. The token is never logged. */
export async function sendWhatsAppCapiPayload(payload, { env = process.env, fetchImpl = fetch } = {}) {
  const datasetId = env.META_WA_DATASET_ID;
  // Own key for the WhatsApp dataset: the shared name also holds the website pixel key, and whichever env file loads last
  // would otherwise win (2026-11-21: the WhatsApp key overrode the pixel key for the CRM sender).
  const accessToken = env.META_WA_CAPI_ACCESS_TOKEN || env.META_CAPI_ACCESS_TOKEN;
  if (!datasetId || !accessToken) throw new Error("WhatsApp CAPI configuration is unavailable");
  const graphVersion = env.META_GRAPH_API_VERSION || "v25.0";
  const endpoint = new URL(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(datasetId)}/events`);
  let result;
  try {
    result = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error("WhatsApp CAPI transport failed");
  }
  if (!result.ok) throw new Error(`WhatsApp CAPI returned ${result.status}`);
  let receipt;
  try { receipt = await result.json(); } catch { throw new Error("WhatsApp CAPI returned an invalid receipt"); }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || "error" in receipt
    || receipt.events_received !== payload.data.length) {
    throw new Error("WhatsApp CAPI did not acknowledge every event");
  }
}

/**
 * Queue one event for a lead that carries a click id. Idempotent per (lead, event); never throws.
 * The waba id comes from the lead's conversation, the click id from the lead (first click).
 */
export async function enqueueWhatsAppCapiEvent(db, leadId, eventName, { value = null, currency = null,
  nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  try {
    if (!WA_CAPI_EVENTS.includes(eventName)) return "skipped";
    const lead = await db.from("leads").select("ctwa_clid").eq("id", leadId).maybeSingle();
    const clid = normalizeCtwaClid(lead?.data?.ctwa_clid);
    if (lead?.error || !clid) return "skipped";
    const conversation = await db.from("whatsapp_conversations").select("waba_id")
      .eq("lead_id", leadId).eq("first_ctwa_clid", clid).limit(1).maybeSingle();
    const waba = conversation?.data?.waba_id;
    if (conversation?.error || typeof waba !== "string" || !WABA_ID.test(waba)) return "skipped";
    const row = { lead_id: leadId, waba_id: waba, ctwa_clid: clid, event_name: eventName, event_time: nowSeconds };
    if (WA_VALUED_EVENTS.includes(eventName)) {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount <= 0 || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return "skipped";
      row.value = amount;
      row.currency = currency;
    }
    const { error } = await db.from("whatsapp_capi_events")
      .upsert(row, { onConflict: "lead_id,event_name", ignoreDuplicates: true });
    return error ? "skipped" : "queued";
  } catch {
    return "skipped";
  }
}

/** Stage or milestone key -> event (QualifiedLead from requirement_confirmed on). */
export async function enqueueWhatsAppCapiForProgress(db, leadId, progressKey, opts = {}) {
  const eventName = WA_STAGE_EVENTS[progressKey];
  const result = eventName ? await enqueueWhatsAppCapiEvent(db, leadId, eventName) : "skipped";
  // The quotation step also reports the quoted amount (main signal); skipped while there is no amount yet.
  if (progressKey === "quotation_submitted" || progressKey === "quotation") await enqueueWhatsAppQuoteForLead(db, leadId, opts);
  return result;
}

export const WA_QUOTE_OUTBOX_TYPE = "meta_capi_lead_delivery";

/**
 * Quotation with an amount sent: valued InitiateCheckout for a click-to-WhatsApp lead, via the business_events outbox
 * (one row per lead, deterministic id). `attempt(db, row)` tries one delivery now; the retry tool owns it afterwards.
 */
export async function enqueueWhatsAppQuoteForLead(db, leadId, { attempt = /** @type {Function | null} */ (null), env = process.env,
  nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  try {
    const lead = await db.from("leads").select("ctwa_clid, phone").eq("id", leadId).maybeSingle();
    const clid = normalizeCtwaClid(lead?.data?.ctwa_clid);
    if (lead?.error || !clid) return "skipped";
    const conversation = await db.from("whatsapp_conversations").select("waba_id")
      .eq("lead_id", leadId).eq("first_ctwa_clid", clid).limit(1).maybeSingle();
    const waba = conversation?.data?.waba_id;
    if (conversation?.error || typeof waba !== "string" || !WABA_ID.test(waba)) return "skipped";
    const amount = await latestQuotationAmount(db, leadId);
    if (!amount) return "skipped";
    const eventId = `wa-quote:${leadId}`;
    const hashedPhone = env.WA_CAPI_SEND_HASHED_PHONE === "true" ? hashedContactKeys({ phone: lead.data.phone }).ph ?? null : null;
    const payload = buildWhatsAppCapiPayload({ eventId, wabaId: waba, ctwaClid: clid, eventName: "InitiateCheckout",
      eventTime: nowSeconds, value: amount.value, currency: amount.currency, hashedPhone });
    const id = deterministicUuid(eventId);
    const eventData = { status: "pending", attempts: 0, queued_at: new Date(nowSeconds * 1000).toISOString(), event_id: eventId, payload };
    const inserted = await db.from("business_events").insert({ id, lead_id: leadId, event_type: WA_QUOTE_OUTBOX_TYPE,
      description: "Meta CAPI WhatsApp InitiateCheckout delivery", event_data: eventData }).select("id").maybeSingle();
    if (inserted.error) return "skipped"; // 23505: already queued for this lead
    if (attempt) { try { await attempt(db, { id, event_data: eventData }); } catch { /* the retry tool picks it up */ } }
    return "queued";
  } catch {
    return "skipped";
  }
}

/** A lead whose quality is rated good or normal is a qualified lead. */
export async function enqueueWhatsAppCapiForQuality(db, leadId, quality) {
  return quality === "good" || quality === "normal" ? enqueueWhatsAppCapiEvent(db, leadId, "QualifiedLead") : "skipped";
}

export async function activeContractAmount(db, leadId) {
  const { data, error } = await db.from("contracts").select("contract_amount, currency")
    .eq("lead_id", leadId).eq("status", "active").order("created_at", { ascending: false }).limit(1);
  const row = Array.isArray(data) ? data[0] : null;
  if (error || !row) return null;
  const value = Number(row.contract_amount);
  return Number.isFinite(value) && value > 0 ? { value, currency: typeof row.currency === "string" && /^[A-Za-z]{3}$/.test(row.currency) ? row.currency.toUpperCase() : "AED" } : null;
}

/** Purchase once the lead is committed as won; the value is the active contract's amount. */
export async function enqueueWhatsAppPurchaseForLead(db, leadId) {
  try {
    const { data: lead, error } = await db.from("leads").select("final_status").eq("id", leadId).maybeSingle();
    if (error || lead?.final_status !== "won") return "skipped";
    const amount = await activeContractAmount(db, leadId);
    return amount ? await enqueueWhatsAppCapiEvent(db, leadId, "Purchase", amount) : "skipped";
  } catch {
    return "skipped";
  }
}

export async function enqueueWhatsAppPurchaseForContract(db, contractId) {
  try {
    const { data, error } = await db.from("contracts").select("lead_id").eq("id", contractId).maybeSingle();
    return error || !data?.lead_id ? "skipped" : await enqueueWhatsAppPurchaseForLead(db, data.lead_id);
  } catch {
    return "skipped";
  }
}

export async function enqueueWhatsAppPurchaseForQuotation(db, quotationId) {
  try {
    const { data, error } = await db.from("quotations").select("lead_id").eq("id", quotationId).maybeSingle();
    return error || !data?.lead_id ? "skipped" : await enqueueWhatsAppPurchaseForLead(db, data.lead_id);
  } catch {
    return "skipped";
  }
}
