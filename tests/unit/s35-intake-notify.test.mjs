// S35 "no lead lost": every automatic intake tells somebody at once, once. Fake database, no network.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { INTAKE_QUEUE_ROLES, intakeNotificationRows, notifyNewLead, notifyNewLeadSafe } from "../../src/lib/lead-intake-notify.mjs";
import { recordWhatsAppAdEvents } from "../../src/lib/whatsapp-ctwa-ingest.mjs";
import { localizeNotification } from "../../src/lib/notification-display.mjs";
import { translations } from "../../src/lib/i18n/translations.ts";

const ADMIN = "a0000000-0000-4000-8000-000000000001";
const BOSS = "a0000000-0000-4000-8000-000000000002";
const OPERATOR = "a0000000-0000-4000-8000-000000000003";
const SALES = "a0000000-0000-4000-8000-000000000004";
const SALES2 = "a0000000-0000-4000-8000-000000000005";
const GONE = "a0000000-0000-4000-8000-000000000006";
const FINANCE = "a0000000-0000-4000-8000-000000000007";
const LEAD = "b0000000-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-11-22T08:00:00Z");

/** Profiles + notifications table with the (user_id, event_key) unique index of insert_notifications_atomic. */
function fakeDb({ leads = [], failProfiles = false, failRpc = false } = {}) {
  const profiles = [
    { id: ADMIN, role: "admin", is_active: true }, { id: BOSS, role: "boss", is_active: true },
    { id: OPERATOR, role: "operator", is_active: true }, { id: SALES, role: "sales", is_active: true },
    { id: SALES2, role: "sales", is_active: true }, { id: GONE, role: "sales", is_active: false },
    { id: FINANCE, role: "finance", is_active: true },
  ];
  const notifications = [];
  const query = (table) => {
    const filters = [];
    const q = {
      select: () => q,
      eq: (col, val) => (filters.push((r) => r[col] === val), q),
      in: (col, vals) => (filters.push((r) => vals.includes(r[col])), q),
      maybeSingle: async () => ({ data: (table === "leads" ? leads : profiles).find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      then: (res, rej) => Promise.resolve(failProfiles ? { data: null, error: { code: "x" } }
        : { data: (table === "leads" ? leads : profiles).filter((r) => filters.every((f) => f(r))), error: null }).then(res, rej),
    };
    return q;
  };
  return {
    notifications,
    from: query,
    rpc: async (name, args) => {
      assert.equal(name, "insert_notifications_atomic");
      if (failRpc) return { data: null, error: { code: "x" } };
      let created = 0, skipped = 0;
      for (const row of args.p_notifications) {
        if (notifications.some((n) => n.user_id === row.user_id && n.event_key === row.event_key)) { skipped++; continue; }
        notifications.push(row); created++;
      }
      return { data: { created, skipped }, error: null };
    },
  };
}
const lead = (o = {}) => ({ id: LEAD, customer_name: "Nadia", assigned_to: null, created_at: new Date(NOW - 60_000).toISOString(), ...o });

test("unassigned intake lead: admin, boss and operator are told; sales and finance are not", async () => {
  const db = fakeDb();
  const r = await notifyNewLead(db, lead(), { now: NOW });
  assert.equal(r.created, 3);
  assert.deepEqual(db.notifications.map((n) => n.user_id).sort(), [ADMIN, BOSS, OPERATOR].sort());
  assert.deepEqual([...INTAKE_QUEUE_ROLES], ["admin", "boss", "operator"]);
  const row = db.notifications[0];
  assert.deepEqual([row.type, row.related_type, row.related_id, row.event_key], ["lead_created", "lead", LEAD, `lead_created:${LEAD}`]);
  assert.equal(row.body, 'Lead "Nadia" is waiting for assignment');
});

test("assigned intake lead: only the owner is told; an inactive or missing owner falls back to the dispatchers", async () => {
  const db = fakeDb();
  await notifyNewLead(db, lead({ assigned_to: SALES }), { now: NOW });
  assert.deepEqual(db.notifications.map((n) => n.user_id), [SALES]);
  assert.equal(db.notifications[0].body, 'Lead "Nadia" has been assigned to you');
  const gone = fakeDb();
  await notifyNewLead(gone, lead({ assigned_to: GONE }), { now: NOW });
  assert.equal(gone.notifications.length, 3, "an inactive owner must not swallow the notification");
});

test("a retried delivery, a backfill or the manual path never double-notifies (same event key)", async () => {
  const db = fakeDb();
  await notifyNewLead(db, lead(), { now: NOW });
  const again = await notifyNewLead(db, lead(), { now: NOW + 5 * 60_000 });
  assert.deepEqual([again.created, again.skipped], [0, 3]);
  assert.equal(db.notifications.length, 3);
});

test("history is not news: a lead older than 24h pings nobody; failures are reported, never thrown by the safe wrapper", async () => {
  const db = fakeDb();
  const old = await notifyNewLead(db, lead({ created_at: new Date(NOW - 25 * 3_600_000).toISOString() }), { now: NOW });
  assert.equal(old.reason, "too_old");
  assert.equal(db.notifications.length, 0);
  const errors = [];
  for (const broken of [fakeDb({ failProfiles: true }), fakeDb({ failRpc: true })]) {
    await assert.rejects(notifyNewLead(broken, lead(), { now: NOW }));
    const safe = await notifyNewLeadSafe(broken, lead(), { now: NOW, onError: (code) => errors.push(code) });
    assert.equal(safe.reason, "error");
  }
  assert.deepEqual(errors, ["notification_recipient_lookup_failed", "notification_insert_failed"]);
  assert.deepEqual(intakeNotificationRows(lead({ customer_name: "  " }), [ADMIN, ADMIN], false).map((r) => r.title), ["New lead: New Lead"]);
});

test("the notification text exists in Chinese and English", () => {
  const t = (lang) => (key) => key.split(".").reduce((o, k) => o?.[k], translations[lang]) ?? key;
  const unassigned = intakeNotificationRows(lead(), [ADMIN], false)[0];
  const assigned = intakeNotificationRows(lead(), [SALES], true)[0];
  assert.deepEqual(localizeNotification(unassigned, t("zh")), { title: "新线索：Nadia", body: "线索「Nadia」等待分配" });
  assert.deepEqual(localizeNotification(assigned, t("zh")), { title: "新线索：Nadia", body: "线索「Nadia」已分配给你" });
  assert.deepEqual(localizeNotification(unassigned, t("en")), { title: "New lead: Nadia", body: 'Lead "Nadia" is waiting for assignment' });
});

// --- WhatsApp: the SQL function creates the lead; the app notifies from its result --------------------------------
test("WhatsApp ad / direct message: a lead the SQL function just created notifies; a replay does not repeat it", async () => {
  // notifyNewLead reads the real clock inside the ingest helper, so the lead is created "now"
  const db = fakeDb({ leads: [{ ...lead(), created_at: new Date().toISOString() }] });
  const answers = [{ lead_created: true, lead_id: LEAD }, { duplicate: true, lead_id: LEAD }];
  const base = db.rpc;
  db.rpc = async (name, args) => (name === "record_whatsapp_ad_event" ? { data: answers.shift(), error: null } : base(name, args));
  const summary = await recordWhatsAppAdEvents(db, [{ message_id: "m1" }, { message_id: "m1" }]);
  assert.deepEqual([summary.leads_created, summary.duplicate, summary.failed, summary.notify_failed], [1, 1, 0, undefined]);
  assert.equal(db.notifications.length, 3, "one notification per dispatcher, the replay added none");
});

test("WhatsApp: a replay for a lead that is already assigned does not re-notify the owner; a notify failure is counted, not thrown", async () => {
  const fresh = { ...lead({ assigned_to: SALES }), created_at: new Date().toISOString() };
  const db = fakeDb({ leads: [fresh] });
  const base = db.rpc;
  db.rpc = async (name, args) => (name === "record_whatsapp_ad_event" ? { data: { duplicate: true, lead_id: LEAD }, error: null } : base(name, args));
  const summary = await recordWhatsAppAdEvents(db, [{ message_id: "m2" }]);
  assert.equal(db.notifications.length, 0);
  assert.equal(summary.failed, 0);
  const broken = fakeDb({ leads: [{ ...fresh, assigned_to: null }], failRpc: true });
  const baseBroken = broken.rpc;
  broken.rpc = async (name, args) => (name === "record_whatsapp_ad_event" ? { data: { lead_created: true, lead_id: LEAD }, error: null } : baseBroken(name, args));
  const bad = await recordWhatsAppAdEvents(broken, [{ message_id: "m3" }]);
  assert.deepEqual([bad.leads_created, bad.failed, bad.notify_failed], [1, 0, 1]);
});

// --- Meta lead form webhook ----------------------------------------------------------------------------------------
const require = createRequire(import.meta.url);
function loadRoute(file, mocks) {
  const ts = require("typescript");
  const output = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => mocks[name] ?? require(name), exports);
  return exports;
}

test("Meta lead-form webhook: a stored lead notifies the dispatchers once, also when Meta re-delivers", async () => {
  const PAGE = "770232832850803", LEADGEN = "1234567890123456";
  const saved = { ...process.env };
  const db = fakeDb({ leads: [lead({ created_at: new Date().toISOString() })] });
  const lib = await import("../../src/lib/meta-lead-ads.mjs");
  let outcome = "inserted";
  const route = loadRoute("../../src/app/api/meta/leadgen-webhook/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/supabase-admin": { supabaseAdmin: db },
    "@/lib/meta-crm-events": { enqueueMetaCrmStageEvent: async () => "queued" },
    "@/lib/meta-lead-ads.mjs": {
      ...lib,
      resolvePageAccessToken: async () => "t",
      fetchMetaLead: async () => ({ id: LEADGEN, created_time: new Date().toISOString(), platform: "fb", form_id: "998877665544",
        field_data: [{ name: "full_name", values: ["Layla"] }, { name: "phone_number", values: ["+971501234567"] }] }),
      storeMetaLead: async () => ({ outcome, id: LEAD }),
    },
    "@/lib/lead-intake-notify.mjs": await import("../../src/lib/lead-intake-notify.mjs"),
    "@/lib/meta-leadgen-failure.mjs": await import("../../src/lib/meta-leadgen-failure.mjs"),
    "@/lib/logger": { logger: { info() {}, warn() {}, error() {} } },
  });
  try {
    Object.assign(process.env, { META_LEADGEN_ENABLED: "true", META_LEADGEN_VERIFY_TOKEN: "v", META_APP_SECRET: "secret",
      META_LEADS_ACCESS_TOKEN: "token", META_LEADGEN_PAGE_IDS: PAGE });
    const raw = JSON.stringify({ object: "page", entry: [{ id: PAGE, changes: [{ field: "leadgen", value: { page_id: PAGE, leadgen_id: LEADGEN, form_id: "998877665544" } }] }] });
    const post = () => route.POST(new Request("https://example.test", { method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(raw).digest("hex")}` }, body: raw }));
    assert.equal((await post()).status, 200);
    assert.equal(db.notifications.length, 3);
    outcome = "duplicate";
    assert.equal((await post()).status, 200);
    assert.equal(db.notifications.length, 3, "a re-delivery repairs but never repeats");
    outcome = "merged";
    assert.equal((await post()).status, 200);
    assert.equal(db.notifications.length, 3, "an ad click merged into an older lead is not a new lead");
    // A failed ping never turns a stored lead into a 503 (Meta would hammer the webhook).
    outcome = "inserted";
    db.rpc = async () => ({ data: null, error: { code: "x" } });
    assert.equal((await post()).status, 200);
  } finally {
    process.env = saved;
  }
});

// --- Drive-sheet sync -------------------------------------------------------------------------------------------------
test("drive sync: a NEW lead pings (capped per run) and its notifications are an allowed side effect", () => {
  const src = fs.readFileSync(new URL("../../src/app/api/sync/drive-ingest/route.ts", import.meta.url), "utf8");
  assert.match(src, /notifyNewLeadSafe\(supabaseAdmin, \{ id: data\.id,/);
  assert.match(src, /MAX_NEW_LEAD_PINGS_PER_RUN = 10/);
  assert.match(src, /t === "notifications" \? notificationRows : 0/, "the side-effect guard must expect the pings");
  const insertAt = src.indexOf('d.action === "insert"');
  const updateAt = src.indexOf('d.action === "update"');
  assert.ok(src.indexOf("notifyNewLeadSafe(supabaseAdmin") > insertAt && src.indexOf("notifyNewLeadSafe(supabaseAdmin") < updateAt, "only inserts ping, never updates");
});

test("backfill script pings only the leads it inserts", () => {
  const src = fs.readFileSync(new URL("../../scripts/meta-leads-pull.mjs", import.meta.url), "utf8");
  assert.match(src, /result\.outcome === "inserted"[\s\S]{0,120}notifyNewLeadSafe\(db,/);
});
