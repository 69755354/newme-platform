import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadTypeScriptModule(relativePath, mocks = {}) {
  const ts = require("typescript");
  const filename = path.join(repoRoot, relativePath);
  const source = fsSync.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return previousLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

const publicLead = loadTypeScriptModule("src/lib/public-lead.ts");

function websiteRequest(body, headers = {}) {
  return new Request("https://app.newme.ae/api/public/leads", {
    method: "POST",
    headers: {
      origin: "https://newme.ae",
      "content-type": "application/json",
      "x-real-ip": "203.0.113.10",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function loadRoute({ insertError = null, taskError = null } = {}) {
  const inserts = [];
  const tasks = [];
  const capi = [];
  const chain = {
    insert(value) { inserts.push(value); return this; },
    select() { return this; },
    async single() {
      return insertError
        ? { data: null, error: insertError }
        : { data: { id: "11111111-1111-4111-8111-111111111111" }, error: null };
    },
  };
  const admin = { from(table) { assert.equal(table, "leads"); return chain; } };
  const route = loadTypeScriptModule("src/app/api/public/leads/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/public-lead": publicLead,
    "@/lib/rate-limit": loadTypeScriptModule("src/lib/rate-limit.ts"),
    "@/lib/supabase-admin": { supabaseAdmin: admin },
    "@/lib/tasks": {
      createFollowUpTask: async (_db, input) => {
        tasks.push(input);
        return { error: taskError };
      },
    },
    "@/lib/meta-capi": {
      sendMetaCapiLead: async (input) => { capi.push(input); },
    },
    "@/lib/logger": {
      genReqId: () => "request-1",
      logger: { error() {}, warn() {}, info() {} },
    },
  });
  return { route, inserts, tasks, capi };
}

test.beforeEach(() => {
  delete process.env.WEBSITE_LEAD_TURNSTILE_SECRET;
});

test("website payloads are normalized into bounded CRM fields", () => {
  const result = publicLead.parseWebsiteLead({
    name: "  Nadia  ",
    phone: "00 971 (50) 123-4567",
    email: "nadia@example.com",
    area: "Dubai Hills",
    type: "Villa",
    floors: "G+2",
    systems: ["Lighting", "Climate", "Lighting"],
    message: "Please call after 5pm.",
    ref: "NM-ABC123",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    customerName: "Nadia",
    phone: "+971501234567",
    email: "nadia@example.com",
    location: "Dubai Hills",
    propertyType: "Villa",
    serviceNeeds: ["Lighting", "Climate"],
    notes: "Message: Please call after 5pm.\nFloors: G+2\nWebsite reference: NM-ABC123",
    turnstileToken: null,
    honeypot: false,
    attribution: {
      eventId: null,
      fbclid: null,
      fbc: null,
      fbp: null,
      landingPage: null,
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
  });
});

test("invalid contacts and overlong fields are rejected", () => {
  assert.deepEqual(publicLead.parseWebsiteLead({ name: "N", phone: "123" }), {
    ok: false,
    code: "name_required",
  });
  assert.deepEqual(publicLead.parseWebsiteLead({ name: "Nadia", phone: "123" }), {
    ok: false,
    code: "invalid_phone",
  });
  assert.deepEqual(publicLead.parseWebsiteLead({ name: "Nadia", email: "bad" }), {
    ok: false,
    code: "invalid_email",
  });
  assert.deepEqual(publicLead.parseWebsiteLead({ name: "Nadia", email: `${"a".repeat(250)}@x.ae` }), {
    ok: false,
    code: "invalid_field",
  });
});

test("only the two canonical website origins receive CORS access", async () => {
  const { route, inserts } = loadRoute();
  const foreign = await route.POST(websiteRequest({ name: "Nadia", phone: "+971501234567" }, {
    origin: "https://evil.example",
  }));
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  assert.equal(inserts.length, 0);

  const preflight = await route.OPTIONS(new Request("https://app.newme.ae/api/public/leads", {
    method: "OPTIONS",
    headers: { origin: "https://www.newme.ae" },
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://www.newme.ae");
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
});

test("a valid request creates an attributed website lead, follow-up, and CAPI event", async () => {
  const { route, inserts, tasks, capi } = loadRoute();
  const result = await route.POST(websiteRequest({
    name: "Nadia",
    phone: "+971 50 123 4567",
    area: "Dubai Hills",
    type: "Villa",
    systems: ["Lighting", "Climate"],
    message: "Please call.",
    event_id: "web-123",
    fbclid: "fb-click",
    fbc: "fb.1.123.fb-click",
    fbp: "fb.1.123.456",
    landing_page: "https://newme.ae/budget-estimator/?utm_source=meta",
    referrer: "https://facebook.com/",
    utm_source: "meta",
    utm_medium: "paid_social",
    utm_campaign: "villa-leads",
    campaign_id: "cmp-1",
    adset_id: "set-1",
    ad_id: "ad-1",
  }));
  assert.equal(result.status, 201);
  assert.deepEqual(await result.json(), { ok: true });
  assert.equal(result.headers.get("access-control-allow-origin"), "https://newme.ae");
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0], {
    source: "website",
    customer_name: "Nadia",
    phone: "+971501234567",
    email: null,
    location: "Dubai Hills",
    property_type: "Villa",
    service_needs: ["Lighting", "Climate"],
    notes: "Message: Please call.",
    source_channel: "paid_social",
    source_platform: "meta",
    landing_page: "https://newme.ae/budget-estimator/?utm_source=meta",
    referrer: "https://facebook.com/",
    fbclid: "fb-click",
    meta_click_id: "fb.1.123.fb-click",
    utm_source: "meta",
    utm_medium: "paid_social",
    utm_campaign: "villa-leads",
    utm_content: null,
    utm_term: null,
    campaign_id: "cmp-1",
    campaign_name: null,
    adset_id: "set-1",
    adset_name: null,
    ad_id: "ad-1",
    ad_name: null,
    meta_ad_id: "ad-1",
    meta_campaign: null,
    first_touch_at: inserts[0].first_touch_at,
    raw_import_data: { intake: "newme.ae", event_id: "web-123", fbp: "fb.1.123.456" },
    quality: "pending",
    stage: "new",
    assigned_to: null,
    next_action: "call",
    next_followup_date: inserts[0].next_followup_date,
  });
  assert.match(inserts[0].next_followup_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(inserts[0].first_touch_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].leadId, "11111111-1111-4111-8111-111111111111");
  assert.equal(tasks[0].assigneeId, null);
  assert.equal(capi.length, 1);
  assert.equal(capi[0].leadId, "11111111-1111-4111-8111-111111111111");
  assert.equal(capi[0].input.attribution.eventId, "web-123");
});

test("honeypot submissions look successful but never touch the database", async () => {
  const { route, inserts, tasks } = loadRoute();
  const result = await route.POST(websiteRequest({
    name: "Bot Name",
    phone: "+971501234567",
    company: "spam.example",
  }));
  assert.equal(result.status, 202);
  assert.deepEqual(await result.json(), { ok: true });
  assert.equal(inserts.length, 0);
  assert.equal(tasks.length, 0);
});

test("request and contact budgets are enforced before database writes", async () => {
  const { route, inserts } = loadRoute();
  for (let index = 0; index < 5; index += 1) {
    const result = await route.POST(websiteRequest({
      name: `Visitor ${index}`,
      phone: `+9715012345${index}`,
    }));
    assert.equal(result.status, 201);
  }
  const limited = await route.POST(websiteRequest({
    name: "Visitor Six",
    phone: "+971501234599",
  }));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal(inserts.length, 5);
});

test("database failures return a generic retriable response", async () => {
  const { route } = loadRoute({ insertError: { code: "db-private-detail", message: "secret" } });
  const result = await route.POST(websiteRequest({ name: "Nadia", phone: "+971501234567" }));
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { error: "temporarily_unavailable" });
});

test("the browser-facing route contains no public service-role credential", () => {
  const source = fsSync.readFileSync(path.join(repoRoot, "src/app/api/public/leads/route.ts"), "utf8");
  const publicCredentialName = ["NEXT", "PUBLIC", "SUPABASE", "SERVICE", "ROLE"].join("_");
  const serverCredentialAccess = new RegExp(
    ["service", "[_-]?", "role", "[^\\n]*", "process\\.env"].join(""),
    "i",
  );
  assert.doesNotMatch(source, new RegExp(publicCredentialName));
  assert.doesNotMatch(source, serverCredentialAccess);
  assert.match(source, /@\/lib\/supabase-admin/);
});

test("the exact public route bypasses session auth and has origin-specific production CORS", () => {
  const proxy = fsSync.readFileSync(path.join(repoRoot, "src/proxy.ts"), "utf8");
  const config = fsSync.readFileSync(path.join(repoRoot, "next.config.ts"), "utf8");
  const publicSet = proxy.slice(
    proxy.indexOf("const PUBLIC_API_PATHS = new Set(["),
    proxy.indexOf("]);", proxy.indexOf("const PUBLIC_API_PATHS = new Set([")),
  );
  assert.match(publicSet, /"\/api\/public\/leads"/);
  assert.doesNotMatch(publicSet, /"\/api\/public\/"/);
  assert.match(config, /source: "\/api\/public\/leads"/);
  assert.match(config, /Access-Control-Allow-Origin", value: "https:\/\/newme\.ae"/);
  assert.match(config, /Access-Control-Allow-Origin", value: "https:\/\/www\.newme\.ae"/);
  assert.doesNotMatch(config, /Access-Control-Allow-Origin[^\n]*value: "\*"/);
});
