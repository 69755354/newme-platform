// Display helpers for the click-to-WhatsApp panel on the lead page and the list filter.
export const WHATSAPP_AD_FILTER = "whatsapp_ad";

/** A lead came from a click-to-WhatsApp ad: it carries the click id or was created as one. */
export function isWhatsAppAdLead(lead) {
  return Boolean(lead && (lead.ctwa_clid || lead.source_channel === "whatsapp_ctwa"));
}

/** A lead created by an unprompted WhatsApp message (no ad referral). */
export function isWhatsAppDirectLead(lead) {
  return Boolean(lead && !isWhatsAppAdLead(lead) && lead.source_channel === "whatsapp_direct");
}

/** Seconds between the first customer message and our first reply; null until both exist. */
export function firstResponseSeconds(firstInboundAt, firstReplyAt) {
  const a = Date.parse(firstInboundAt ?? "");
  const b = Date.parse(firstReplyAt ?? "");
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 1000) : null;
}

/** Parts for a localised duration: { unit: "minutes" | "hours" | "days", n }. */
export function durationParts(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 3600) return { unit: "minutes", n: Math.max(1, Math.round(seconds / 60)) };
  if (seconds < 86_400) return { unit: "hours", n: Math.round(seconds / 360) / 10 };
  return { unit: "days", n: Math.round(seconds / 8640) / 10 };
}
