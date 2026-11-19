import assert from "node:assert/strict";
import test from "node:test";
import { extractWhatsAppAdEvents, messageBody, messageBodyKind } from "../../src/lib/whatsapp-ctwa.mjs";

const channel = { id: "channel-intake", phone_number_id: "123456789", waba_id: "987654321", business_phone: "15551234567", enabled: true, accept_since: "2026-10-19T00:00:00.000Z" };
const now = Date.parse("2026-10-19T12:00:00Z");
const seconds = (time) => String(Date.parse(time) / 1000);
const envelope = (field, list) => ({ object: "whatsapp_business_account", entry: [{ id: channel.waba_id, changes: [{ field, value: {
  messaging_product: "whatsapp", metadata: { phone_number_id: channel.phone_number_id, display_phone_number: channel.business_phone },
  [field === "messages" ? "messages" : "message_echoes"]: list } }] }] });
const inbound = (id, extra) => ({ id, from: "971501234567", timestamp: seconds("2026-10-19T01:00:00Z"), ...extra });

test("a text message keeps its text and the kind marker text", () => {
  const [event] = extractWhatsAppAdEvents(envelope("messages", [inbound("w1", { type: "text", text: { body: "  Hello, 2 bedroom flat in Marina\n budget 150k  " } })]), [channel], now);
  assert.equal(event.body, "Hello, 2 bedroom flat in Marina\n budget 150k");
  assert.equal(event.body_kind, "text");
});

test("an outbound echo keeps its text too", () => {
  const [event] = extractWhatsAppAdEvents(envelope("smb_message_echoes", [{ id: "o1", from: channel.business_phone, to: "971501234567", timestamp: seconds("2026-10-19T01:05:00Z"), type: "text", text: { body: "Thanks, calling you now" } }]), [channel], now);
  assert.equal(event.direction, "outbound");
  assert.equal(event.body, "Thanks, calling you now");
});

test("media keeps a marker only: no caption, no link, no media id", () => {
  const [event] = extractWhatsAppAdEvents(envelope("messages", [inbound("w2", { type: "image", image: { id: "MEDIA-ID-9", caption: "PRIVATE CAPTION", mime_type: "image/jpeg", sha256: "x", link: "https://scontent.example/a.jpg" } })]), [channel], now);
  assert.equal(event.body, null);
  assert.equal(event.body_kind, "media");
  const text = JSON.stringify(event);
  for (const leak of ["PRIVATE CAPTION", "MEDIA-ID-9", "scontent", ".jpg", "image/jpeg"]) assert.equal(text.includes(leak), false, leak);
});

test("reactions, buttons and other kinds keep a marker only", () => {
  const [event] = extractWhatsAppAdEvents(envelope("messages", [inbound("w3", { type: "reaction", reaction: { emoji: "x", message_id: "m" } })]), [channel], now);
  assert.equal(event.body, null);
  assert.equal(event.body_kind, "other");
  assert.equal(messageBodyKind("sticker"), "media");
  assert.equal(messageBodyKind("interactive"), "other");
});

test("control characters are removed, line breaks stay, the length is capped, blank text is null", () => {
  assert.equal(messageBody({ type: "text", text: { body: "a\u0000b\u0007c\nd\te" } }), "abc\nd\te");
  assert.equal(messageBody({ type: "text", text: { body: "x".repeat(5000) } }).length, 4096);
  assert.equal(messageBody({ type: "text", text: { body: "   \n " } }), null);
  assert.equal(messageBody({ type: "image", text: { body: "ignored" } }), null);
  assert.equal(messageBody({ type: "text", text: { body: 42 } }), null);
});
