import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import {
  META_IDS_HEADER, buildMetaIdRows, buildMetaIdsCsv, canExportMetaIds, extractExportToken, leadRef, toDubaiIso, tokenMatches,
} from "../../src/lib/meta-ids-export.mjs";

const require = createRequire(import.meta.url);
const TOKEN = "t".repeat(48);

const FORM_LEAD = {
  id: "11111111-2222-3333-4444-555555555555", meta_leadgen_id: "9876543210123", ctwa_clid: null,
  campaign_id: "c1", campaign_name: "=Villa Sale", adset_id: "s1", ad_id: "a1", ad_name: "Ad one",
  created_at: "2026-11-18T21:30:00Z", stage: "new", final_status: null, archived: false,
  name: "Secret Name", customer_name: "Secret Name", phone: "+971500000000", email: "x@y.ae",
};
const WA_LEAD = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", meta_leadgen_id: null, ctwa_clid: "-AbCdEfGhIj12345",
  campaign_id: null, campaign_name: null, adset_id: null, ad_id: "120210000000001", ad_name: null,
  created_at: "2026-11-18T08:00:00Z", stage: "quoted", final_status: "won", archived: true, phone: "+971511111111",
};

test("only admin, boss and operator may use the login path", () => {
  for (const r of ["admin", "boss", "operator"]) assert.equal(canExportMetaIds(r), true, r);
  for (const r of ["sales", "finance", "designer", "", null, undefined]) assert.equal(canExportMetaIds(r), false, String(r));
});

test("token comparison: exact match only, disabled when unset or too short", () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN + "x", TOKEN), false);
  assert.equal(tokenMatches("", TOKEN), false);
  assert.equal(tokenMatches(null, TOKEN), false);
  assert.equal(tokenMatches(TOKEN, undefined), false);
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches("short", "short"), false, "a configured token under 32 chars is treated as not configured");
});

test("token is read from ?token= or Authorization: Bearer", () => {
  assert.deepEqual(extractExportToken(new Headers({ authorization: "Bearer abc" }), new URLSearchParams("token=q")), { query: "q", bearer: "abc" });
  assert.deepEqual(extractExportToken(new Headers(), new URLSearchParams()), { query: null, bearer: null });
});

test("lead_ref is stable, short, and not a phone, name or the full id", () => {
  assert.equal(leadRef(FORM_LEAD.id), "NM-111111112222");
  assert.equal(leadRef(FORM_LEAD.id), leadRef(FORM_LEAD.id));
  assert.notEqual(leadRef(FORM_LEAD.id), leadRef(WA_LEAD.id));
});

test("Dubai time ISO", () => {
  assert.equal(toDubaiIso("2026-11-18T21:30:00Z"), "2026-11-19T01:30:00+04:00");
  assert.equal(toDubaiIso(null), "");
});

test("rows: form and WhatsApp leads are both present, feedback comes from the right table, no personal data", () => {
  const rows = buildMetaIdRows(
    [FORM_LEAD, WA_LEAD],
    [
      { lead_id: FORM_LEAD.id, event_name: "QualifiedLead", status: "pending", created_at: "2026-11-18T22:00:00Z", delivered_at: null },
      { lead_id: FORM_LEAD.id, event_name: "LeadSubmitted", status: "delivered", created_at: "2026-11-18T21:31:00Z", delivered_at: "2026-11-18T21:32:00Z" },
    ],
    [
      { lead_id: WA_LEAD.id, event_name: "LeadSubmitted", status: "failed", created_at: "2026-11-18T08:01:00Z", delivered_at: null },
      { lead_id: WA_LEAD.id, event_name: "Purchase", status: "review_required", created_at: "2026-11-18T09:00:00Z", delivered_at: null },
    ],
  );
  assert.equal(rows.length, 2);
  const form = rows.find((r) => r.source === "form");
  const wa = rows.find((r) => r.source === "whatsapp");
  assert.equal(form.meta_id_type, "leadgen"); assert.equal(form.meta_id, "9876543210123");
  assert.equal(form.feedback_events, "LeadSubmitted:sent;QualifiedLead:queued");
  assert.equal(form.last_feedback_at, "2026-11-19T02:00:00+04:00");
  assert.equal(form.campaign_name, "=Villa Sale");
  assert.equal(wa.meta_id_type, "ctwa_clid"); assert.equal(wa.meta_id, "-AbCdEfGhIj12345");
  assert.equal(wa.feedback_events, "LeadSubmitted:failed;Purchase:manual");
  assert.equal(wa.archived, "true"); assert.equal(wa.final_status, "won");
  // a form lead never reads WhatsApp events and vice versa
  const mixed = buildMetaIdRows([FORM_LEAD], [], [{ lead_id: FORM_LEAD.id, event_name: "Purchase", status: "delivered", created_at: "2026-11-18T09:00:00Z", delivered_at: null }]);
  assert.equal(mixed[0].feedback_events, "");
  const csv = buildMetaIdsCsv(rows);
  for (const secret of ["Secret Name", "+971500000000", "x@y.ae", "+971511111111", FORM_LEAD.id, WA_LEAD.id]) assert.ok(!csv.includes(secret), secret);
  const [header] = csv.replace("﻿", "").split("\r\n");
  assert.equal(header, META_IDS_HEADER.join(","));
  assert.deepEqual([...META_IDS_HEADER], ["lead_ref", "source", "meta_id_type", "meta_id", "campaign_id", "campaign_name", "adset_id", "ad_id", "ad_name", "created_at", "stage", "final_status", "archived", "feedback_events", "last_feedback_at"]);
  assert.ok(csv.includes(",'=Villa Sale,"), "formula-looking text is neutralised");
});

test("a lead with both ids produces two rows", () => {
  const rows = buildMetaIdRows([{ ...FORM_LEAD, ctwa_clid: "ctwa_clid_value_1" }], [], []);
  assert.deepEqual(rows.map((r) => r.source).sort(), ["form", "whatsapp"]);
});

// ---- route ------------------------------------------------------------------------------
function loadRoute({ db, env = {}, auth, limit } = {}) {
  const ts = require("typescript");
  const out = ts.transpileModule(fs.readFileSync(new URL("../../src/app/api/export/meta-ids/route.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const logs = [];
  const mocks = {
    "next/server": { NextResponse: Object.assign(function (body, init) { return new Response(body, init); }, { json: (b, i) => Response.json(b, i) }) },
    "@/lib/supabase-admin": { supabaseAdmin: db }, "@/lib/logger": { logger: { error: (...a) => logs.push(a), warn: (...a) => logs.push(a), info: (...a) => logs.push(a) } },
    "@/lib/rate-limit": { clientIdentifier: () => "1.2.3.4", consumeRateLimit: limit ?? (() => ({ allowed: true, retryAfterSeconds: 0, remaining: 9 })) },
    "@/lib/request-auth-context": {
      applyRequestAuthCookies: (_c, r) => r,
      getRequestAuthContext: auth ?? (async () => { throw new mocks["@/lib/request-auth-context"].RequestAuthError(); }),
      RequestAuthError: class extends Error {}, requestAuthErrorResponse: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    },
    "@/lib/meta-ids-export.mjs": require("../../src/lib/meta-ids-export.mjs"),
  };
  const saved = process.env.META_IDS_EXPORT_TOKEN;
  if ("META_IDS_EXPORT_TOKEN" in env) process.env.META_IDS_EXPORT_TOKEN = env.META_IDS_EXPORT_TOKEN; else delete process.env.META_IDS_EXPORT_TOKEN;
  new Function("require", "exports", out)((n) => mocks[n] ?? require(n), exports);
  return { GET: async (req) => { try { return await exports.GET(req); } finally { if (saved === undefined) delete process.env.META_IDS_EXPORT_TOKEN; else process.env.META_IDS_EXPORT_TOKEN = saved; } }, logs };
}

function fakeDb({ leads = [FORM_LEAD, WA_LEAD], total } = {}) {
  const seen = { leadFilters: [] };
  const db = { seen, from: (table) => {
    let range = [0, 0];
    const q = { select: () => q, not: () => q, or: (f) => { seen.leadFilters.push(f); return q; }, gte: (c, v) => { seen.leadFilters.push(`${c}>=${v}`); return q; }, order: () => q, in: () => q,
      range: (a, b) => { range = [a, b]; return q; },
      then: (res, rej) => Promise.resolve((() => {
        if (table === "leads") {
          if (total !== undefined) return { data: Array.from({ length: Math.max(0, Math.min(range[1] + 1, total) - range[0]) }, (_, i) => ({ ...FORM_LEAD, id: `00000000-0000-0000-0000-${String(range[0] + i).padStart(12, "0")}` })), error: null };
          return { data: leads.slice(range[0], range[1] + 1), error: null };
        }
        if (table === "meta_crm_stage_events") return { data: [{ lead_id: FORM_LEAD.id, event_name: "LeadSubmitted", status: "delivered", created_at: "2026-11-18T21:31:00Z", delivered_at: "2026-11-18T21:32:00Z" }], error: null };
        if (table === "whatsapp_capi_events") return { data: [{ lead_id: WA_LEAD.id, event_name: "LeadSubmitted", status: "pending", created_at: "2026-11-18T08:01:00Z", delivered_at: null }], error: null };
        return { data: [], error: null };
      })()).then(res, rej) };
    return q;
  } };
  return db;
}
const req = (path, headers = {}) => ({ url: `https://example.test/api/export/meta-ids${path}`, headers: new Headers(headers) });
const session = (role) => async () => ({ role });

test("route: missing or wrong token is 401, no database read happens", async () => {
  const db = fakeDb(); let reads = 0; const spy = { ...db, from: (t) => { reads += 1; return db.from(t); } };
  for (const request of [req(""), req("?token=wrong"), req("", { authorization: "Bearer wrong" })]) {
    const res = await loadRoute({ db: spy, env: { META_IDS_EXPORT_TOKEN: TOKEN } }).GET(request);
    assert.equal(res.status, 401);
  }
  assert.equal(reads, 0);
});

test("route: token not configured disables the token path entirely", async () => {
  const res = await loadRoute({ db: fakeDb(), env: {} }).GET(req(`?token=${TOKEN}`));
  assert.equal(res.status, 401);
  const short = await loadRoute({ db: fakeDb(), env: { META_IDS_EXPORT_TOKEN: "short" } }).GET(req("?token=short"));
  assert.equal(short.status, 401);
});

test("route: valid token returns CSV with both lead kinds and correct feedback, never cached, token never logged", async () => {
  for (const request of [req(`?token=${TOKEN}`), req("", { authorization: `Bearer ${TOKEN}` })]) {
    const r = loadRoute({ db: fakeDb(), env: { META_IDS_EXPORT_TOKEN: TOKEN } });
    const res = await r.GET(request);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(res.headers.get("cache-control"), /no-store/);
    const text = await res.text();
    assert.match(text, /form,leadgen,9876543210123/);
    assert.match(text, /whatsapp,ctwa_clid,'-AbCdEfGhIj12345/);
    assert.match(text, /LeadSubmitted:sent/); assert.match(text, /LeadSubmitted:queued/);
    assert.ok(!text.includes("Secret Name") && !text.includes("+971"));
    assert.ok(!JSON.stringify(r.logs).includes(TOKEN));
  }
});

test("route: json format and since filter; archived leads are not excluded", async () => {
  const db = fakeDb();
  const res = await loadRoute({ db, env: { META_IDS_EXPORT_TOKEN: TOKEN } }).GET(req(`?token=${TOKEN}&format=json&since=2026-11-01T00:00:00Z`));
  const body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.count, 2); assert.equal(body.rows.find((r) => r.source === "whatsapp").archived, "true");
  assert.ok(db.seen.leadFilters.some((f) => f.startsWith("created_at>=2026-11-01")));
  assert.ok(!db.seen.leadFilters.some((f) => /archived/.test(f)));
  const bad = await loadRoute({ db: fakeDb(), env: { META_IDS_EXPORT_TOKEN: TOKEN } }).GET(req(`?token=${TOKEN}&since=nonsense`));
  assert.equal(bad.status, 400);
  const badFormat = await loadRoute({ db: fakeDb(), env: { META_IDS_EXPORT_TOKEN: TOKEN } }).GET(req(`?token=${TOKEN}&format=xml`));
  assert.equal(badFormat.status, 400);
});

test("route: logged-in admin, boss and operator are allowed; sales is 403", async () => {
  for (const role of ["admin", "boss", "operator"]) {
    const res = await loadRoute({ db: fakeDb(), auth: session(role), env: { META_IDS_EXPORT_TOKEN: TOKEN } }).GET(req("?format=json"));
    assert.equal(res.status, 200, role);
  }
  const res = await loadRoute({ db: fakeDb(), auth: session("sales") }).GET(req(""));
  assert.equal(res.status, 403);
  // session login also works when the token feature is off
  const off = await loadRoute({ db: fakeDb(), auth: session("admin"), env: {} }).GET(req(""));
  assert.equal(off.status, 200);
});

test("route: rate limit answers 429 with Retry-After before any read", async () => {
  const res = await loadRoute({ db: fakeDb(), env: { META_IDS_EXPORT_TOKEN: TOKEN }, limit: () => ({ allowed: false, retryAfterSeconds: 42, remaining: 0 }) }).GET(req(`?token=${TOKEN}`));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "42");
});

test("route: over the row limit gives 413 with a narrow-the-range hint; exactly at the limit passes", async () => {
  const over = await loadRoute({ db: fakeDb({ total: 20_001 }), env: { META_IDS_EXPORT_TOKEN: TOKEN } }).GET(req(`?token=${TOKEN}&format=json`));
  assert.equal(over.status, 413);
  const body = await over.json();
  assert.match(body.error, /since/); assert.match(body.error, /缩小/);
  const exact = await loadRoute({ db: fakeDb({ total: 20_000 }), env: { META_IDS_EXPORT_TOKEN: TOKEN } }).GET(req(`?token=${TOKEN}&format=json`));
  assert.equal(exact.status, 200);
});

test("proxy lets this path through without a session (token callers have none)", () => {
  const src = fs.readFileSync(new URL("../../src/proxy.ts", import.meta.url), "utf8");
  assert.match(src, /EXTERNAL_AUTHORIZED_API_PATHS = new Set\(\[[\s\S]*?"\/api\/export\/meta-ids"[\s\S]*?\]\)/);
  assert.ok(!/PROTECTED_ROUTES[^;]*\/api\/export/s.test(src), "no role redirect may sit in front of the token path");
});

test("route file is read-only against existing tables, headed with its access rule, and has no write calls", () => {
  const src = fs.readFileSync(new URL("../../src/app/api/export/meta-ids/route.ts", import.meta.url), "utf8");
  assert.match(src, /^\/\/ RBAC: /);
  assert.ok(!/\.(insert|update|upsert|delete|rpc)\(/.test(src));
  assert.ok(!/console\./.test(src));
  assert.match(src, /meta_crm_stage_events/); assert.match(src, /whatsapp_capi_events/);
  const select = src.match(/from\("leads"\)\s*\.select\(([^)]*)\)/s)?.[1] ?? "";
  for (const pii of ["phone", "email", "name", "customer_name", "full_name"]) assert.ok(!new RegExp(`\\b${pii}\\b`).test(select.replace(/campaign_name|ad_name|adset_name/g, "")), pii);
});
