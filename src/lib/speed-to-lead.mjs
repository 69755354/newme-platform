// Speed-to-lead for new Meta instant-form leads (switch NEWME_SPEED_TO_LEAD_ENABLED, default off). Pure helpers: no network, no disk.
//   1. the customer gets one WhatsApp template (newme_enquiry_ack) from the company number;
//   2. the assigned salesperson (or Sam + Tanya when nobody owns the lead) gets one WhatsApp alert: no customer name or phone in the text.
import { normalizePhone } from "./lead-contact.mjs";
import { isCountedLead, leadOutcome } from "./lead-metrics.mjs";
import { isSystemAccount } from "./system-accounts.mjs";
import { leadRef } from "./meta-ids-export.mjs";

export const TEMPLATE_NAME = "newme_enquiry_ack";
export const TEMPLATE_LANGUAGE = "en";
export const MAX_LEAD_AGE_MS = 2 * 3_600_000; // older leads are never contacted by this job
export const SETTLE_MS = 3 * 60_000;          // wait for the dispatch sweep to assign an owner before falling back to "our team" / unassigned
export const MAX_TRIES = 3;
export const ALERT_KEY = "newme-speed-to-lead";
export const SOURCE_CHANNEL = "meta_lead_form";
const text = (v) => (v === null || v === undefined ? "" : String(v).trim());

/** First word, letters only (any script), at most 20 characters; fallback when nothing usable. Safe as a template parameter. */
export function templateFirstName(name, fallback) {
  const word = text(name).split(/\s+/)[0] ?? "";
  const letters = word.replace(/[^\p{L}\p{M}'-]/gu, "").slice(0, 20);
  return letters.length >= 2 ? letters : fallback;
}

/** Digits (no "+") of a customer number that is plausibly real; null for empty, malformed or obvious junk. */
export function customerNumber(raw) {
  const n = normalizePhone(raw);
  if (!n.ok) return null;
  const digits = n.e164.replace(/^\+/, "");
  const national = digits.startsWith("971") ? digits.slice(3) : digits;
  if (/^(\d)\1+$/.test(national) || /(0123456|1234567|2345678|3456789|9876543|8765432)/.test(national) || /(\d)\1{6,}/.test(national)) return null;
  return digits;
}

const clean = (v, max) => text(v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, max);

/**
 * New form leads still worth a first touch. Test records (synthetic source, excluded_test dispatch state), archived,
 * closed, bulk-imported and held leads are left out, and so is anything older than MAX_LEAD_AGE_MS.
 */
export function selectFormLeads(leads, { now = new Date(), excludedTestIds = new Set() } = {}) {
  const out = [];
  for (const lead of leads ?? []) {
    if (lead?.source_channel !== SOURCE_CHANNEL) continue;
    if (!isCountedLead(lead) || excludedTestIds.has(lead.id) || lead.imported_at || lead.hold_since) continue;
    const outcome = leadOutcome(lead);
    if (outcome === "won" || outcome === "lost") continue;
    const created = Date.parse(lead.created_at ?? "");
    if (!Number.isFinite(created)) continue;
    const age = now.getTime() - created;
    if (age < 0 || age > MAX_LEAD_AGE_MS) continue;
    out.push({ lead, age });
  }
  return out.sort((a, b) => a.age - b.age).map((x) => ({ ...x.lead, _age_ms: x.age }));
}

/** Active, non-system salesperson profile of a lead's owner, with the WhatsApp number when valid. */
export function ownerOf(lead, profiles) {
  const p = (profiles ?? []).find((x) => x.id === lead.assigned_to && x.is_active !== false && !isSystemAccount(x));
  if (!p) return null;
  const phone = normalizePhone(p.phone);
  return { id: p.id, first: templateFirstName(p.full_name, ""), number: phone.ok ? phone.e164.replace(/^\+/, "") : null };
}

/** Is the lead ready to be worked this run: it has an owner, or it has waited SETTLE_MS for one. */
export const settled = (lead, owner) => Boolean(owner) || lead._age_ms >= SETTLE_MS;

/** Graph API body for the customer template. */
export function buildTemplateMessage(lead, owner, to) {
  return {
    messaging_product: "whatsapp", to, type: "template",
    template: { name: TEMPLATE_NAME, language: { code: TEMPLATE_LANGUAGE }, components: [{ type: "body", parameters: [
      { type: "text", text: templateFirstName(lead.customer_name, "there") },
      { type: "text", text: owner?.first || "our team" },
    ] }] },
  };
}

/** Salesperson alert, or the unassigned alert for Sam + Tanya. Property type and area only; never the customer's name or phone. */
export function buildSalesAlert(lead, { unassigned = false } = {}) {
  const ref = leadRef(lead.id);
  const type = clean(lead.property_type, 40) || "property type not given";
  const area = clean(lead.area || lead.location, 40);
  const what = `${type}${area ? `, ${area}` : ""}`;
  return unassigned
    ? `New lead ${ref}: ${what} is waiting with no owner yet. Please assign it and call within 5 minutes.`
    : `New lead ${ref}: ${what} — please call within 5 minutes.`;
}

/** Ledger keys: one per lead and kind. */
export const keys = (lead) => ({ ack: `ack:${lead.id}`, owner: `owner:${lead.id}`, unassigned: `unassigned:${lead.id}` });
