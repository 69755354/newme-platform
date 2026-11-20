import { createHash } from "node:crypto";
import { activeContractAmount } from "./whatsapp-capi.mjs";
import { latestQuotationAmount } from "./quote-amount.mjs";

/**
 * Valued events for newme.ae website leads, after the original Lead event:
 *  - quote:    a quotation with an amount was issued (main signal; ads' job ends here)
 *  - purchase: the contract became active (optional secondary signal)
 * Matching data is the already-hashed user_data stored with the Lead event (em/ph/fn/ln/external_id/fbc/fbp),
 * so no customer contact is read or hashed here. IP and user agent are dropped: this happens days after the visit.
 * Idempotent: one outbox row per (website lead, kind) with a deterministic id and event_id; never throws.
 */
export const WEBSITE_VALUED = Object.freeze({
  quote: { eventType: "meta_capi_quote_delivery", eventName: "InitiateCheckout", prefix: "quote" },
  purchase: { eventType: "meta_capi_purchase_delivery", eventName: "Purchase", prefix: "purchase" },
});
const MATCH_KEYS = ["em", "ph", "fn", "ln", "external_id", "fbc", "fbp"];
// Meta rejects a request whose event_time is older than 7 days.
export const WEBSITE_VALUED_MAX_EVENT_AGE_SECONDS = 6 * 86_400;

export function deterministicUuid(text) {
  const b = createHash("sha1").update(`newme-website-valued:${text}`).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function buildWebsiteValuedPayload({ kind, leadEventId, storedUserData, value, currency, eventTime }) {
  const spec = WEBSITE_VALUED[kind];
  if (!spec) throw new Error("Unknown website event kind");
  if (!leadEventId) throw new Error("Missing lead event id");
  if (!Number.isFinite(value) || value <= 0 || !/^[A-Z]{3}$/.test(currency)) throw new Error("Event needs a value and a currency");
  if (!Number.isSafeInteger(eventTime) || eventTime <= 0) throw new Error("Invalid event time");
  const userData = {};
  for (const key of MATCH_KEYS) {
    const v = storedUserData?.[key];
    if (typeof v === "string" && v) userData[key] = v;
    else if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string" && x)) userData[key] = v;
  }
  if (!userData.external_id) throw new Error("No stored matching data");
  return { data: [{
    event_name: spec.eventName, event_time: eventTime, event_id: `${spec.prefix}:${leadEventId}`,
    action_source: "system_generated", user_data: userData,
    custom_data: { currency, value, lead_event_source: "website" },
  }] };
}

/** `attempt(db, row, kind)` tries one delivery (injected: the TS wrapper binds the real sender). */
export async function enqueueWebsiteValuedEvent(db, leadId, kind, { attempt = null, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  try {
    const spec = WEBSITE_VALUED[kind];
    if (!spec) return "skipped";
    const { data: lead, error } = await db.from("leads").select("final_status, raw_import_data").eq("id", leadId).maybeSingle();
    if (error || !lead) return "skipped";
    if (kind === "purchase" && lead.final_status !== "won") return "skipped";
    const raw = lead.raw_import_data;
    if (raw?.intake !== "newme.ae" || typeof raw.event_id !== "string" || !raw.event_id) return "skipped";
    const stored = raw.capi_payload?.data?.[0]?.user_data;
    const amount = kind === "purchase" ? await activeContractAmount(db, leadId) : await latestQuotationAmount(db, leadId);
    if (!stored || !amount) return "skipped";
    const payload = buildWebsiteValuedPayload({ kind, leadEventId: raw.event_id, storedUserData: stored,
      value: amount.value, currency: amount.currency, eventTime: nowSeconds });
    const id = deterministicUuid(`${kind}:${raw.event_id}`);
    const eventData = { status: "pending", attempts: 0, queued_at: new Date(nowSeconds * 1000).toISOString(),
      event_id: payload.data[0].event_id, payload };
    const inserted = await db.from("business_events").insert({
      id, lead_id: leadId, event_type: spec.eventType, description: `Meta CAPI ${spec.eventName} delivery`, event_data: eventData,
    }).select("id").maybeSingle();
    // 23505: already queued for this lead; the retry tool owns it from here.
    if (inserted.error) return "skipped";
    if (attempt) { try { await attempt(db, { id, event_data: eventData }, kind); } catch { /* the retry tool picks it up */ } }
    return "queued";
  } catch {
    return "skipped";
  }
}

export const QUOTE_PROGRESS_KEYS = Object.freeze(["quotation_submitted", "quotation"]);
export const enqueueWebsiteQuoteForProgress = (db, leadId, progressKey, opts) =>
  QUOTE_PROGRESS_KEYS.includes(progressKey) ? enqueueWebsiteValuedEvent(db, leadId, "quote", opts) : Promise.resolve("skipped");

async function leadOf(db, table, id) {
  const { data, error } = await db.from(table).select("lead_id").eq("id", id).maybeSingle();
  return error || !data?.lead_id ? null : data.lead_id;
}
export async function enqueueWebsitePurchaseForContract(db, contractId, opts) {
  try { const l = await leadOf(db, "contracts", contractId); return l ? await enqueueWebsiteValuedEvent(db, l, "purchase", opts) : "skipped"; } catch { return "skipped"; }
}
export async function enqueueWebsitePurchaseForQuotation(db, quotationId, opts) {
  try { const l = await leadOf(db, "quotations", quotationId); return l ? await enqueueWebsiteValuedEvent(db, l, "purchase", opts) : "skipped"; } catch { return "skipped"; }
}
