import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildBrief } from "../../src/lib/daily-brief.mjs";
import {
  buildWaitAlert, businessWaitMs, channelOwnerMap, planWaitAlert, resolveWaitAlertHours, responsibleName, selectWaiting, summarizeFollowupWaits, waitSectionText,
} from "../../src/lib/wa-wait.mjs";

// Invented ids and names only. Dubai is UTC+4; 2026-11-23 is a Monday.
const iso = (s) => new Date(s).toISOString();
const MON_NOON = new Date("2026-11-23T08:00:00Z"); // Mon 12:00 Dubai
const profiles = [
  { id: "p-ayana", full_name: "Ayana", role: "operator", is_active: true },
  { id: "p-boss", full_name: "Boss One", role: "boss", is_active: true },
  { id: "p-sam", full_name: "Sam Test", role: "admin", is_active: true },
];
const channels = [
  { phone_number_id: "11111", owner_profile_id: "p-ayana", enabled: true },
  { phone_number_id: "22222", owner_profile_id: "p-sam", enabled: true },
  { phone_number_id: "33333", owner_profile_id: "p-ayana", enabled: false },
];

test("channel owner: salesperson's channel wins, admin/boss channel falls to the assignee, then the company number", () => {
  const owners = channelOwnerMap(channels, profiles);
  assert.deepEqual([...owners.keys()], ["11111"]); // admin-owned and disabled channels are not a salesperson's number
  assert.equal(responsibleName({ phoneNumberId: "11111", assignedTo: "p-boss", channelOwners: owners, profiles }), "Ayana");
  assert.equal(responsibleName({ phoneNumberId: "22222", assignedTo: "p-ayana", channelOwners: owners, profiles }), "Ayana");
  assert.equal(responsibleName({ phoneNumberId: "22222", assignedTo: null, channelOwners: owners, profiles }), "公司号");
  assert.equal(responsibleName({ phoneNumberId: "99999", assignedTo: "ghost", channelOwners: owners, profiles }), "公司号");
});

test("working-hour wait: 09-21 Dubai, weekends skipped", () => {
  const h = 3_600_000;
  const t = (s) => Date.parse(s);
  assert.equal(businessWaitMs(t("2026-11-23T05:00:00Z"), t("2026-11-23T08:00:00Z")), 3 * h); // 09:00-12:00 Dubai
  assert.equal(businessWaitMs(t("2026-11-23T16:50:00Z"), t("2026-11-24T05:30:00Z")), 10 * 60_000 + 30 * 60_000); // 20:50 Mon -> 09:30 Tue
  assert.equal(businessWaitMs(t("2026-11-20T16:00:00Z"), t("2026-11-23T06:00:00Z")), 1 * h + 1 * h); // Fri 20:00-21:00, Sat/Sun none, Mon 09:00-10:00
  assert.equal(businessWaitMs(t("2026-11-23T08:00:00Z"), t("2026-11-23T07:00:00Z")), 0);
});

test("threshold env: default 2 hours, junk falls back", () => {
  assert.deepEqual([undefined, "", "abc", "-1", "0", "3", "1.5"].map(resolveWaitAlertHours), [2, 2, 2, 2, 2, 3, 1.5]);
});

const conv = (o = {}) => ({ id: "c1", lead_id: "l1", phone_number_id: "11111", last_inbound_at: iso("2026-11-23T05:30:00Z"), last_outbound_at: null, ...o });
const since = (s) => new Map([["c1", Date.parse(s)]]);

test("selectWaiting: alerts only past the threshold, once per episode, never for answered or closed conversations", () => {
  const base = { conversations: [conv()], waitStarts: since("2026-11-23T05:30:00Z"), now: MON_NOON };
  assert.equal(selectWaiting(base).length, 1); // 09:30 -> 12:00 = 2.5 h
  assert.equal(selectWaiting({ ...base, now: new Date("2026-11-23T07:00:00Z") }).length, 0); // 1.5 h
  const [item] = selectWaiting(base);
  assert.equal(selectWaiting({ ...base, done: new Set([item.key]) }).length, 0);
  assert.equal(selectWaiting({ ...base, conversations: [conv({ last_outbound_at: iso("2026-11-23T06:00:00Z") })] }).length, 0);
  assert.equal(selectWaiting({ ...base, ignoredLeadIds: new Set(["l1"]) }).length, 0);
  // a new episode after a reply gets a new key, so it can alert again
  const next = selectWaiting({ conversations: [conv({ last_outbound_at: iso("2026-11-23T05:40:00Z"), last_inbound_at: iso("2026-11-23T05:50:00Z") })],
    waitStarts: since("2026-11-23T05:50:00Z"), now: MON_NOON, done: new Set([item.key]) });
  assert.equal(next.length, 1);
  assert.notEqual(next[0].key, item.key);
});

test("selectWaiting: night and weekend time does not count, stale episodes are ignored", () => {
  const sat = new Date("2026-11-21T08:00:00Z");
  assert.equal(selectWaiting({ conversations: [conv()], waitStarts: since("2026-11-21T05:00:00Z"), now: sat }).length, 0); // Saturday: no working time
  const lateNight = new Date("2026-11-23T20:00:00Z"); // Tue 00:00 Dubai
  assert.equal(selectWaiting({ conversations: [conv()], waitStarts: since("2026-11-23T16:00:00Z"), now: lateNight }).length, 0); // only 1 h of 20:00-21:00
  assert.equal(selectWaiting({ conversations: [conv()], waitStarts: since("2026-11-10T05:00:00Z"), now: MON_NOON }).length, 0); // older than 7 days
});

test("alert text: names and counts per responsible person, one line within 400 characters, no digits of a phone", () => {
  const owners = channelOwnerMap(channels, profiles);
  const items = [
    { key: "a", lead_id: "l1", phone_number_id: "11111", waited_hours: 5 },
    { key: "b", lead_id: "l2", phone_number_id: "11111", waited_hours: 3 },
    { key: "c", lead_id: null, phone_number_id: "22222", waited_hours: 4 },
  ];
  const groups = planWaitAlert(items, { leadAssignee: new Map(), channelOwners: owners, profiles });
  assert.deepEqual(groups.map((g) => [g.name, g.count, g.longest_hours]), [["Ayana", 2, 5], ["公司号", 1, 4]]);
  const text = buildWaitAlert(groups, 2);
  assert.match(text, /3位客户已等回复超过2小时.*Ayana 2条\(最久5小时\)、公司号 1条\(最久4小时\)/);
  const many = buildWaitAlert(Array.from({ length: 80 }, (_, i) => ({ name: `销售${i}号`, count: 2, longest_hours: 30 + i })), 2);
  assert.ok([...many].length <= 400 && !many.includes("\n"));
});

test("brief section: counts overdue and at-risk per person with the longest wait, open leads only", () => {
  const owners = channelOwnerMap(channels, profiles);
  const states = [
    { lead_id: "l1", state: "overdue", first_inbound_at: iso("2026-11-23T04:00:00Z"), first_reply_at: null, last_outbound_at: null }, // 08:00 -> 12:00 = 4 h
    { lead_id: "l2", state: "at_risk", first_inbound_at: iso("2026-11-23T06:00:00Z"), first_reply_at: null, last_outbound_at: null },
    { lead_id: "l3", state: "at_risk", first_inbound_at: iso("2026-11-23T05:00:00Z"), first_reply_at: iso("2026-11-23T05:10:00Z"), last_outbound_at: iso("2026-11-22T04:00:00Z") },
    { lead_id: "l4", state: "overdue", first_inbound_at: iso("2026-11-23T04:00:00Z"), first_reply_at: null, last_outbound_at: null }, // archived
    { lead_id: "l5", state: "normal", first_inbound_at: iso("2026-11-23T04:00:00Z"), first_reply_at: null, last_outbound_at: null },
    { lead_id: "l6", state: "overdue", first_inbound_at: iso("2026-11-23T04:00:00Z"), first_reply_at: null, last_outbound_at: null }, // excluded test
  ];
  const leads = new Map(["l1", "l2", "l3", "l4", "l5", "l6"].map((id) => [id, { id, assigned_to: "p-boss", archived: id === "l4", final_status: null, source: "fb" }]));
  leads.get("l3").assigned_to = "p-ayana";
  const conversations = [
    { lead_id: "l1", phone_number_id: "11111", last_inbound_at: iso("2026-11-23T04:00:00Z") },
    { lead_id: "l2", phone_number_id: "11111", last_inbound_at: iso("2026-11-23T06:00:00Z") },
  ];
  const waits = summarizeFollowupWaits({ states, leads, conversations, channelOwners: owners, profiles, excludedTestIds: new Set(["l6"]), now: MON_NOON });
  assert.equal(waits[0].name, "Ayana");
  assert.equal(waits[0].count, 3); // l1, l2 by channel owner, l3 by assignee
  assert.equal(waits[0].overdue, 1);
  assert.equal(waits[0].at_risk, 2);
  assert.equal(waits[0].longest_hours, 12); // l3: last reply Sunday 08:00 Dubai; Sunday is not a working day, so only Monday 00:00-12:00 counts
  assert.equal(waits.length, 1);
  assert.equal(waitSectionText(waits), "WhatsApp客户等回复：Ayana 超时1风险2(最久12小时)");
});

test("brief: the waiting section sits before the attention line and the whole text stays within 400 characters", () => {
  const quiet = { byChannel: { fb_form: 3, instagram: 0, whatsapp: 0, website: 0, other: 0 }, prior: { fb_form: 0, instagram: 0, whatsapp: 0, website: 0, other: 0 } };
  const waits = Array.from({ length: 30 }, (_, i) => ({ name: `销售${i}号`, overdue: 1, at_risk: 1, count: 2, longest_hours: 5 }));
  const groups = Array.from({ length: 40 }, (_, i) => ({ name: `销售${i}号`, unassigned: false, items: [1, 2], oldest_hours: 30 + i }));
  const text = buildBrief({ dateKey: "2026-11-20", leads: { total: 3, adLeads: 0, ...quiet }, groups, quotes: { count: 0, total: 0 }, waits });
  assert.ok([...text].length <= 400);
  assert.match(text, /WhatsApp客户等回复：销售0号 超时1风险1\(最久5小时\)/);
  const none = buildBrief({ dateKey: "2026-11-20", leads: { total: 3, adLeads: 0, ...quiet }, groups: [], quotes: { count: 0, total: 0 }, waits: [] });
  assert.ok(!none.includes("等回复"));
});

// --- runner with a filtering fake database and a fake sender: no network ----------------------------------------------
class Query {
  constructor(rows) { this.rows = rows; this.filters = []; }
  select() { return this; } or() { return this; } gte() { return this; } order() { return this; } range() { return this; } limit() { return this; }
  eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
  gt(col, val) { this.filters.push((r) => Date.parse(r[col]) > Date.parse(val)); return this; }
  in(col, vals) { this.filters.push((r) => vals.includes(r[col])); return this; }
  then(res, rej) { const rows = this.rows.filter((r) => this.filters.every((f) => f(r))); return Promise.resolve({ data: rows, error: null, count: rows.length }).then(res, rej); }
}
const fakeDb = (tables) => ({ from: (name) => new Query(tables[name] ?? []), rpc: async () => ({ error: null }) });
const NOW = new Date("2026-11-23T08:00:00Z"); // Mon 12:00 Dubai, inside the reminder window
const tables = () => ({
  lead_dispatch_state: [], leads: [{ id: "l1", assigned_to: "p-boss", archived: false, final_status: null, source: "fb", stage: "contacted", created_at: iso("2026-11-20T05:00:00Z") }],
  profiles, follow_up_logs: [], transfer_history: [],
  whatsapp_pilot_channels: channels,
  whatsapp_conversations: [
    { id: "c1", lead_id: "l1", phone_number_id: "11111", last_inbound_at: iso("2026-11-23T05:30:00Z"), last_outbound_at: null },
    { id: "c2", lead_id: null, phone_number_id: "22222", last_inbound_at: iso("2026-11-23T07:30:00Z"), last_outbound_at: null }, // 30 min: not yet
    { id: "c3", lead_id: null, phone_number_id: "22222", last_inbound_at: iso("2026-11-23T05:00:00Z"), last_outbound_at: iso("2026-11-23T05:10:00Z") }, // answered
  ],
  whatsapp_message_events: [
    { conversation_id: "c1", direction: "inbound", backfilled: false, occurred_at: iso("2026-11-23T05:30:00Z") },
    { conversation_id: "c1", direction: "inbound", backfilled: true, occurred_at: iso("2026-11-01T05:30:00Z") },
    { conversation_id: "c2", direction: "inbound", backfilled: false, occurred_at: iso("2026-11-23T07:30:00Z") },
  ],
});

test("runner: wait alert is off by default, then sends ONE message to the default recipients and never repeats the same episode", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/brief-`);
  const { runReminders } = await import("../../scripts/daily-brief.mjs");
  const sent = [];
  const send = async (m) => { sent.push(m); return true; };
  const off = await runReminders(fakeDb(tables()), { execute: true, now: NOW, send, env: {} });
  assert.equal(off.mode, "disabled");
  assert.equal(sent.length, 0);
  const dry = await runReminders(fakeDb(tables()), { now: NOW, send, env: {} });
  assert.equal(dry.wa_wait_due, 1); // dry run only counts
  assert.equal(sent.length, 0);
  const on = { NEWME_WA_WAIT_ALERT_ENABLED: "true" };
  const first = await runReminders(fakeDb(tables()), { execute: true, now: NOW, send, env: on });
  assert.deepEqual([first.wa_wait_sent, first.wa_wait_failed, first.failed], [1, 0, 0]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].number, undefined); // the default recipients, not one salesperson
  assert.equal(sent[0].key, "newme-wa-wait-alert");
  assert.match(sent[0].text, /1位客户已等回复超过2小时.*Ayana 1条\(最久2小时\)/);
  assert.ok(!/\d{7,}/.test(sent[0].text));
  const second = await runReminders(fakeDb(tables()), { execute: true, now: new Date(NOW.getTime() + 3_600_000), send, env: on });
  assert.equal(second.wa_wait_sent, 0);
  assert.equal(sent.length, 1);
  // threshold switch: a 1 hour threshold also catches the 30 minute conversation after it has waited long enough
  const later = await runReminders(fakeDb(tables()), { execute: true, now: new Date("2026-11-23T09:30:00Z"), send, env: { ...on, NEWME_WA_WAIT_ALERT_HOURS: "1" } });
  assert.equal(later.wa_wait_sent, 1); // c2 only: c1 was alerted already
  assert.ok(readdirSync(process.env.NEWME_BRIEF_STATE_DIR).some((f) => f.startsWith("wa-wait-")));
});

test("runner: a failed delivery is reported and retried, not recorded as sent", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/brief-`);
  const { runReminders } = await import("../../scripts/daily-brief.mjs");
  const on = { NEWME_WA_WAIT_ALERT_ENABLED: "true" };
  const failed = await runReminders(fakeDb(tables()), { execute: true, now: NOW, send: async () => false, env: on });
  assert.deepEqual([failed.wa_wait_sent, failed.wa_wait_failed, failed.failed], [0, 1, 1]);
  const retry = await runReminders(fakeDb(tables()), { execute: true, now: NOW, send: async () => true, env: on });
  assert.equal(retry.wa_wait_sent, 1);
});

test("runner: backfilled history alone never starts a waiting episode", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/brief-`);
  const { runReminders } = await import("../../scripts/daily-brief.mjs");
  const t = tables();
  t.whatsapp_message_events = t.whatsapp_message_events.map((e) => ({ ...e, backfilled: true }));
  const r = await runReminders(fakeDb(t), { now: NOW, env: {} });
  assert.equal(r.wa_wait_due, 0);
});

test("runner: the brief carries the follow-up waiting section from lead_followup_state", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/brief-`);
  const { runBrief } = await import("../../scripts/daily-brief.mjs");
  const t = tables();
  t.lead_followup_state = [{ lead_id: "l1", state: "overdue", first_inbound_at: iso("2026-11-23T04:00:00Z"), first_reply_at: null, last_outbound_at: null }];
  const sent = [];
  const r = await runBrief(fakeDb(t), { execute: true, now: NOW, send: async (m) => { sent.push(m); return true; }, env: { NEWME_DAILY_BRIEF_ENABLED: "true" } });
  assert.equal(r.wa_waiting_people, 1);
  assert.match(sent[0].text, /WhatsApp客户等回复：Ayana 超时1\(最久4小时\)/);
});

test("S24 follow-up (PR #587): the brief reads excluded tests, logs, transfers, quotations and spend in full pages and ignores note-only logs", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../scripts/daily-brief.mjs", import.meta.url), "utf8");
  assert.match(src, /contact_type\.is\.null,contact_type\.neq\.note/);
  for (const table of ["lead_dispatch_state", "follow_up_logs", "transfer_history", "quotations", "ad_spend"]) {
    assert.match(src, new RegExp(`from\\("${table}"\\)\\.select\\("[^"]*", withCount`), table);
  }
});
