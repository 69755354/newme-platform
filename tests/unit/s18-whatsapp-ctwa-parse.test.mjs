import assert from "node:assert/strict";
import test from "node:test";
import { extractWhatsAppAdEvents, normalizeWhatsAppPhoneKey, normalizeCtwaClid } from "../../src/lib/whatsapp-ctwa.mjs";

const channel = { id: "channel-intake", phone_number_id: "123456789", waba_id: "987654321", business_phone: "15551234567", enabled: true, accept_since: "2026-10-19T00:00:00.000Z" };
const now = Date.parse("2026-10-19T12:00:00Z");
const seconds = (time) => String(Date.parse(time) / 1000);
const CLID = "AfcT3sTcLiCkId_abc-123XYZ";
const inbound = (id, time, extra = {}) => ({ id, from: "971501234567", timestamp: seconds(time), type: "text", text: { body: "PRIVATE CUSTOMER TEXT" }, ...extra });
const envelope = (field, list, extra = {}) => ({ object: "whatsapp_business_account", entry: [{ id: channel.waba_id, changes: [{ field, value: {
  messaging_product: "whatsapp", metadata: { phone_number_id: channel.phone_number_id, display_phone_number: channel.business_phone },
  [field === "messages" ? "messages" : "message_echoes"]: list, ...extra } }] }] });
const referral = { source_type: "ad", source_id: "120210000000001", source_url: "https://fb.me/abc", headline: "Smart home offer", body: "PRIVATE AD BODY", media_type: "image", image_url: "https://scontent.example/x.jpg", ctwa_clid: CLID };

test("an ad click message yields waba, phone_number_id, sender, time and the referral fields", () => {
  const [event] = extractWhatsAppAdEvents(envelope("messages", [inbound("wamid.1", "2026-10-19T01:00:00Z", { referral })],
    { contacts: [{ wa_id: "971501234567", profile: { name: "Aisha" } }] }), [channel], now);
  assert.equal(event.waba_id, "987654321");
  assert.equal(event.phone_number_id, "123456789");
  assert.equal(event.customer_phone, "971501234567");
  assert.equal(event.direction, "inbound");
  assert.equal(event.source, "messages");
  assert.equal(event.occurred_at, "2026-10-19T01:00:00.000Z");
  assert.equal(event.profile_name, "Aisha");
  assert.deepEqual(event.referral, { source_type: "ad", source_id: "120210000000001", source_url: "https://fb.me/abc", headline: "Smart home offer", ctwa_clid: CLID });
});

test("ad body text and media links are never kept (chat text is kept since S21, see s21-whatsapp-message-body)", () => {
  const events = extractWhatsAppAdEvents(envelope("messages", [inbound("wamid.1", "2026-10-19T01:00:00Z", { referral })]), [channel], now);
  const text = JSON.stringify(events);
  for (const secret of ["PRIVATE AD BODY", "scontent", ".jpg", "image_url", "media_type"]) assert.equal(text.includes(secret), false, secret);
});

test("a handset echo from the coexistence phone is an outbound event to the customer", () => {
  const [event] = extractWhatsAppAdEvents(envelope("smb_message_echoes", [{ id: "wamid.out", from: channel.business_phone, to: "971501234567", timestamp: seconds("2026-10-19T01:05:00Z"), type: "text", text: { body: "PRIVATE" } }]), [channel], now);
  assert.equal(event.direction, "outbound");
  assert.equal(event.source, "smb_message_echoes");
  assert.equal(event.customer_phone, "971501234567");
  assert.equal(event.referral, null);
  assert.equal(event.body, "PRIVATE");
});

test("a message without a referral is kept with referral null (organic)", () => {
  const [event] = extractWhatsAppAdEvents(envelope("messages", [inbound("wamid.2", "2026-10-19T01:00:00Z")]), [channel], now);
  assert.equal(event.referral, null);
});

test("malformed referral fields are dropped, a bad click id never reaches storage", () => {
  const [event] = extractWhatsAppAdEvents(envelope("messages", [inbound("wamid.3", "2026-10-19T01:00:00Z", { referral: { source_type: "ad", source_id: "not-numeric", source_url: "javascript:alert(1)", headline: "x".repeat(500), ctwa_clid: "bad id; drop table" } })]), [channel], now);
  assert.equal(event.referral.ctwa_clid, null);
  assert.equal(event.referral.source_id, null);
  assert.equal(event.referral.source_url, null);
  assert.equal(event.referral.headline.length, 200);
});

test("a post referral keeps the post id out of the ad id", () => {
  const [event] = extractWhatsAppAdEvents(envelope("messages", [inbound("wamid.4", "2026-10-19T01:00:00Z", { referral: { source_type: "post", source_id: "555666777", ctwa_clid: CLID } })]), [channel], now);
  assert.equal(event.referral.source_type, "post");
  assert.equal(event.referral.ad_id ?? null, null);
});

test("unapproved channels, other WABAs, stale, future, status-only, system and failed messages produce nothing", () => {
  const normal = envelope("messages", [inbound("wamid.5", "2026-10-19T01:00:00Z", { referral })]);
  assert.deepEqual(extractWhatsAppAdEvents(normal, [{ ...channel, enabled: false }], now), []);
  assert.deepEqual(extractWhatsAppAdEvents(normal, [{ ...channel, waba_id: "1" }], now), []);
  assert.deepEqual(extractWhatsAppAdEvents(normal, [{ ...channel, phone_number_id: "2" }], now), []);
  for (const bad of [inbound("old", "2026-10-18T23:59:59Z"), inbound("future", "2026-10-20T01:00:00Z"), inbound("u", "2026-10-19T01:00:00Z", { type: "unsupported" }), inbound("e", "2026-10-19T01:00:00Z", { errors: [{ code: 1 }] }), inbound("g", "2026-10-19T01:00:00Z", { from: "group@g.us" }), inbound("self", "2026-10-19T01:00:00Z", { from: channel.business_phone })]) {
    assert.deepEqual(extractWhatsAppAdEvents(envelope("messages", [bad]), [channel], now), [], bad.id);
  }
  assert.deepEqual(extractWhatsAppAdEvents(envelope("messages", [], { statuses: [{ id: "s", status: "read" }] }), [channel], now), []);
  assert.throws(() => extractWhatsAppAdEvents({ object: "page" }, [channel], now));
});

test("a replayed message id inside one delivery yields one event, and the click id of the first copy is kept", () => {
  const events = extractWhatsAppAdEvents(envelope("messages", [inbound("dup", "2026-10-19T01:00:00Z", { referral }), inbound("dup", "2026-10-19T01:00:00Z")]), [channel], now);
  assert.equal(events.length, 1);
  assert.equal(events[0].referral.ctwa_clid, CLID);
});

test("phone key folds every local spelling of one UAE number to the same key", () => {
  const spellings = ["+971501234567", "971501234567", "00971501234567", "0501234567", "050 123 4567", "050-123-4567", "501234567", "+971 050 123 4567", "(971) 50 123 4567"];
  for (const s of spellings) assert.equal(normalizeWhatsAppPhoneKey(s), "971501234567", s);
  assert.equal(normalizeWhatsAppPhoneKey("+447911123456"), "447911123456");
  assert.equal(normalizeWhatsAppPhoneKey("abc"), null);
  assert.equal(normalizeWhatsAppPhoneKey("12345"), null);
});

test("click id accepts the url-safe token Meta sends and nothing else", () => {
  assert.equal(normalizeCtwaClid(CLID), CLID);
  for (const bad of ["", "short", "has space in it 12345", "x".repeat(600), null, 12345678901234, "a;b'--1234567"]) assert.equal(normalizeCtwaClid(bad), null, String(bad));
});
