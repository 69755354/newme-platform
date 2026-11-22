import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  assignedAtMs, buildBrief, buildReminder, channelOf, countNewLeads, groupUncontactedForBrief, hasFirstContact, inReminderWindow, planReminders,
  selectUncontacted, summarizeQuotes, summarizeSpend, yesterdayBounds,
} from "../../src/lib/daily-brief.mjs";

// Fixtures only: invented ids and names, no real customer data. Dubai is UTC+4.
const NOW = new Date("2026-11-21T04:05:00Z"); // Sat 08:05 Dubai; "yesterday" is 2026-11-20 Dubai
const at = (iso) => new Date(iso).toISOString();
const lead = (o = {}) => ({ id: "l1", customer_name: "Omar Test", source: "fb", archived: false, stage: "new", assigned_to: "u1",
  created_at: at("2026-11-19T06:00:00Z"), ...o });

test("yesterday is the previous Dubai calendar day", () => {
  const y = yesterdayBounds(NOW);
  assert.equal(y.key, "2026-11-20");
  assert.equal(y.start.toISOString(), "2026-11-19T20:00:00.000Z");
  assert.equal(y.end.toISOString(), "2026-11-20T20:00:00.000Z");
});

test("channels: FB form, Instagram, WhatsApp, website, everything else", () => {
  assert.deepEqual(["fb", "ins", "whatsapp", "website", "show_room", undefined].map((source) => channelOf({ source })),
    ["fb_form", "instagram", "whatsapp", "website", "other", "other"]);
  assert.equal(channelOf({ source: "unknown", source_platform: "Instagram" }), "instagram");
});

test("new leads: Dubai day edges, archived, synthetic QA and test records are excluded, ad leads counted", () => {
  const leads = [
    lead({ id: "a", created_at: at("2026-11-19T20:00:00Z") }),                 // first instant of yesterday
    lead({ id: "b", created_at: at("2026-11-20T19:59:59Z"), source: "ins", ad_id: "123" }),
    lead({ id: "c", created_at: at("2026-11-20T20:00:00Z") }),                 // today
    lead({ id: "d", created_at: at("2026-11-20T10:00:00Z"), archived: true }),
    lead({ id: "e", created_at: at("2026-11-20T10:00:00Z"), source: "synthetic_qa" }),
    lead({ id: "f", created_at: at("2026-11-20T10:00:00Z"), source: "whatsapp" }),
    lead({ id: "g", created_at: at("2026-11-10T10:00:00Z"), source: "website" }), // prior window
  ];
  const r = countNewLeads(leads, { now: NOW, excludedTestIds: new Set(["f"]) });
  assert.equal(r.total, 2);
  assert.deepEqual(r.byChannel, { fb_form: 1, instagram: 1, whatsapp: 0, website: 0, other: 0 });
  assert.equal(r.adLeads, 2); // fb source and an ad id both count as ad leads
  assert.equal(r.prior.website, 1);
});

test("first contact: OS fields, follow-up log, stage and the sheet's first contact / Day 1 feedback all count", () => {
  assert.equal(hasFirstContact(lead()), false);
  assert.equal(hasFirstContact(lead({ last_contact_date: "2026-11-19" })), true);
  // intake time is not contact: a Meta form / website / WhatsApp lead gets first_touch_at the moment it arrives
  assert.equal(hasFirstContact(lead({ first_touch_at: "2026-11-19T08:00:00Z" })), false);
  assert.equal(hasFirstContact(lead({ wa_first_reply_at: "2026-11-19T08:05:00Z" })), true);
  assert.equal(hasFirstContact(lead({ followup_count: 1 })), true);
  assert.equal(hasFirstContact(lead({ stage: "contacted" })), true);
  assert.equal(hasFirstContact(lead({ no_answer_flag: true })), true);
  assert.equal(hasFirstContact(lead(), new Set(["l1"])), true);
  assert.equal(hasFirstContact(lead({ drive_sync: { first_contact_at: "2026-11-19T08:00:00Z" } })), true);
  assert.equal(hasFirstContact(lead({ drive_sync: { contact_days_filled: 1 } })), true);
  assert.equal(hasFirstContact(lead({ drive_sync: { contact_days_filled: 0, first_contact_at: " " } })), false);
});

test("assigned time is the newest transfer to the current assignee, else creation", () => {
  const l = lead();
  assert.equal(assignedAtMs(l, []), Date.parse(l.created_at));
  const transfers = [
    { lead_id: "l1", to_user_id: "u1", created_at: at("2026-11-20T01:00:00Z") },
    { lead_id: "l1", to_user_id: "u9", created_at: at("2026-11-20T23:00:00Z") }, // someone else: ignored
    { lead_id: "l1", to_user_id: "u1", created_at: at("2026-11-20T05:00:00Z") },
  ];
  assert.equal(assignedAtMs(l, transfers), Date.parse("2026-11-20T05:00:00Z"));
});

test("uncontacted: only leads assigned over 24 hours ago, no contact, open, reportable and not stale", () => {
  const leads = [
    lead({ id: "old", created_at: at("2026-11-19T06:00:00Z") }),                       // 46h
    lead({ id: "fresh", created_at: at("2026-11-20T08:00:00Z") }),                     // 20h
    lead({ id: "edge", created_at: at("2026-11-20T04:05:00Z") }),                      // exactly 24h: not yet
    lead({ id: "reassigned", created_at: at("2026-11-10T06:00:00Z") }),                // old lead, transferred 5h ago
    lead({ id: "contacted", created_at: at("2026-11-18T06:00:00Z"), last_contact_date: "2026-11-19" }),
    lead({ id: "sheet", created_at: at("2026-11-18T06:00:00Z"), drive_sync: { contact_days_filled: 2 } }),
    lead({ id: "logged", created_at: at("2026-11-18T06:00:00Z") }),
    lead({ id: "arch", created_at: at("2026-11-18T06:00:00Z"), archived: true }),
    lead({ id: "test", created_at: at("2026-11-18T06:00:00Z") }),
    lead({ id: "won", created_at: at("2026-11-18T06:00:00Z"), final_status: "won" }),
    lead({ id: "hold", created_at: at("2026-11-18T06:00:00Z"), hold_since: "2026-11-19T00:00:00Z" }),
    lead({ id: "none", created_at: at("2026-11-18T06:00:00Z"), assigned_to: null }),
    lead({ id: "ancient", created_at: at("2026-09-01T06:00:00Z") }),
  ];
  const transfers = [{ lead_id: "reassigned", to_user_id: "u1", created_at: at("2026-11-20T23:00:00Z") }];
  const r = selectUncontacted({ leads, transfers, logLeadIds: new Set(["logged"]), excludedTestIds: new Set(["test"]), now: NOW });
  assert.deepEqual(r.map((x) => x.lead_id), ["none", "old"]); // "none" has no OS owner: still counted, as unassigned
  assert.equal(r[0].assigned_to, null);
  assert.equal(r[1].age_hours, 46);
  assert.equal(r[1].first_name, "Omar");
  assert.equal(r[1].channel, "fb_form");
});

test("plan: grouped per salesperson, phones normalised, missing phone and system accounts reported or skipped", () => {
  const unc = [
    { lead_id: "1", assigned_to: "u1", age_hours: 30, first_name: "A", channel: "fb_form" },
    { lead_id: "2", assigned_to: "u1", age_hours: 60, first_name: "B", channel: "whatsapp" },
    { lead_id: "3", assigned_to: "u2", age_hours: 26, first_name: "C", channel: "other" },
    { lead_id: "4", assigned_to: "u3", age_hours: 90, first_name: "D", channel: "other" },
  ];
  const profiles = [
    { id: "u1", full_name: "Sales One", phone: "050 123 4567" },
    { id: "u2", full_name: "Sales Two", phone: null },
    { id: "u3", full_name: "QA", phone: "0501111111", email: "x@qa.newme.ae" },
  ];
  const plan = planReminders(unc, profiles);
  assert.equal(plan.people.length, 2);
  assert.equal(plan.sendable[0].number, "971501234567");
  assert.equal(plan.sendable[0].oldest_hours, 60);
  assert.deepEqual(plan.missingPhone.map((p) => p.name), ["Sales Two"]);
});

test("quotes: OS quotation wins over the sheet value, one per lead, AED only, drafts and other days ignored", () => {
  const leadsById = new Map(["q1", "q2", "q3", "q4", "q5"].map((id) => [id, lead({ id })]));
  const quotations = [
    { lead_id: "q1", total_amount: 1000, currency: "AED", status: "sent", sent_at: at("2026-11-20T06:00:00Z") },
    { lead_id: "q1", total_amount: 1500, currency: "AED", status: "sent", sent_at: at("2026-11-20T07:00:00Z") },
    { lead_id: "q2", total_amount: 200, currency: "AED", status: "draft", sent_at: null, created_at: at("2026-11-20T06:00:00Z") },
    { lead_id: "q3", total_amount: 300, currency: "USD", status: "sent", sent_at: at("2026-11-20T06:00:00Z") },
    { lead_id: "q4", total_amount: 400, currency: "AED", status: "sent", sent_at: at("2026-11-21T01:00:00Z") },
  ];
  const sheetLeads = [
    lead({ id: "q1", quotation_value: 999, drive_sync: { quote_at: at("2026-11-20T06:00:00Z") } }), // already counted via OS
    lead({ id: "q5", quotation_value: 2500, drive_sync: { quote_at: at("2026-11-20T09:00:00Z") } }),
    lead({ id: "q6", quotation_value: 800, drive_sync: { quote_at: at("2026-11-18T09:00:00Z") } }),
    lead({ id: "q7", quotation_value: 700, quotation_sent_date: "2026-11-20" }),
  ];
  const r = summarizeQuotes({ quotations, sheetLeads, leadsById, now: NOW });
  assert.deepEqual(r, { count: 3, total: 4700 }); // q1 1500 + q5 2500 + q7 700
});

test("spend: omitted without a known amount for yesterday; cost per lead needs ad leads", () => {
  assert.equal(summarizeSpend([], 3, { now: NOW }), null);
  assert.equal(summarizeSpend([{ spend_date: "2026-11-19", amount: 50 }, { spend_date: "2026-11-20", amount: null }], 3, { now: NOW }), null);
  assert.deepEqual(summarizeSpend([{ spend_date: "2026-11-20", amount: 100 }, { spend_date: "2026-11-20", amount: "50.5" }], 3, { now: NOW }), { spend: 150.5, cpl: 50.17 });
  assert.deepEqual(summarizeSpend([{ spend_date: "2026-11-20", amount: 100 }], 0, { now: NOW }), { spend: 100, cpl: null });
});

const brief = (over = {}) => buildBrief({ dateKey: "2026-11-20",
  leads: { total: 11, byChannel: { fb_form: 5, instagram: 3, whatsapp: 2, website: 1, other: 0 }, prior: { fb_form: 40, instagram: 20, whatsapp: 10, website: 6, other: 0 }, adLeads: 8 },
  people: [{ name: "甲", items: [1, 2, 3], oldest_hours: 52 }, { name: "乙", items: [1], oldest_hours: 26 }], missingPhone: [],
  quotes: { count: 4, total: 123400 }, spend: { spend: 560, cpl: 70 }, ...over });

test("brief: short Chinese line with every requested figure and no attention line when nothing is off", () => {
  const text = brief();
  assert.match(text, /^2026-11-20日报；新线索11条（FB表单5 Instagram3 WhatsApp2 网站1 其他0）；/);
  assert.match(text, /24小时未记录联系：甲3条\(最久2天\)、乙1条\(最久26小时\)/);
  assert.match(text, /昨日报价4单，合计AED 123,400/);
  assert.match(text, /广告花费AED 560，单条线索AED 70/);
  assert.ok(!text.includes("需要注意"));
  assert.ok([...text].length <= 400);
});

test("brief: no spend line without spend data; attention for uncontacted over 5, a silent usual channel and missing phones", () => {
  const people = [{ name: "甲", items: new Array(6).fill(1), oldest_hours: 100 }];
  const text = brief({ spend: null, people, missingPhone: [{ name: "丙" }],
    leads: { total: 6, byChannel: { fb_form: 6, instagram: 0, whatsapp: 0, website: 0, other: 0 }, prior: { fb_form: 40, instagram: 20, whatsapp: 2, website: 6, other: 0 }, adLeads: 6 } });
  assert.ok(!text.includes("广告花费"));
  assert.match(text, /最久4天/);
  assert.match(text, /需要注意：未记录联系共6条；Instagram、网站昨日0条线索；丙无手机号，提醒未发$/);
});

test("brief: a long salesperson list is shortened to stay within 400 characters", () => {
  const people = Array.from({ length: 40 }, (_, i) => ({ name: `销售${i}号`, items: [1, 2], oldest_hours: 30 + i }));
  const text = brief({ people });
  assert.ok([...text].length <= 400);
  assert.match(text, /等40人/);
});

test("reminder: count plus customer first name, channel and age, no phone or contact data, within the limit", () => {
  const person = { name: "Sales One", items: Array.from({ length: 7 }, (_, i) => ({ first_name: `客户${i}`, channel: "whatsapp", age_hours: 30 + i * 24 })) };
  const text = buildReminder(person);
  assert.match(text, /^Sales One，您有7条线索分配超24小时仍未记录首次联系：客户0·WhatsApp·30小时，客户1·WhatsApp·2天/);
  assert.match(text, /等共7条/);
  assert.ok(!/\d{7,}/.test(text));
  assert.ok([...text].length <= 400 && !text.includes("\n"));
});

test("reminder window: Dubai 09:00 through the 21:00 run only", () => {
  const run = (utcHour) => inReminderWindow(new Date(`2026-11-21T${String(utcHour).padStart(2, "0")}:00:00Z`));
  assert.deepEqual([4, 5, 17, 18].map(run), [false, true, true, false]);
});

// --- runner with a fake database and a fake sender: no network -----------------------------------------------------
class Query {
  constructor(rows) { this.rows = rows; }
  select() { return this; } eq() { return this; } or() { return this; } gte() { return this; } gt() { return this; } order() { return this; } in() { return this; }
  range() { return this; } limit() { return this; }
  then(res, rej) { return Promise.resolve({ data: this.rows, error: null, count: this.rows.length }).then(res, rej); }
}
const fakeDb = (tables) => ({ from: (name) => new Query(tables[name] ?? []) });
const tables = () => ({
  lead_dispatch_state: [],
  // Showroom leads: the 24 hour reminder applies to every channel; the 1 hour ad-lead reminder (S35) does not, so these
  // runner tests keep covering the 24 hour job on its own. The ad-lead reminder has its own runner tests below.
  leads: [lead({ id: "x1", created_at: at("2026-11-19T06:00:00Z"), source: "show_room" }), lead({ id: "x2", created_at: at("2026-11-20T10:00:00Z"), source: "show_room" })],
  profiles: [{ id: "u1", full_name: "Sales One", phone: "0501234567", is_active: true }],
  follow_up_logs: [], transfer_history: [], quotations: [], ad_spend: [{ spend_date: "2026-11-20", amount: 90 }],
});

test("runner: dry run reads and prints counts only; it never sends or writes", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/brief-`);
  const { runBrief, runReminders } = await import("../../scripts/daily-brief.mjs");
  const sent = [];
  const send = async (m) => { sent.push(m); return true; };
  const b = await runBrief(fakeDb(tables()), { now: NOW, send, env: { NEWME_DAILY_BRIEF_ENABLED: "true" } });
  assert.equal(b.mode, "dry_run");
  assert.equal(b.new_leads, 1);
  assert.equal(b.spend_line, true);
  const r = await runReminders(fakeDb(tables()), { now: NOW, send, env: { NEWME_LEAD_REMINDER_ENABLED: "true" } });
  assert.equal(r.mode, "dry_run");
  assert.deepEqual([r.salespeople_with_uncontacted, r.due, r.sent], [1, 1, 0]);
  assert.deepEqual(sent, []);
  assert.deepEqual(readdirSync(process.env.NEWME_BRIEF_STATE_DIR), []);
  assert.ok(!JSON.stringify([b, r]).includes("Sales One"), "counts only: no names");
});

test("runner: both jobs are off without their switch, even with --execute", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/brief-`);
  const { runBrief, runReminders } = await import("../../scripts/daily-brief.mjs");
  const sent = [];
  const send = async (m) => { sent.push(m); return true; };
  assert.equal((await runBrief(fakeDb(tables()), { execute: true, now: NOW, send, env: {} })).mode, "disabled");
  assert.equal((await runReminders(fakeDb(tables()), { execute: true, now: new Date("2026-11-21T06:00:00Z"), send, env: { NEWME_LEAD_REMINDER_ENABLED: "false" } })).mode, "disabled");
  assert.deepEqual(sent, []);
  // Switched off (or out of hours), the hourly/daily timer run never reads the database, so it cannot fail and alert.
  const exploding = { from() { throw new Error("database must not be read while switched off"); } };
  assert.equal((await runBrief(exploding, { execute: true, now: NOW, send, env: {} })).mode, "disabled");
  assert.equal((await runReminders(exploding, { execute: true, now: NOW, send, env: {} })).mode, "disabled");
  assert.equal((await runReminders(exploding, { execute: true, now: NOW, send, env: { NEWME_LEAD_REMINDER_ENABLED: "true" } })).mode, "outside_window");
});

test("runner: brief goes out once a day; a reminder goes to each salesperson once a day and only inside the window", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/brief-`);
  const { runBrief, runReminders } = await import("../../scripts/daily-brief.mjs");
  const sent = [];
  const send = async (m) => { sent.push(m); return true; };
  const on = { NEWME_DAILY_BRIEF_ENABLED: "true", NEWME_LEAD_REMINDER_ENABLED: "true" };
  assert.equal((await runBrief(fakeDb(tables()), { execute: true, now: NOW, send, env: on })).sent, true);
  assert.equal((await runBrief(fakeDb(tables()), { execute: true, now: NOW, send, env: on })).mode, "already_sent");
  assert.equal((await runReminders(fakeDb(tables()), { execute: true, now: NOW, send, env: on })).mode, "outside_window"); // 08:05 Dubai
  const noon = new Date("2026-11-21T08:00:00Z");
  assert.equal((await runReminders(fakeDb(tables()), { execute: true, now: noon, send, env: on })).sent, 1);
  assert.equal((await runReminders(fakeDb(tables()), { execute: true, now: new Date("2026-11-21T09:00:00Z"), send, env: on })).sent, 0);
  assert.deepEqual(sent.map((m) => [m.key, m.number ?? null]), [["newme-daily-brief", null], ["newme-lead-reminder", "971501234567"]]);
});

test("runner: a failed reminder is retried next hour and reported as a failure", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/brief-`);
  const { runReminders } = await import("../../scripts/daily-brief.mjs");
  const on = { NEWME_LEAD_REMINDER_ENABLED: "true" };
  const noon = new Date("2026-11-21T08:00:00Z");
  const failed = await runReminders(fakeDb(tables()), { execute: true, now: noon, send: async () => false, env: on });
  assert.deepEqual([failed.sent, failed.failed], [0, 1]);
  const retry = await runReminders(fakeDb(tables()), { execute: true, now: new Date("2026-11-21T09:00:00Z"), send: async () => true, env: on });
  assert.deepEqual([retry.sent, retry.failed], [1, 0]);
});

test("bulk-imported sheet history is neither a new lead nor an uncontacted reminder", () => {
  const y = yesterdayBounds(NOW);
  const at = new Date(y.start.getTime() + 3600e3).toISOString();
  const old = new Date(NOW.getTime() - 3 * 24 * 3600e3).toISOString();
  const leads = [
    { id: "n1", source: "whatsapp", created_at: at, archived: false },
    { id: "i1", source: "whatsapp", created_at: at, archived: false, imported_at: at },
    { id: "u1", source: "whatsapp", created_at: old, archived: false, assigned_to: "s1", stage: "new" },
    { id: "u2", source: "whatsapp", created_at: old, archived: false, assigned_to: "s1", stage: "new", imported_at: old },
  ];
  assert.equal(countNewLeads(leads, { now: NOW }).total, 1);
  assert.deepEqual(selectUncontacted({ leads, now: NOW }).map((l) => l.lead_id), ["u1", "n1"]); // n1 has no OS owner but is over 24h old: counted
});

// --- leads nobody owns in OS (sales work in the Google sheets) -----------------------------------------------------
const quietLeads = { byChannel: { fb_form: 3, instagram: 0, whatsapp: 0, website: 0, other: 0 }, prior: { fb_form: 0, instagram: 0, whatsapp: 0, website: 0, other: 0 } };

test("all leads unassigned in OS: the brief shows them, not 0", () => {
  const leads = Array.from({ length: 3 }, (_, i) => lead({ id: `n${i}`, assigned_to: null, created_at: at("2026-11-18T06:00:00Z") }));
  const un = selectUncontacted({ leads, now: NOW });
  assert.equal(un.length, 3);
  const groups = groupUncontactedForBrief(un, []);
  assert.deepEqual(groups.map((g) => [g.name, g.items.length, g.unassigned]), [["未分配", 3, true]]);
  const text = buildBrief({ dateKey: "2026-11-20", leads: { total: 3, adLeads: 3, ...quietLeads }, groups, quotes: { count: 0, total: 0 } });
  assert.match(text, /24小时未记录联系：未分配3条/);
  assert.match(text, /需要注意：未分配3条无人认领/);
  assert.ok(!/未联系：无/.test(text));
});

test("sheet owner from the S29 sync groups unassigned leads by name; OS profile name wins and merges", () => {
  const leads = [
    lead({ id: "a", assigned_to: null, drive_sync: { sheet_owner: "Faizan" }, created_at: at("2026-11-18T06:00:00Z") }),
    lead({ id: "b", assigned_to: null, drive_sync: { sheet_owner: "Faizan" }, created_at: at("2026-11-17T06:00:00Z") }),
    lead({ id: "c", assigned_to: null, created_at: at("2026-11-18T06:00:00Z") }),
    lead({ id: "d", assigned_to: "u1", created_at: at("2026-11-18T06:00:00Z") }),
  ];
  const profiles = [{ id: "u1", full_name: "Faizan", phone: "0501234567", is_active: true }];
  const un = selectUncontacted({ leads, now: NOW });
  const groups = groupUncontactedForBrief(un, profiles);
  assert.deepEqual(groups.map((g) => [g.name, g.items.length]), [["Faizan", 3], ["未分配", 1]]);
  const text = buildBrief({ dateKey: "2026-11-20", leads: { total: 4, adLeads: 0, ...quietLeads }, groups, quotes: { count: 0, total: 0 } });
  assert.match(text, /Faizan3条.*未分配1条/);
  assert.match(text, /需要注意：未分配1条无人认领/);
});

test("reminders still need a resolvable OS profile: unowned leads are in the brief but never reminded", () => {
  const leads = [lead({ id: "a", assigned_to: null, drive_sync: { sheet_owner: "Faizan" }, created_at: at("2026-11-18T06:00:00Z") })];
  const un = selectUncontacted({ leads, now: NOW });
  const plan = planReminders(un, [{ id: "u1", full_name: "Faizan", phone: "0501234567", is_active: true }]);
  assert.deepEqual([plan.people.length, plan.sendable.length], [0, 0]);
});

test("runner: every new lead unassigned in OS, brief counts them (not a false all-clear) and reminders send nothing", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/brief-`);
  const { runBrief, runReminders } = await import("../../scripts/daily-brief.mjs");
  const t = () => ({ ...tables(), leads: [
    lead({ id: "x1", assigned_to: null, created_at: at("2026-11-19T06:00:00Z") }),
    lead({ id: "x2", assigned_to: null, created_at: at("2026-11-20T10:00:00Z"), drive_sync: { sheet_owner: "Assem" } }),
  ] });
  const sent = [];
  const b = await runBrief(fakeDb(t()), { execute: true, now: NOW, send: async (m) => { sent.push(m); return true; }, env: { NEWME_DAILY_BRIEF_ENABLED: "true" } });
  assert.equal(b.uncontacted, 1); // x2 is under 24h; x1 is 46h old
  assert.equal(b.unassigned, 1);
  assert.match(sent[0].text, /24小时未记录联系：未分配1条/);
  const r = await runReminders(fakeDb(t()), { now: NOW, env: { NEWME_LEAD_REMINDER_ENABLED: "true" } });
  assert.deepEqual([r.uncontacted, r.due], [0, 0]);
});
