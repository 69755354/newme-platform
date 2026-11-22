// S36 F10: "send to customer" is honest (opens WhatsApp with the text typed, or copies it) instead of a fake "saved" toast.
import assert from "node:assert/strict";
import test from "node:test";
import { buildQuoteShareText, buildWhatsAppUrl, whatsappDigits } from "../../src/lib/quote-share.mjs";

test("phones become wa.me digits, junk becomes null", () => {
  assert.equal(whatsappDigits("050 123 4567"), "971501234567");
  assert.equal(whatsappDigits("+971 50 123 4567"), "971501234567");
  assert.equal(whatsappDigits("00971501234567"), "971501234567");
  for (const bad of [null, undefined, "", "12", "abc", "1".repeat(20)]) assert.equal(whatsappDigits(bad), null, String(bad));
});

test("the message names the quotation number, the total and the validity in the chosen language", () => {
  const zh = buildQuoteShareText({ lang: "zh", customerName: "Ali", quoteNo: "NM-2026-0042", total: 18900, currency: "AED", validUntil: "2026-12-31" });
  assert.match(zh, /Ali/); assert.match(zh, /NM-2026-0042/); assert.match(zh, /AED 18,900\.00/); assert.match(zh, /2026-12-31/);
  const en = buildQuoteShareText({ lang: "en", customerName: "", quoteNo: "NM-2026-0042", total: 18900 });
  assert.match(en, /^Hello,/); assert.match(en, /AED 18,900\.00/);
});

test("the WhatsApp link carries the encoded text; no phone means no link", () => {
  const url = buildWhatsAppUrl("0501234567", "a b&c");
  assert.equal(url, "https://wa.me/971501234567?text=a%20b%26c");
  assert.equal(buildWhatsAppUrl("", "x"), null);
});
