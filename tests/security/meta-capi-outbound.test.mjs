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

const { sendMetaCapiLead } = loadTypeScriptModule("src/lib/meta-capi.ts");

test("CAPI hashes contact data and preserves browser event id for deduplication", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let captured;
  process.env.META_PIXEL_ID = "pixel-test";
  process.env.META_CAPI_ACCESS_TOKEN = "token-test";
  process.env.META_GRAPH_API_VERSION = "v25.0";
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return new Response("{}", { status: 200 });
  };
  try {
    await sendMetaCapiLead({
      leadId: "11111111-1111-4111-8111-111111111111",
      clientIp: "203.0.113.10",
      clientUserAgent: "browser-test",
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
    const event = captured.body.data[0];
    assert.equal(event.event_id, "browser-event-1");
    assert.equal(event.action_source, "website");
    assert.equal(event.user_data.client_ip_address, "203.0.113.10");
    assert.equal(event.user_data.fbc, "fb.1.1.click");
    assert.match(event.user_data.em[0], /^[a-f0-9]{64}$/);
    assert.notEqual(event.user_data.em[0], "NADIA@example.com");
    assert.match(event.user_data.ph[0], /^[a-f0-9]{64}$/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("CAPI is a no-op when server credentials are absent", async () => {
  delete process.env.META_PIXEL_ID;
  delete process.env.META_CAPI_ACCESS_TOKEN;
  await sendMetaCapiLead({
    leadId: "lead",
    clientIp: "unknown",
    clientUserAgent: null,
    input: { customerName: "Name", phone: null, email: null, attribution: {} },
  });
});
