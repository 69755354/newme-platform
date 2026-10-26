// Meta Lead Ads (Instant Form) ingestion: shared by the realtime webhook
// (src/app/api/meta/leadgen-webhook) and the backfill/reconcile script
// (scripts/meta-leads-pull.mjs). Pure helpers plus one storage function that
// takes an injected Supabase client, so every path is unit-testable.
//
// Never logs or returns customer answers; callers only see aggregate outcomes.
import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_LEADGEN_WEBHOOK_BYTES = 256 * 1024;
const LEADGEN_ID = /^[1-9]\d{7,31}$/;
const GRAPH_ID = /^[1-9]\d{4,31}$/;
export const LEAD_FIELDS = [
  "id", "created_time", "ad_id", "ad_name", "adset_id", "adset_name", "campaign_id",
  "campaign_name", "form_id", "platform", "is_organic", "field_data",
].join(",");

export function normalizeMetaId(raw, pattern = GRAPH_ID) {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  if (typeof raw === "number" && !Number.isSafeInteger(raw)) return null;
  const value = String(raw).trim().replace(/^l:/i, "");
  return pattern.test(value) ? value : null;
}

/** Meta signs the raw body with the App Secret (X-Hub-Signature-256). */
export function verifyMetaSignature(bytes, signature, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature ?? "")) return false;
  const expected = createHmac("sha256", secret).update(bytes).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

/**
 * Extract leadgen ids from a Page webhook delivery. Only `leadgen` changes on
 * an allowlisted page are accepted; anything else is ignored, not an error.
 */
export function extractLeadgenNotifications(payload, allowedPageIds) {
  if (payload?.object !== "page" || !Array.isArray(payload.entry)) throw new Error("invalid_leadgen_payload");
  const allowed = new Set([...allowedPageIds].map((id) => normalizeMetaId(id)).filter(Boolean));
  const out = new Map();
  for (const entry of payload.entry) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== "leadgen") continue;
      const value = change.value ?? {};
      const pageId = normalizeMetaId(value.page_id ?? entry?.id);
      const leadgenId = normalizeMetaId(value.leadgen_id, LEADGEN_ID);
      if (!pageId || !leadgenId || !allowed.has(pageId)) continue;
      out.set(leadgenId, {
        leadgen_id: leadgenId,
        page_id: pageId,
        form_id: normalizeMetaId(value.form_id),
        ad_id: normalizeMetaId(value.ad_id),
        created_time: Number.isSafeInteger(value.created_time) ? value.created_time : null,
      });
    }
  }
  return [...out.values()];
}

const clip = (value, max = 200) => {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, max) : null;
};

function answerMap(fieldData) {
  const answers = {};
  for (const field of Array.isArray(fieldData) ? fieldData : []) {
    const name = clip(field?.name, 120);
    if (!name) continue;
    const values = (Array.isArray(field.values) ? field.values : []).map((v) => clip(v, 500)).filter(Boolean);
    if (values.length) answers[name.toLowerCase()] = values.join(", ");
  }
  return answers;
}

const pick = (answers, keys) => {
  for (const key of keys) if (answers[key]) return answers[key];
  return null;
};

function cleanEmail(raw) {
  const value = clip(raw, 254)?.toLowerCase();
  return value && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

function cleanPhone(raw) {
  const value = clip(raw, 40);
  if (!value) return null;
  const compact = value.replace(/[^0-9+]/g, "");
  return /^\+?\d{7,15}$/.test(compact) ? compact : null;
}

/** Map one Graph lead object to a leads-table row. Raw answers kept in raw_import_data. */
export function mapMetaLeadToRow(lead, { formName = null, now = new Date() } = {}) {
  const leadgenId = normalizeMetaId(lead?.id, LEADGEN_ID);
  if (!leadgenId) throw new Error("invalid_lead");
  const answers = answerMap(lead.field_data);
  const first = pick(answers, ["first_name"]);
  const last = pick(answers, ["last_name"]);
  const fullName = pick(answers, ["full_name", "name"]) ?? ([first, last].filter(Boolean).join(" ") || null);
  const created = Date.parse(lead.created_time ?? "");
  const createdAt = Number.isFinite(created) ? new Date(created).toISOString() : now.toISOString();
  const platform = String(lead.platform ?? "").toLowerCase();
  const source = platform === "ig" || platform === "instagram" ? "ins" : "fb";
  const followup = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    meta_leadgen_id: leadgenId,
    source,
    source_platform: platform === "ig" || platform === "instagram" ? "instagram" : "facebook",
    source_channel: "meta_lead_form",
    customer_name: clip(fullName, 200),
    phone: cleanPhone(pick(answers, ["phone_number", "phone", "mobile", "whatsapp_number"])),
    email: cleanEmail(pick(answers, ["email", "work_email"])),
    location: clip(pick(answers, ["city", "area", "location", "community"]), 200),
    form_id: normalizeMetaId(lead.form_id),
    form_name: clip(formName, 200),
    ad_id: normalizeMetaId(lead.ad_id),
    meta_ad_id: normalizeMetaId(lead.ad_id),
    ad_name: clip(lead.ad_name),
    adset_id: normalizeMetaId(lead.adset_id),
    adset_name: clip(lead.adset_name),
    campaign_id: normalizeMetaId(lead.campaign_id),
    campaign_name: clip(lead.campaign_name),
    meta_campaign: clip(lead.campaign_name),
    raw_import_data: { meta_lead_form: { answers, is_organic: lead.is_organic === true } },
    lead_status: "hot",
    next_action: "call",
    next_followup_date: followup,
    first_touch_at: createdAt,
    created_at: createdAt,
  };
}

const ATTRIBUTION_KEYS = ["ad_id", "meta_ad_id", "ad_name", "adset_id", "adset_name", "campaign_id",
  "campaign_name", "meta_campaign", "form_id", "form_name"];

/**
 * Store one mapped lead. Idempotent by meta_leadgen_id:
 *  - already stored            -> "duplicate"
 *  - same phone/email untagged -> tag it, fill empty attribution -> "merged"
 *  - otherwise                 -> insert -> "inserted"
 * The unique partial index on meta_leadgen_id is the final race guard (23505).
 */
export async function storeMetaLead(db, row) {
  const existing = await db.from("leads").select("id").eq("meta_leadgen_id", row.meta_leadgen_id).limit(1);
  if (existing.error) throw new Error("lead_lookup_failed");
  if (existing.data?.length) return { outcome: "duplicate", id: existing.data[0].id };

  const contactFilters = [
    row.email ? `email.eq.${row.email}` : null,
    row.phone ? `phone.eq.${row.phone}` : null,
  ].filter(Boolean);
  if (contactFilters.length) {
    const match = await db.from("leads").select(`id, meta_leadgen_id, ${ATTRIBUTION_KEYS.join(", ")}`)
      .or(contactFilters.join(",")).is("meta_leadgen_id", null).limit(1);
    if (match.error) throw new Error("lead_lookup_failed");
    const target = match.data?.[0];
    if (target) {
      const patch = { meta_leadgen_id: row.meta_leadgen_id, updated_at: new Date().toISOString() };
      for (const key of ATTRIBUTION_KEYS) {
        if (row[key] && !target[key]) patch[key] = row[key];
      }
      const tagged = await db.from("leads").update(patch).eq("id", target.id).is("meta_leadgen_id", null)
        .select("id").maybeSingle();
      if (tagged.error?.code === "23505") return { outcome: "duplicate", id: target.id };
      if (tagged.error) throw new Error("lead_merge_failed");
      if (tagged.data) return { outcome: "merged", id: tagged.data.id };
    }
  }

  const inserted = await db.from("leads").insert(row).select("id").single();
  if (inserted.error?.code === "23505") return { outcome: "duplicate", id: null };
  if (inserted.error) throw new Error("lead_insert_failed");
  return { outcome: "inserted", id: inserted.data.id };
}

export function graphUrl(version, path, params = {}) {
  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  return url;
}

/** GET a Graph object with the token in the Authorization header (never in the URL). */
export async function graphGet(fetchImpl, url, token) {
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const code = body?.error?.code ?? response.status;
    const error = new Error(`graph_error_${code}`);
    error.graphCode = code;
    throw error;
  }
  return body;
}

export async function fetchMetaLead(fetchImpl, { version, token, leadgenId }) {
  const id = normalizeMetaId(leadgenId, LEADGEN_ID);
  if (!id) throw new Error("invalid_lead");
  return graphGet(fetchImpl, graphUrl(version, id, { fields: LEAD_FIELDS }), token);
}
