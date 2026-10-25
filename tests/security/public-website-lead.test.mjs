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

function loadRoute({ insertError = null, taskError = null, capiError = null, capiFailures = 0,
  beforeCapi = async () => {}, deliveryErrorOnce = false } = {}) {
  const inserts = [];
  const tasks = [];
  const capi = [];
  const deliveries = [];
  const deliveryUpdates = [];
  const rows = { leads: new Map(), business_events: new Map(), tasks: new Map() };
  const admin = {
    from(table) {
      let operation = "select", value, filters = [];
      const chain = {
        insert(input) { operation = "insert"; value = structuredClone(input); return this; },
        update(input) { operation = "update"; value = structuredClone(input); return this; },
        select() { return this; },
        eq(key, expected) { filters.push([key, expected]); return this; },
        single() { return this.maybeSingle(); },
        async maybeSingle() {
          if (table === "leads" && operation === "insert" && insertError) return { data: null, error: insertError };
          if (operation === "insert") {
            if (table === "business_events" && deliveryErrorOnce) {
              deliveryErrorOnce = false;
              return { data: null, error: { code: "outbox_unavailable" } };
            }
            if (rows[table].has(value.id)) return { data: null, error: { code: "23505" } };
            rows[table].set(value.id, value);
            (table === "leads" ? inserts : deliveries).push(structuredClone(value));
            return { data: structuredClone(value), error: null };
          }
          const row = [...rows[table].values()].find((entry) => filters.every(([key, expected]) => {
            const [column, field] = key.split("->>");
            const found = field ? entry[column]?.[field] : entry[column];
            return String(found) === String(expected);
          }));
          if (row && operation === "update") { Object.assign(row, value); deliveryUpdates.push(value); }
          return { data: row ? structuredClone(row) : null, error: null };
        },
      };
      return chain;
    },
  };
  const route = loadTypeScriptModule("src/app/api/public/leads/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/public-lead": publicLead,
    "@/lib/rate-limit": loadTypeScriptModule("src/lib/rate-limit.ts"),
    "@/lib/supabase-admin": { supabaseAdmin: admin },
    "@/lib/tasks": {
      createFollowUpTask: async (_db, input) => {
        if (rows.tasks.has(input.taskId)) return { error: { code: "23505" } };
        if (!taskError) rows.tasks.set(input.taskId, input);
        tasks.push(input);
        return { error: taskError };
      },
    },
    "@/lib/meta-capi": {
      buildMetaCapiLeadPayload: (input) => ({ data: [{ event_id: input.input.attribution.eventId, event_time: input.eventTime }] }),
      sendMetaCapiPayload: async (payload) => {
        capi.push(payload);
        await beforeCapi();
        if (capiFailures-- > 0) throw new Error("upstream unavailable");
        if (capiError) throw capiError;
      },
    },
    "@/lib/website-lead-identity": loadTypeScriptModule("src/lib/website-lead-identity.ts"),
    "@/lib/meta-capi-delivery": loadTypeScriptModule("src/lib/meta-capi-delivery.ts"),
    "@/lib/logger": {
      genReqId: () => "request-1",
      logger: { error() {}, warn() {}, info() {} },
    },
  });
  return { route, inserts, tasks, capi, deliveries, deliveryUpdates, rows };
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
    event_id: "normalize-1",
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
      eventId: "normalize-1",
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
  assert.deepEqual(publicLead.parseWebsiteLead({ name: "Nadia", phone: "+971501234567" }), {
    ok: false,
    code: "event_id_required",
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
  const { route, inserts, tasks, capi, deliveries, deliveryUpdates } = loadRoute();
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
    id: inserts[0].id,
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
    raw_import_data: { intake: "newme.ae", event_id: "web-123", fbp: "fb.1.123.456",
      intake_fingerprint: inserts[0].raw_import_data.intake_fingerprint,
      intake_at: inserts[0].raw_import_data.intake_at },
    quality: "pending",
    stage: "new",
    assigned_to: null,
    next_action: "call",
    next_followup_date: inserts[0].next_followup_date,
  });
  assert.match(inserts[0].next_followup_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(inserts[0].first_touch_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].leadId, inserts[0].id);
  assert.equal(tasks[0].assigneeId, null);
  assert.equal(capi.length, 1);
  assert.equal(capi[0].data[0].event_id, "web-123");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].event_type, "meta_capi_lead_delivery");
  assert.equal(deliveries[0].event_data.status, "pending");
  assert.equal(deliveryUpdates.at(-1).event_data.status, "delivered");
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

test("failed CAPI sends remain in a durable retryable business event", async () => {
  const { route, deliveries, deliveryUpdates } = loadRoute({ capiError: new Error("Meta unavailable") });
  const result = await route.POST(websiteRequest({
    name: "Nadia",
    phone: "+971501234567",
    event_id: "retryable-1",
  }));
  assert.equal(result.status, 201);
  assert.equal(deliveries[0].event_data.status, "pending");
  assert.equal(deliveries[0].event_data.event_id, "retryable-1");
  assert.equal(deliveryUpdates.at(-1).event_data.status, "failed");
  assert.equal(deliveryUpdates.at(-1).event_data.event_id, "retryable-1");
  assert.deepEqual(deliveryUpdates.at(-1).event_data.payload, deliveries[0].event_data.payload);
});

test("an identical retry creates one lead, task and delivery and does not resend success", async () => {
  const state = loadRoute();
  const input = { name: "Nadia", phone: "+971501234567", event_id: "same-inquiry" };
  assert.equal((await state.route.POST(websiteRequest(input))).status, 201);
  assert.equal((await state.route.POST(websiteRequest({ ...input, turnstileToken: "new-token", fbp: "fresh-cookie" }))).status, 201);
  assert.equal(state.rows.leads.size, 1);
  assert.equal(state.rows.tasks.size, 1);
  assert.equal(state.rows.business_events.size, 1);
  assert.equal(state.capi.length, 1);
});

test("reusing an event id for a different inquiry returns conflict without overwriting", async () => {
  const state = loadRoute();
  const input = { name: "Nadia", phone: "+971501234567", event_id: "conflicting-inquiry" };
  await state.route.POST(websiteRequest(input));
  const result = await state.route.POST(websiteRequest({ ...input, phone: "+971501234568" }));
  assert.equal(result.status, 409);
  assert.deepEqual(await result.json(), { error: "event_id_conflict" });
  assert.equal(state.inserts[0].phone, input.phone);
  assert.equal(state.capi.length, 1);
});

test("an outbox insertion failure is repaired by retry without duplicating the inquiry", async () => {
  const state = loadRoute({ deliveryErrorOnce: true });
  const input = { name: "Nadia", phone: "+971501234567", event_id: "repair-outbox" };
  assert.equal((await state.route.POST(websiteRequest(input))).status, 503);
  assert.equal(state.capi.length, 0);
  assert.equal((await state.route.POST(websiteRequest(input))).status, 201);
  assert.equal(state.rows.leads.size, 1);
  assert.equal(state.rows.tasks.size, 1);
  assert.equal(state.rows.business_events.size, 1);
  assert.equal(state.capi.length, 1);
});

test("a failed send retries the stored payload including its original event time", async () => {
  const state = loadRoute({ capiFailures: 1 });
  const input = { name: "Nadia", phone: "+971501234567", event_id: "retry-payload" };
  await state.route.POST(websiteRequest(input));
  await state.route.POST(websiteRequest(input));
  assert.equal(state.capi.length, 2);
  assert.deepEqual(state.capi[1], state.capi[0]);
  const stored = [...state.rows.business_events.values()][0].event_data;
  assert.equal(stored.status, "delivered");
  assert.equal(stored.attempts, 2);
});

test("two simultaneous submissions share the persisted delivery claim", async () => {
  let release, entered;
  const wait = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const state = loadRoute({ beforeCapi: async () => { entered(); await wait; } });
  const input = { name: "Nadia", phone: "+971501234567", event_id: "concurrent-inquiry" };
  const first = state.route.POST(websiteRequest(input));
  await started;
  try {
    assert.equal((await state.route.POST(websiteRequest(input))).status, 201);
    assert.equal(state.capi.length, 1);
  } finally { release(); }
  assert.equal((await first).status, 201);
  assert.equal(state.rows.leads.size, 1);
  assert.equal(state.rows.tasks.size, 1);
  assert.equal(state.rows.business_events.size, 1);
});

test("request and contact budgets are enforced before database writes", async () => {
  const { route, inserts } = loadRoute();
  for (let index = 0; index < 5; index += 1) {
    const result = await route.POST(websiteRequest({
      name: `Visitor ${index}`,
      phone: `+9715012345${index}`,
      event_id: `budget-${index}`,
    }));
    assert.equal(result.status, 201);
  }
  const limited = await route.POST(websiteRequest({
    name: "Visitor Six",
    phone: "+971501234599",
    event_id: "budget-six",
  }));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal(inserts.length, 5);
});

test("database failures return a generic retriable response", async () => {
  const { route } = loadRoute({ insertError: { code: "db-private-detail", message: "secret" } });
  const result = await route.POST(websiteRequest({ name: "Nadia", phone: "+971501234567", event_id: "db-failure" }));
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
