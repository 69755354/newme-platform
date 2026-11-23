// S39: the three big actions at the top of a lead (call, WhatsApp, quick log). Pure helpers, no I/O.
import { phoneMatchKey } from "./lead-contact.mjs";

const ARABIC = /[؀-ۿݐ-ݿ]/;

/**
 * The language to greet this customer in: Arabic when the name is written in Arabic or the lead came through the Arabic
 * site, English otherwise. The salesperson's own interface language never decides this (a Chinese-reading salesperson
 * still writes to the customer in the customer's language).
 * @param {{ customer_name?: string | null, landing_page?: string | null } | null | undefined} lead
 * @returns {"ar" | "en"}
 */
export function leadGreetingLanguage(lead) {
  if (lead?.customer_name && ARABIC.test(lead.customer_name)) return "ar";
  const page = String(lead?.landing_page ?? "");
  if (/^https?:\/\/[^/]*newme\.ae\/ar(\/|$|\?)/i.test(page) || /^\/ar(\/|$|\?)/.test(page)) return "ar";
  return "en";
}

const PLACEHOLDER_NAME = /^(unknown|unnamed|n\/a|-+|—+)$/i;

/**
 * Opening WhatsApp message with the customer's name and the salesperson's name.
 * @param {{ customer_name?: string | null, landing_page?: string | null }} lead
 * @param {string | null | undefined} salespersonName
 */
export function whatsappGreeting(lead, salespersonName) {
  const lang = leadGreetingLanguage(lead);
  const customer = String(lead?.customer_name ?? "").trim();
  const name = customer && !PLACEHOLDER_NAME.test(customer) && !/^\+?\d[\d\s-]{5,}$/.test(customer) ? customer : "";
  const rep = String(salespersonName ?? "").trim();
  if (lang === "ar") {
    return `مرحباً${name ? ` ${name}` : ""}، معك ${rep || "فريق"} من NewMe. شكراً لاهتمامك بنا، متى يناسبك أن نتحدث بخصوص مشروعك؟`;
  }
  return `Hello${name ? ` ${name}` : ""}, this is ${rep || "the team"} from NewMe. Thank you for your enquiry - when is a good time to talk about your project?`;
}

/** https://wa.me/<number>?text=<greeting>, or null when the lead has no readable phone. */
export function whatsappLinkWithGreeting(lead, salespersonName) {
  const key = phoneMatchKey(lead?.phone);
  if (!key) return null;
  return `https://wa.me/${key.slice(1)}?text=${encodeURIComponent(whatsappGreeting(lead, salespersonName))}`;
}

/** The contact methods the quick log offers, in order. */
export const QUICK_LOG_METHODS = Object.freeze(["phone", "whatsapp", "other"]);

/**
 * Body for POST /api/leads/:id/contacts from a one-tap quick log. No result and no time: the route reads them as
 * "Contacted" and "now".
 */
export function quickLogBody(method, note) {
  const contact_method = QUICK_LOG_METHODS.includes(method) ? method : "other";
  const text = String(note ?? "").trim().slice(0, 1000);
  return { contact_method, ...(text ? { summary: text } : {}) };
}
