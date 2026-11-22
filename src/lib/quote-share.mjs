// "Send the quotation to the customer" is honest: it opens WhatsApp with the message already typed (the salesperson
// presses send there), or copies the same text when the lead has no usable phone. Nothing here sends anything itself.

/** Digits for a wa.me link from a stored phone: UAE local 05xxxxxxxx becomes 9715xxxxxxxx; null when unusable. */
export function whatsappDigits(phone) {
  let digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.length === 10 && digits.startsWith("0")) digits = `971${digits.slice(1)}`;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function money(total, currency) {
  const n = Number(total);
  const text = Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(total);
  return `${currency || "AED"} ${text}`;
}

export function buildQuoteShareText({ lang = "zh", customerName = "", quoteNo = "", total = 0, currency = "AED", validUntil = "" } = {}) {
  const name = String(customerName || "").trim();
  if (lang === "en") {
    return [
      name ? `Dear ${name},` : "Hello,",
      `Here is your NewMe smart home quotation${quoteNo ? ` #${quoteNo}` : ""}: ${money(total, currency)} (incl. VAT where applicable).`,
      validUntil ? `Valid until ${validUntil}.` : "",
      "Please reply here if you would like to adjust anything or go ahead.",
    ].filter(Boolean).join("\n");
  }
  return [
    name ? `${name}，您好！` : "您好！",
    `这是您的 NewMe 智能家居报价${quoteNo ? ` #${quoteNo}` : ""}：${money(total, currency)}。`,
    validUntil ? `有效期至 ${validUntil}。` : "",
    "如需调整或确认，请直接回复。",
  ].filter(Boolean).join("\n");
}

/** https://wa.me link with the text prefilled, or null when the phone cannot be used. */
export function buildWhatsAppUrl(phone, text) {
  const digits = whatsappDigits(phone);
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : null;
}
