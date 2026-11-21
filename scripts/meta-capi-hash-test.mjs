#!/usr/bin/env node
// Operator tool: send ONE test event per path to Meta with a test_event_code, to verify that hashed ph/em next to
// lead_id (CRM) or ctwa_clid (WhatsApp) are accepted. Nothing is read from or written to the database or the queues;
// test events do not count for ads optimisation or reporting. Default is a dry run that prints a redacted payload.
// Usage: META_TEST_EVENT_CODE=TEST12345 node scripts/meta-capi-hash-test.mjs crm|wa [--execute]
//   crm needs TEST_LEAD_ID (a real leadgen id), wa needs TEST_CTWA_CLID and TEST_WABA_ID; TEST_PHONE / TEST_EMAIL are the contact.
import { realpathSync as realpathOf } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashedContactKeys, buildMetaCrmPayload, serializeMetaCrmPayload } from "../src/lib/meta-crm-events.ts";
import { buildWhatsAppCapiPayload } from "../src/lib/whatsapp-capi.mjs";

export function buildTestRequest(kind, env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const code = env.META_TEST_EVENT_CODE;
  if (!code || !/^[A-Za-z0-9_-]{3,40}$/.test(code)) throw new Error("META_TEST_EVENT_CODE missing or malformed");
  const match = hashedContactKeys({ phone: env.TEST_PHONE, email: env.TEST_EMAIL });
  if (kind === "crm") {
    const payload = buildMetaCrmPayload({ leadgenId: env.TEST_LEAD_ID, eventName: "Quoted", eventTime: nowSeconds,
      eventId: `hashtest-${nowSeconds}`, value: 1, currency: "AED", match });
    return { dataset: env.META_PIXEL_ID, body: serializeMetaCrmPayload(payload).replace(/^\{/, `{"test_event_code":${JSON.stringify(code)},`) };
  }
  if (kind === "wa") {
    const payload = buildWhatsAppCapiPayload({ eventId: `hashtest-${nowSeconds}`, wabaId: env.TEST_WABA_ID, ctwaClid: env.TEST_CTWA_CLID,
      eventName: "InitiateCheckout", eventTime: nowSeconds, value: 1, currency: "AED", hashedPhone: match.ph ?? null });
    return { dataset: env.META_WA_DATASET_ID, body: JSON.stringify({ test_event_code: code, ...payload }) };
  }
  throw new Error("kind must be crm or wa");
}

const isMain = () => { try { return realpathOf(process.argv[1]) === realpathOf(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) {
  const [kind, flag] = process.argv.slice(2);
  try {
    const req = buildTestRequest(kind, process.env);
    if (flag !== "--execute") {
      console.log("dry run; body (hashes shortened):", req.body.replace(/[0-9a-f]{64}/g, (h) => `${h.slice(0, 8)}...`));
    } else {
      if (!req.dataset || !process.env.META_CAPI_ACCESS_TOKEN) throw new Error("dataset id or token missing");
      const v = process.env.META_GRAPH_API_VERSION || "v25.0";
      const r = await fetch(`https://graph.facebook.com/${v}/${encodeURIComponent(req.dataset)}/events`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.META_CAPI_ACCESS_TOKEN}` },
        body: req.body, signal: AbortSignal.timeout(10_000) });
      console.log(r.status, await r.text());
      if (!r.ok) process.exitCode = 1;
    }
  } catch (e) { console.error(String(e.message)); process.exitCode = 2; }
}
