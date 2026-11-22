// S35: ad leads (Meta form / WhatsApp click-to-chat / website) must be contacted within 1 hour; unassigned ones are
// chased to admin and boss. Pure selection tests plus the hourly runner with a fake database and sender. No network.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  adFirstContactDueMs, adReminderNotificationRows, buildAdReminder, planAdReminders, selectAdUncontacted,
} from "../../src/lib/daily-brief.mjs";

const iso = (s) => new Date(s).toISOString();
const ms = (s) => Date.parse(s);
// Dubai is UTC+4, so 06:00Z is 10:00 in Dubai.
const lead = (o = {}) => ({ id: "l1", customer_name: "Omar Test", source: "fb", source_channel: "meta_lead_form", archived: false, stage: "new",
  assigned_to: null, created_at: iso("2026-11-21T06:00:00Z"), ...o });

test("deadline: one hour inside Dubai 09:00-21:00, otherwise 10:00 (same day before 09:00, next day after 20:00)", () => {
  const due = (utc) => new Date(adFirstContactDueMs(ms(utc))).toISOString();
  assert.equal(due("2026-11-21T06:00:00Z"), "2026-11-21T07:00:00.000Z", "10:00 Dubai -> 11:00");
  assert.equal(due("2026-11-21T05:00:00Z"), "2026-11-21T06:00:00.000Z", "09:00 Dubai -> 10:00");
  assert.equal(due("2026-11-21T16:00:00Z"), "2026-11-21T17:00:00.000Z", "20:00 Dubai -> 21:00, still inside working hours");
  assert.equal(due("2026-11-21T16:30:00Z"), "2026-11-22T06:00:00.000Z", "20:30 Dubai cannot be answered inside working hours -> 10:00 next day");
  assert.equal(due("2026-11-21T19:00:00Z"), "2026-11-22T06:00:00.000Z", "23:00 Dubai -> 10:00 next day");
  assert.equal(due("2026-11-21T23:30:00Z"), "2026-11-22T06:00:00.000Z", "03:30 Dubai (22 Nov) -> 10:00 the same Dubai day");
  assert.equal(due("2026-11-22T04:59:00Z"), "2026-11-22T06:00:00.000Z", "08:59 Dubai -> 10:00 the same day");
});

test("selection: ad leads past the deadline with no contact, assigned or not; everything else stays out", () => {
  const now = new Date("2026-11-21T07:30:00Z"); // 11:30 Dubai
  const pick = (o) => selectAdUncontacted({ leads: [lead(o)], now }).map((i) => i.lead_id);
  assert.deepEqual(pick({}), ["l1"], "unassigned Meta form lead, 1.5h old");
  assert.deepEqual(pick({ assigned_to: "u1" }), ["l1"], "assigned lead too");
  assert.deepEqual(pick({ source: "website", source_channel: "website", source_platform: "website" }), ["l1"]);
  assert.deepEqual(pick({ source: "whatsapp", source_channel: "whatsapp_ctwa", ctwa_clid: "AbC123_xyz-0" }), ["l1"]);
  assert.deepEqual(pick({ created_at: iso("2026-11-21T06:45:00Z") }), [], "45 minutes old: not yet");
  assert.deepEqual(pick({ source: "whatsapp", source_channel: "whatsapp_direct" }), [], "organic WhatsApp is not an ad lead");
  assert.deepEqual(pick({ source: "show_room", source_channel: null }), []);
  assert.deepEqual(pick({ last_contact_date: "2026-11-21" }), [], "contacted");
  assert.deepEqual(pick({ stage: "contacted" }), []);
  assert.deepEqual(pick({ created_at: iso("2026-11-16T06:00:00Z") }), [], "older than 3 days belongs to the 24 hour reminder");
  assert.deepEqual(pick({ archived: true }), []);
  assert.deepEqual(pick({ hold_since: "2026-11-21" }), []);
  assert.deepEqual(selectAdUncontacted({ leads: [lead()], logLeadIds: new Set(["l1"]), now }), [], "a follow-up log counts as contact");
  assert.deepEqual(selectAdUncontacted({ leads: [lead()], excludedTestIds: new Set(["l1"]), now }), []);
  // night arrival is only due at 10:00
  const night = lead({ created_at: iso("2026-11-20T19:00:00Z") }); // 23:00 Dubai
  assert.deepEqual(selectAdUncontacted({ leads: [night], now: new Date("2026-11-21T05:30:00Z") }), [], "09:30 Dubai: not due before 10:00");
  assert.equal(selectAdUncontacted({ leads: [night], now: new Date("2026-11-21T06:05:00Z") }).length, 1, "10:05 Dubai: due");
});

const PROFILES = [
  { id: "ad", full_name: "Admin Sam", role: "admin", phone: "0501110001", is_active: true, email: "sam@example.test" },
  { id: "bo", full_name: "Boss Tanya", role: "boss", phone: "0501110002", is_active: true, email: "t@example.test" },
  { id: "op", full_name: "Operator", role: "operator", phone: "0501110003", is_active: true, email: "o@example.test" },
  { id: "s1", full_name: "Sales One", role: "sales", phone: "0501110004", is_active: true, email: "s1@example.test" },
  { id: "s2", full_name: "Sales Gone", role: "sales", phone: "0501110005", is_active: false, email: "s2@example.test" },
  { id: "nb", full_name: "No Phone Admin", role: "admin", phone: null, is_active: true, email: "n@example.test" },
  { id: "qa", full_name: "QA Admin", role: "admin", phone: "0501110009", is_active: true, email: "x@qa.newme.ae" },
];
const item = (o = {}) => ({ lead_id: "l1", assigned_to: null, first_name: "Omar", channel: "fb_form", overdue_minutes: 90, ...o });

test("planning: owner gets their own; nobody-owned leads go to every active admin and boss (not operator, sales or system accounts)", () => {
  const plan = planAdReminders([item(), item({ lead_id: "l2", assigned_to: "s1" }), item({ lead_id: "l3", assigned_to: "s2" })], PROFILES);
  const by = Object.fromEntries(plan.people.map((p) => [p.id, p.items.map((i) => i.lead_id)]));
  assert.deepEqual(by, { ad: ["l1", "l3"], bo: ["l1", "l3"], nb: ["l1", "l3"], s1: ["l2"] }, "an inactive owner counts as nobody");
  assert.deepEqual(plan.sendable.map((p) => p.id).sort(), ["ad", "bo", "s1"]);
  assert.deepEqual(plan.missingPhone.map((p) => p.id), ["nb"]);
  assert.equal(plan.people.find((p) => p.id === "ad").manager, true);
  assert.equal(plan.people.find((p) => p.id === "s1").manager, false);
});

test("planning: a lead already reminded to a person is not repeated to that person, but a new recipient still gets it", () => {
  const plan = planAdReminders([item()], PROFILES, new Set(["ad:l1"]));
  assert.deepEqual(plan.people.map((p) => p.id).sort(), ["bo", "nb"]);
  const owned = planAdReminders([item({ assigned_to: "s1" })], PROFILES, new Set(["ad:l1", "bo:l1"]));
  assert.deepEqual(owned.people.map((p) => p.id), ["s1"], "it was assigned meanwhile: the new owner is told too");
});

test("wording: manager and owner versions, one line, at most 400 characters, no phone numbers", () => {
  const items = Array.from({ length: 7 }, (_, i) => item({ lead_id: `l${i}`, first_name: `客户${i}`, overdue_minutes: 90 + i * 60 }));
  const manager = buildAdReminder({ name: "Sam", manager: true, items });
  assert.match(manager, /^Sam，有7条广告线索未分配且超1小时无人联系：客户0·FB表单·超时2小时/);
  assert.match(manager, /未分配，请尽快安排跟进/);
  assert.ok(!manager.includes("派单"), "the dispatch page is not today's flow");
  const owner = buildAdReminder({ name: "Sales One", manager: false, items: items.slice(0, 2) });
  assert.match(owner, /^Sales One，您有2条广告线索超1小时未联系/);
  for (const text of [manager, owner]) assert.ok([...text].length <= 400 && !text.includes("\n") && !/\d{7,}/.test(text));
  const rows = adReminderNotificationRows({ id: "ad", items: items.slice(0, 2) });
  assert.deepEqual(rows.map((r) => r.event_key), ["lead_uncontacted_1h:l0", "lead_uncontacted_1h:l1"]);
  assert.equal(rows[0].body, 'Lead "客户0" has had no first contact for over 1 hour');
});

// --- the hourly runner ---------------------------------------------------------------------------------------------
class Query {
  constructor(rows) { this.rows = rows; }
  select() { return this; } eq() { return this; } or() { return this; } gte() { return this; } gt() { return this; } order() { return this; } in() { return this; }
  range() { return this; } limit() { return this; }
  then(res, rej) { return Promise.resolve({ data: this.rows, error: null, count: this.rows.length }).then(res, rej); }
}
const makeDb = (leads) => {
  const tables = { lead_dispatch_state: [], leads, profiles: PROFILES, follow_up_logs: [], transfer_history: [] };
  const bell = [];
  return { bell, from: (name) => new Query(tables[name] ?? []), rpc: async (name, args) => { bell.push(...args.p_notifications); return { data: { created: args.p_notifications.length, skipped: 0 }, error: null }; } };
};

test("runner: an unassigned ad lead reaches admin and boss on the BELL only; WhatsApp to them needs its own flag; nothing repeats", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/s35-`);
  const { runReminders } = await import("../../scripts/daily-brief.mjs");
  const sent = [];
  const send = async (m) => { sent.push(m); return true; };
  const env = { NEWME_AD_LEAD_REMINDER_ENABLED: "true" };
  const noon = new Date("2026-11-21T08:00:00Z"); // 12:00 Dubai; the lead arrived 10:00 Dubai
  const db = makeDb([lead()]);
  const dry = await runReminders(db, { now: noon, send, env });
  assert.deepEqual([dry.mode, dry.ad_overdue, dry.ad_unassigned, dry.ad_people, dry.ad_missing_phone, dry.ad_sent], ["dry_run", 1, 1, 3, 1, 0]);
  assert.deepEqual([sent.length, db.bell.length], [0, 0], "a dry run sends and writes nothing");
  const first = await runReminders(db, { execute: true, now: noon, send, env });
  assert.deepEqual([first.ad_sent, first.ad_failed, first.failed, first.sent], [0, 0, 0, 0]);
  assert.deepEqual(sent, [], "no WhatsApp to the bosses by default");
  assert.deepEqual(db.bell.map((r) => r.user_id).sort(), ["ad", "bo", "nb"]);
  // with the admin WhatsApp flag: admin and boss (not operator); the admin without a phone stays bell only
  const on = { ...env, NEWME_AD_LEAD_REMINDER_ADMIN_WHATSAPP: "true" };
  const second = await runReminders(db, { execute: true, now: new Date("2026-11-21T09:00:00Z"), send, env: on });
  assert.equal(second.ad_sent, 2);
  assert.deepEqual(sent.map((m) => m.number).sort(), ["971501110001", "971501110002"]);
  assert.ok(sent.every((m) => /未分配，请尽快安排跟进/.test(m.text) && !m.text.includes("派单")));
  const later = await runReminders(db, { execute: true, now: new Date("2026-11-21T10:00:00Z"), send, env: on });
  assert.deepEqual([later.ad_sent, sent.length], [0, 2], "one reminder per lead per threshold");
});

test("runner: the ad reminder has its own switch (default off) independent of the 24 hour one", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/s35-`);
  const { runReminders } = await import("../../scripts/daily-brief.mjs");
  const noon = new Date("2026-11-21T08:00:00Z");
  const sent = [];
  const send = async (m) => { sent.push(m); return true; };
  const db = makeDb([lead({ assigned_to: "s1" })]);
  const only24 = await runReminders(db, { execute: true, now: noon, send, env: { NEWME_LEAD_REMINDER_ENABLED: "true" } });
  assert.deepEqual([only24.ad_sent, db.bell.length], [0, 0], "the old switch alone no longer starts the ad reminder");
  const adOnly = await runReminders(db, { execute: true, now: noon, send, env: { NEWME_AD_LEAD_REMINDER_ENABLED: "true" } });
  assert.deepEqual([adOnly.mode, adOnly.ad_sent, adOnly.sent], ["execute", 1, 0], "owner gets WhatsApp; the 24 hour job stays off");
  assert.equal(db.bell.length, 1);
});

test("runner: more than 64 bell rows go out in chunks of 64", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/s35-`);
  const { runReminders } = await import("../../scripts/daily-brief.mjs");
  const leads = Array.from({ length: 70 }, (_, i) => lead({ id: `m${i}`, created_at: iso("2026-11-21T06:00:00Z") }));
  const db = makeDb(leads);
  const calls = [];
  const base = db.rpc;
  db.rpc = async (name, args) => { calls.push(args.p_notifications.length); return base(name, args); };
  const r = await runReminders(db, { execute: true, now: new Date("2026-11-21T08:00:00Z"), send: async () => true, env: { NEWME_AD_LEAD_REMINDER_ENABLED: "true" } });
  assert.equal(r.ad_bell_failed, 0);
  assert.ok(calls.length >= 6 && calls.every((n) => n <= 64), calls.join(","));
  assert.equal(db.bell.length, 70 * 3);
});

test("runner: a failed ad reminder is retried next hour; an assigned lead goes to its owner only; contacted leads stop", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/s35-`);
  const { runReminders } = await import("../../scripts/daily-brief.mjs");
  const env = { NEWME_AD_LEAD_REMINDER_ENABLED: "true" };
  const noon = new Date("2026-11-21T08:00:00Z");
  const owned = makeDb([lead({ assigned_to: "s1" })]);
  const failed = await runReminders(owned, { execute: true, now: noon, send: async () => false, env });
  assert.deepEqual([failed.ad_sent, failed.ad_failed, failed.failed], [0, 1, 1]);
  const sent = [];
  const retry = await runReminders(owned, { execute: true, now: new Date("2026-11-21T09:00:00Z"), send: async (m) => (sent.push(m), true), env });
  assert.deepEqual([retry.ad_sent, sent.map((m) => m.number)], [1, ["971501110004"]]);
  assert.match(sent[0].text, /^Sales One，您有1条广告线索超1小时未联系/);
  const contacted = makeDb([lead({ last_contact_date: "2026-11-21" })]);
  assert.equal((await runReminders(contacted, { execute: true, now: noon, send: async () => true, env })).ad_overdue, 0);
});

test("runner: outside the window or switched off the ad reminder does nothing either", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/s35-`);
  const { runReminders } = await import("../../scripts/daily-brief.mjs");
  const exploding = { from() { throw new Error("database must not be read"); } };
  assert.equal((await runReminders(exploding, { execute: true, now: new Date("2026-11-21T08:00:00Z"), send: async () => true, env: {} })).mode, "disabled");
  assert.equal((await runReminders(exploding, { execute: true, now: new Date("2026-11-21T20:00:00Z"), send: async () => true, env: { NEWME_AD_LEAD_REMINDER_ENABLED: "true" } })).mode, "outside_window");
});
