import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadTypeScriptModule(relativePath) {
  const ts = require("typescript");
  const filename = path.join(repoRoot, relativePath);
  const source = fsSync.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(outputText, filename);
  return loaded.exports;
}

const { normalizedPhone, sendMetaCapiLead, sendMetaCapiPayload } = loadTypeScriptModule("src/lib/meta-capi.ts");

test("CAPI hashes contact data and preserves browser event id for deduplication", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let captured;
  process.env.META_PIXEL_ID = "pixel-test";
  process.env.META_CAPI_ACCESS_TOKEN = "token-test";
  process.env.META_GRAPH_API_VERSION = "v25.0";
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body), init };
    return Response.json({ events_received: 1, fbtrace_id: "test-trace" });
  };
  try {
    await sendMetaCapiLead({
      leadId: "11111111-1111-4111-8111-111111111111",
      clientIp: "203.0.113.10",
      clientUserAgent: "browser-test",
      eventTime: 1_800_000_000,
      input: {
        customerName: "Nadia Smith",
        phone: "+971501234567",
        email: "NADIA@example.com",
        location: null,
        propertyType: null,
        serviceNeeds: null,
        notes: null,
        turnstileToken: null,
        honeypot: false,
        attribution: {
          eventId: "browser-event-1",
          fbc: "fb.1.1.click",
          fbp: "fb.1.1.browser",
          landingPage: "https://newme.ae/budget-estimator/",
          fbclid: null,
          referrer: null,
          utmSource: null,
          utmMedium: null,
          utmCampaign: null,
          utmContent: null,
          utmTerm: null,
          campaignId: null,
          campaignName: null,
          adsetId: null,
          adsetName: null,
          adId: null,
          adName: null,
        },
      },
    });
    assert.match(captured.url, /\/v25\.0\/pixel-test\/events/);
    assert.equal(new URL(captured.url).search, "");
    assert.equal(captured.init.headers.Authorization, "Bearer token-test");
    assert.equal(captured.init.redirect, "error");
    const event = captured.body.data[0];
    assert.equal(event.event_id, "browser-event-1");
    assert.equal(event.event_time, 1_800_000_000);
    assert.equal(event.action_source, "website");
    assert.equal(event.user_data.client_ip_address, "203.0.113.10");
    assert.equal(event.user_data.fbc, "fb.1.1.click");
    assert.match(event.user_data.em[0], /^[a-f0-9]{64}$/);
    assert.notEqual(event.user_data.em[0], "NADIA@example.com");
    assert.match(event.user_data.ph[0], /^[a-f0-9]{64}$/);
    assert.equal(normalizedPhone("0501234567"), "971501234567");
    assert.equal(normalizedPhone("501234567"), "971501234567");
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("CAPI fails closed when server credentials are absent", async () => {
  const originalEnv = { ...process.env };
  delete process.env.META_PIXEL_ID;
  delete process.env.META_CAPI_ACCESS_TOKEN;
  try { await assert.rejects(
    sendMetaCapiLead({
      leadId: "lead",
      clientIp: "unknown",
      clientUserAgent: null,
      input: { customerName: "Name", phone: null, email: null, attribution: {} },
    }),
    /configuration is unavailable/,
  ); } finally { process.env = originalEnv; }
});

test("HTTP success without full acknowledgement remains retryable", async (t) => {
  for (const receipt of [{}, { events_received: 0 }, { events_received: "1" },
    { events_received: 2 }, { events_received: 1, error: { message: "private" } }, null, []]) {
    await t.test(JSON.stringify(receipt), async () => {
      const originalEnv = { ...process.env };
      const originalFetch = globalThis.fetch;
      process.env.META_PIXEL_ID = "pixel-test";
      process.env.META_CAPI_ACCESS_TOKEN = "token-test";
      globalThis.fetch = async () => Response.json(receipt);
      try {
        await assert.rejects(sendMetaCapiPayload({ data: [{}] }), /did not acknowledge every event/);
      } finally { globalThis.fetch = originalFetch; process.env = originalEnv; }
    });
  }
});

test("transport, non-JSON and HTTP failures never expose upstream secrets", async (t) => {
  const cases = [
    [async () => { throw new Error("https://upstream/?access_token=private-token"); }, "Meta CAPI transport failed"],
    [async () => new Response("private-token", { status: 200 }), "Meta CAPI returned an invalid receipt"],
    [async () => Response.json({ error: "private-token" }, { status: 429 }), "Meta CAPI returned 429"],
  ];
  for (const [fetchMock, expected] of cases) {
    await t.test(expected, async () => {
      const originalEnv = { ...process.env };
      const originalFetch = globalThis.fetch;
      process.env.META_PIXEL_ID = "pixel-test";
      process.env.META_CAPI_ACCESS_TOKEN = "token-test";
      globalThis.fetch = fetchMock;
      try {
        await assert.rejects(sendMetaCapiPayload({ data: [{}] }), (error) => {
          assert.equal(error.message, expected);
          assert.doesNotMatch(error.message, /private-token/);
          return true;
        });
      } finally { globalThis.fetch = originalFetch; process.env = originalEnv; }
    });
  }
});
