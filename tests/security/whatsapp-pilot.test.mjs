import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import { extractWhatsAppEvents, summarizeWhatsAppEvents, verifyWhatsAppSignature } from "../../src/lib/whatsapp-pilot.mjs";

const start = "2026-10-19T00:00:00.000Z";
const now = Date.parse("2026-10-19T12:00:00Z");
const channel = { id: "channel-intake", phone_number_id: "123456789", waba_id: "987654321", business_phone: "15551234567", enabled: true, accept_since: start };
const seconds = (time) => String(Date.parse(time) / 1000);
const message = (id, time, extra = {}) => ({ id, from: "15559876543", timestamp: seconds(time), type: "text", text: { body: "Private customer text" }, ...extra });
const payload = (field, messages, overrides = {}) => ({ object: "whatsapp_business_account", entry: [{ id: channel.waba_id, changes: [{ field, value: {
  messaging_product: "whatsapp", metadata: { phone_number_id: channel.phone_number_id, display_phone_number: channel.business_phone },
  [field === "messages" ? "messages" : "message_echoes"]: messages, ...overrides,
} }] }] });

test("signature covers the original raw bytes and refuses missing/malformed/tampered signatures", () => {
  const bytes = Buffer.from('{ "a": 1 }');
  const signature = `sha256=${createHmac("sha256", "test-secret").update(bytes).digest("hex")}`;
  assert.equal(verifyWhatsAppSignature(bytes, signature, "test-secret"), true);
  for (const sig of [null, "sha256=00", "sha1=bad", signature]) {
    assert.equal(verifyWhatsAppSignature(Buffer.from('{"a":1}'), sig, "test-secret"), false);
  }
});

test("inbound and handset echoes keep metadata only with stable cross-channel customer keys", () => {
  const inbound = extractWhatsAppEvents(payload("messages", [message("in-1", "2026-10-19T01:00:00Z")]), [channel], "test-salt", now);
  const outbound = extractWhatsAppEvents(payload("smb_message_echoes", [message("out-1", "2026-10-19T01:05:00Z", { from: channel.business_phone, to: "15559876543" })]), [channel], "test-salt", now);
  assert.equal(inbound[0].direction, "inbound");
  assert.equal(outbound[0].direction, "outbound");
  assert.equal(inbound[0].customer_key, outbound[0].customer_key);
  assert.equal(JSON.stringify(inbound).includes("Private"), false);
  assert.equal(JSON.stringify(inbound).includes("15559876543"), false);
  assert.equal(extractWhatsAppEvents(payload("messages", [message("in-1", "2026-10-19T01:00:00Z")]), [channel], "different-salt", now)[0].customer_key === inbound[0].customer_key, false);
});

test("unapproved channels, WABAs, historic imports, future times, status callbacks and unsupported messages are ignored", () => {
  const normal = payload("messages", [message("in-1", "2026-10-19T01:00:00Z")]);
  assert.deepEqual(extractWhatsAppEvents(normal, [{ ...channel, enabled: false }], "salt", now), []);
  assert.deepEqual(extractWhatsAppEvents(normal, [{ ...channel, waba_id: "different" }], "salt", now), []);
  assert.deepEqual(extractWhatsAppEvents(normal, [{ ...channel, phone_number_id: "other" }], "salt", now), []);
  assert.deepEqual(extractWhatsAppEvents(normal, [{ ...channel, accept_since: "invalid" }], "salt", now), []);
  for (const event of [message("old", "2026-10-18T23:59:59Z"), message("future", "2026-10-20T01:00:00Z"), message("unsupported", "2026-10-19T01:00:00Z", { type: "unsupported" }), message("group", "2026-10-19T01:00:00Z", { from: "group@g.us" })]) {
    assert.deepEqual(extractWhatsAppEvents(payload("messages", [event]), [channel], "salt", now), []);
  }
  assert.deepEqual(extractWhatsAppEvents(payload("messages", [], { statuses: [{ id: "status-1", status: "read" }] }), [channel], "salt", now), []);
  assert.throws(() => extractWhatsAppEvents({ object: "page" }, [channel], "salt", now));
});

test("duplicate and out-of-order deliveries retain one fact; burst response uses first pending incoming", () => {
  const input = extractWhatsAppEvents(payload("messages", [message("a", "2026-10-19T01:00:00Z"), message("b", "2026-10-19T01:03:00Z"), message("a", "2026-10-19T01:00:00Z")]), [channel], "salt", now);
  const output = extractWhatsAppEvents(payload("smb_message_echoes", [message("c", "2026-10-19T01:05:00Z", { from: channel.business_phone, to: "15559876543" })]), [channel], "salt", now);
  assert.equal(input.length, 2);
  const [summary] = summarizeWhatsAppEvents([...output, ...input, ...output]);
  assert.equal(summary.inbound_count, 2); assert.equal(summary.outbound_count, 1);
  assert.deepEqual(summary.observed_response_seconds, [300]); assert.equal(summary.pending_since, null);
  assert.equal(summarizeWhatsAppEvents(input)[0].pending_since, "2026-10-19T01:00:00.000Z");
  const independent = summarizeWhatsAppEvents([...input, ...output.map(e => ({ ...e, channel_id: "follow-up" }))]);
  assert.equal(independent.find(e => e.channel_id === channel.id).pending_since, "2026-10-19T01:00:00.000Z");
});

test("formatted display numbers match, while same-second sends do not prove a response order", () => {
  const formatted = payload("messages", [message("a", "2026-10-19T01:00:00Z")], { metadata: { phone_number_id: channel.phone_number_id, display_phone_number: "+1 (555) 123-4567" } });
  const input = extractWhatsAppEvents(formatted, [channel], "salt", now);
  assert.equal(input.length, 1);
  const output = extractWhatsAppEvents(payload("smb_message_echoes", [message("z", "2026-10-19T01:00:00Z", { from: channel.business_phone, to: "15559876543" })]), [channel], "salt", now);
  const [summary] = summarizeWhatsAppEvents([...input, ...output]);
  assert.deepEqual(summary.observed_response_seconds, []);
  assert.notEqual(summary.pending_since, null);
});

const require = createRequire(import.meta.url);
function loadRoute(file, mocks) {
  const ts = require("typescript");
  const output = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => mocks[name] ?? require(name), exports);
  return exports;
}
const nextMock = { NextResponse: { json: (body, init) => Response.json(body, init) } };

test("webhook route fails closed, validates challenge and retries storage failures without logging customer data", async () => {
  const saved = { ...process.env };
  const calls = [];
  let failStorage = false;
  const admin = { from: (table) => ({
    select: () => ({ eq: async () => ({ data: [channel], error: null }) }),
    upsert: async (rows, options) => { calls.push({ table, rows, options }); return { error: failStorage ? { code: "unavailable" } : null }; },
  }) };
  const route = loadRoute("../../src/app/api/whatsapp/webhook/route.ts", { "next/server": nextMock, "@/lib/supabase-admin": { supabaseAdmin: admin }, "@/lib/whatsapp-pilot.mjs": require("../../src/lib/whatsapp-pilot.mjs") });
  try {
    delete process.env.WHATSAPP_PILOT_ENABLED;
    assert.equal((await route.POST(new Request("https://example.test", { method: "POST" }))).status, 503);
    Object.assign(process.env, { WHATSAPP_PILOT_ENABLED: "true", WHATSAPP_APP_SECRET: "secret", WHATSAPP_PILOT_CONTACT_SALT: "salt", WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify" });
    assert.equal(await (await route.GET(new Request("https://example.test?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=123"))).text(), "123");
    assert.equal((await route.GET(new Request("https://example.test?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123"))).status, 403);
    const raw = JSON.stringify(payload("messages", [message("valid", "2026-10-19T01:00:00Z")]));
    const signature = `sha256=${createHmac("sha256", "secret").update(raw).digest("hex")}`;
    const request = (sig = signature) => new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: raw });
    assert.equal((await route.POST(request("sha256=bad"))).status, 403); assert.equal(calls.length, 0);
    assert.equal((await route.POST(request())).status, 200); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options, { onConflict: "channel_id,message_id", ignoreDuplicates: true });
    failStorage = true;
    assert.equal((await route.POST(request())).status, 503);
    const big = new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1024 * 1024 + 1) });
    assert.equal((await route.POST(big)).status, 413);
  } finally { process.env = saved; }
});

test("pilot status requires current boss/admin context before any service-role query", async () => {
  const saved = { ...process.env };
  let role = "sales"; let touched = 0;
  const route = loadRoute("../../src/app/api/whatsapp/pilot-status/route.ts", {
    "next/server": nextMock, "@/lib/supabase-admin": { supabaseAdmin: { from: () => { touched++; throw new Error("not expected"); } } },
    "@/lib/whatsapp-pilot.mjs": require("../../src/lib/whatsapp-pilot.mjs"),
    "@/lib/request-auth-context": { getRequestAuthContext: async () => ({ role }), applyRequestAuthCookies: (_context, response) => response, RequestAuthError: class extends Error {} },
  });
  try {
    process.env.WHATSAPP_PILOT_ENABLED = "true";
    for (role of ["sales", "operator", "finance"]) assert.equal((await route.GET(new Request("https://example.test"))).status, 403);
    assert.equal(touched, 0);
    delete process.env.WHATSAPP_PILOT_ENABLED;
    role = "boss";
    assert.equal((await (await route.GET(new Request("https://example.test"))).json()).state, "disabled");
    assert.equal(touched, 0);
  } finally { process.env = saved; }
});
