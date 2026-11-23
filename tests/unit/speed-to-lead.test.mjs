import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  buildSalesAlert, buildTemplateMessage, customerNumber, ownerOf, selectFormLeads, settled, templateFirstName,
} from "../../src/lib/speed-to-lead.mjs";
import { feedbackSectionText, isNoAnswer, summarizeFeedbackBacklog } from "../../src/lib/sales-feedback-brief.mjs";
import { buildBrief } from "../../src/lib/daily-brief.mjs";

// Synthetic data only: invented names, ids and numbers.
const NOW = new Date("2026-11-23T08:10:00Z");
const ago = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();
const lead = (o = {}) => ({ id: "11111111-2222-3333-4444-555555555555", customer_name: "Zed Sample", phone: "0501234567", source: "fb", source_channel: "meta_lead_form",
  created_at: ago(10), assigned_to: "u1", archived: false, stage: "new", property_type: "Villa", area: "Marina", ...o });
const profiles = [{ id: "u1", full_name: "Rana Sales", phone: "0529876543", is_active: true, role: "sales" }, { id: "u2", full_name: "Nophone", phone: null, is_active: true, role: "sales" }];

test("template parameters: first name with fallbacks, no markup characters", () => {
  assert.equal(templateFirstName("Zed Sample", "there"), "Zed");
  assert.equal(templateFirstName("12345", "there"), "there");
  assert.equal(templateFirstName("", "our team"), "our team");
  assert.equal(templateFirstName("A{{1}}b", "there"), "Ab");
});

test("customer numbers: valid UAE and international pass, junk and sequences are rejected", () => {
  assert.equal(customerNumber("0501234567"), null); // 1234567 run
  assert.equal(customerNumber("0507391846"), "971507391846");
  assert.equal(customerNumber("+44 7911 123456"), "447911123456");
  for (const bad of ["", null, "abc", "0500000000", "0555555555", "12345", "050123"]) assert.equal(customerNumber(bad), null, String(bad));
});

test("selection: form leads of the last 2 hours only; test, archived, imported, closed and other channels are skipped", () => {
  const leads = [lead({ id: "a" }), lead({ id: "old", created_at: ago(121) }), lead({ id: "wa", source_channel: "whatsapp_ctwa" }), lead({ id: "qa", source: "synthetic_qa" }),
    lead({ id: "t" }), lead({ id: "arch", archived: true }), lead({ id: "imp", imported_at: ago(5) }), lead({ id: "won", stage: "won" }), lead({ id: "fresh", created_at: ago(1) })];
  const got = selectFormLeads(leads, { now: NOW, excludedTestIds: new Set(["t"]) }).map((l) => l.id);
  assert.deepEqual(got, ["fresh", "a"]);
});

test("owner and settling: owner gets alert number; an unowned lead waits 3 minutes first", () => {
  const [a] = selectFormLeads([lead()], { now: NOW });
  assert.equal(ownerOf(a, profiles).number, "971529876543");
  assert.equal(ownerOf({ ...a, assigned_to: "u2" }, profiles).number, null);
  assert.equal(ownerOf({ ...a, assigned_to: null }, profiles), null);
  const [fresh] = selectFormLeads([lead({ created_at: ago(1), assigned_to: null })], { now: NOW });
  assert.equal(settled(fresh, null), false);
  assert.equal(settled(a, null), true);
});

test("template body and alert text: names fall back, alert has ref, type and area but no customer name or phone", () => {
  const [a] = selectFormLeads([lead()], { now: NOW });
  const msg = buildTemplateMessage(a, ownerOf(a, profiles), "971507391846");
  assert.deepEqual([msg.template.name, msg.template.language.code, msg.to], ["newme_enquiry_ack", "en", "971507391846"]);
  assert.deepEqual(msg.template.components[0].parameters.map((p) => p.text), ["Zed", "Rana"]);
  const fb = buildTemplateMessage({ ...a, customer_name: "" }, null, "971507391846");
  assert.deepEqual(fb.template.components[0].parameters.map((p) => p.text), ["there", "our team"]);
  const alert = buildSalesAlert(a);
  assert.equal(alert, "New lead NM-111111112222: Villa, Marina — please call within 5 minutes.");
  for (const text of [alert, buildSalesAlert(a, { unassigned: true })]) assert.ok(!/Zed|0501234567|971/.test(text));
  assert.match(buildSalesAlert({ ...a, property_type: null, area: null }, { unassigned: true }), /no owner yet/);
});

// --- runner with fake database, sender and Graph API: no network -------------------------------------------------
class Query {
  constructor(rows) { this.rows = rows; }
  select() { return this; } eq() { return this; } or() { return this; } gte() { return this; } gt() { return this; } in() { return this; } order() { return this; } range() { return this; } limit() { return this; }
  then(res, rej) { return Promise.resolve({ data: this.rows, error: null, count: this.rows.length }).then(res, rej); }
}
const fakeDb = (t) => ({ from: (n) => new Query(t[n] ?? []) });
const tables = (leads) => ({ leads, lead_dispatch_state: [], profiles });
const ON = { NEWME_SPEED_TO_LEAD_ENABLED: "true", CUSTOMER_WA_ACCESS_TOKEN: "synthetic-token", CUSTOMER_WA_PHONE_NUMBER_ID: "1322723804261987" };
const fresh = () => ({ NEWME_SPEED_STATE_DIR: mkdtempSync(`${tmpdir()}/stl-`) });

test("runner: off without its switch and then never reads the database", async () => {
  const { runSpeedToLead } = await import("../../scripts/speed-to-lead.mjs");
  const exploding = { from() { throw new Error("must not read"); } };
  assert.equal((await runSpeedToLead(exploding, { execute: true, now: NOW, env: { ...fresh() } })).mode, "disabled");
});

test("runner: dry run counts only and writes nothing", async () => {
  const { runSpeedToLead } = await import("../../scripts/speed-to-lead.mjs");
  const env = { ...ON, ...fresh() };
  const calls = [];
  const r = await runSpeedToLead(fakeDb(tables([lead({ phone: "0507391846" })])), { now: NOW, env, send: async (m) => { calls.push(m); return true; }, sendCustomer: async (m) => { calls.push(m); return { ok: true }; } });
  assert.deepEqual([r.mode, r.candidates, r.ack_due, r.alert_due, r.ack_sent, r.alert_sent], ["dry_run", 1, 0 + 1, 1, 0, 0]);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(`${env.NEWME_SPEED_STATE_DIR}/ledger.json`), false);
  assert.ok(!JSON.stringify(r).includes("Zed"));
});

test("runner: one ack and one alert per lead, never repeated on the next run", async () => {
  const { runSpeedToLead } = await import("../../scripts/speed-to-lead.mjs");
  const env = { ...ON, ...fresh() };
  const alerts = []; const acks = [];
  const deps = { now: NOW, env, send: async (m) => { alerts.push(m); return true; }, sendCustomer: async (m) => { acks.push(m); return { ok: true }; } };
  const first = await runSpeedToLead(fakeDb(tables([lead({ phone: "0507391846" })])), { ...deps, execute: true });
  assert.deepEqual([first.ack_sent, first.alert_sent, first.failed], [1, 1, 0]);
  assert.equal(alerts[0].number, "971529876543");
  assert.equal(alerts[0].key, "newme-speed-to-lead");
  assert.equal(acks[0].body.to, "971507391846");
  const second = await runSpeedToLead(fakeDb(tables([lead({ phone: "0507391846" })])), { ...deps, execute: true, now: new Date(NOW.getTime() + 300_000) });
  assert.deepEqual([second.ack_sent, second.alert_sent], [0, 0]);
  assert.equal(alerts.length + acks.length, 2);
  assert.ok(!readFileSync(`${env.NEWME_SPEED_STATE_DIR}/ledger.json`, "utf8").includes("0507391846"), "ledger holds ids only");
});

test("runner: unassigned lead after the settle time alerts the default recipients (no number); junk number gets no ack", async () => {
  const { runSpeedToLead } = await import("../../scripts/speed-to-lead.mjs");
  const env = { ...ON, ...fresh() };
  const alerts = []; const acks = [];
  const deps = { execute: true, now: NOW, env, send: async (m) => { alerts.push(m); return true; }, sendCustomer: async (m) => { acks.push(m); return { ok: true }; } };
  const r = await runSpeedToLead(fakeDb(tables([lead({ assigned_to: null, phone: "0500000000" }), lead({ id: "99999999-0000-0000-0000-000000000000", assigned_to: null, created_at: ago(1) })])), deps);
  assert.deepEqual([r.ack_sent, r.alert_sent, r.waiting_for_owner, r.ack_skipped_bad_number], [0, 1, 1, 1]);
  assert.equal(alerts[0].number, undefined);
  assert.match(alerts[0].text, /no owner yet/);
  assert.deepEqual(acks, []);
});

test("runner: without the token only the alert goes; a failed send is retried at most 3 times; an unanswered Graph call is never repeated", async () => {
  const { runSpeedToLead } = await import("../../scripts/speed-to-lead.mjs");
  const noToken = { NEWME_SPEED_TO_LEAD_ENABLED: "true", ...fresh() };
  const acks = [];
  const a = await runSpeedToLead(fakeDb(tables([lead({ phone: "0507391846" })])), { execute: true, now: NOW, env: noToken, send: async () => true, sendCustomer: async (m) => { acks.push(m); return { ok: true }; } });
  assert.deepEqual([a.ack_sent, a.alert_sent, a.ack_skipped_no_credentials, acks.length], [0, 1, 1, 0]);
  const env = { ...ON, ...fresh() };
  let tries = 0;
  const bad = { execute: true, env, send: async () => { tries += 1; return false; }, sendCustomer: async () => ({ ok: false, ambiguous: true }) };
  for (let i = 0; i < 5; i += 1) await runSpeedToLead(fakeDb(tables([lead({ phone: "0507391846" })])), { ...bad, now: new Date(NOW.getTime() + i * 60_000) });
  assert.equal(tries, 3);
  let graph = 0;
  const env2 = { ...ON, ...fresh() };
  for (let i = 0; i < 3; i += 1) await runSpeedToLead(fakeDb(tables([lead({ phone: "0507391846" })])), { execute: true, env: env2, now: NOW, send: async () => true, sendCustomer: async () => { graph += 1; return { ok: false, ambiguous: true }; } });
  assert.equal(graph, 1);
});

test("sender: Graph call carries the template for the company number and never throws on a network error", async () => {
  const { sendTemplate } = await import("../../scripts/speed-to-lead.mjs");
  let seen;
  const ok = await sendTemplate({ body: { x: 1 }, env: ON, fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true }; } });
  assert.equal(ok.ok, true);
  assert.match(seen.url, /\/1322723804261987\/messages$/);
  assert.match(seen.init.headers.authorization, /^Bearer /);
  assert.deepEqual(await sendTemplate({ body: {}, env: ON, fetchImpl: async () => { throw new Error("net"); } }), { ok: false, ambiguous: true });
  assert.equal((await sendTemplate({ body: {}, env: {}, fetchImpl: async () => { throw new Error("must not call"); } })).skipped, true);
});

// --- B: sales feedback section of the brief ---------------------------------------------------------------------
const RHEAD = ["Assigned to", "Client", "Assigned at", "Lead quality", "Test record", "Master Lead ID", "Dispatch status", "Opportunity stage"];
const reg = (owner, assigned, ref, extra = {}) => [owner, "x", assigned, "", extra.test ?? "", ref, extra.dispatch ?? "Delivered", extra.stage ?? ""];
const REGISTER = [RHEAD,
  reg("Rana", "2026-11-21 09:00", "META-1"),                   // 2 days, Day 1 empty -> no feedback
  reg("Rana", "2026-11-22 07:00", "META-2"),                   // 1 day + 1h, Day 1 empty -> no feedback
  reg("Rana", "2026-11-23 06:00", "META-3"),                   // under 1 day
  reg("Rana", "2026-11-18 09:00", "META-4"),                   // 5 days, only "no answer" -> stale
  reg("Rana", "2026-11-18 09:00", "META-5"),                   // 5 days, real feedback after the no answer -> fine
  reg("Rana", "2026-11-21 09:00", "META-6"),                   // 2 days, only no answer: under 3 days, not stale
  reg("Omar", "2026-11-15 09:00", "WA-NM-7"),                  // stale, Chinese wording
  reg("Omar", "2026-11-15 09:00", "WA-NM-8", { test: "yes" }), // test record
  reg("Omar", "2026-11-15 09:00", "WA-NM-9", { stage: "Lost" }),
  reg("Omar", "2026-11-15 09:00", "WA-NM-10"),                 // not in any sales sheet: not judged
  reg("", "2026-11-15 09:00", "WA-NM-11")];
const SHEAD = ["Day 1 feedback", "Day 2 feedback", "Day 3 feedback", "Day 4 feedback", "Day 5 feedback", "Later follow-ups / previous records", "Lead key"];
const sal = (key, ...days) => [days[0] ?? "", days[1] ?? "", days[2] ?? "", days[3] ?? "", days[4] ?? "", "", key];
const SALES = [[SHEAD, sal("META-1"), sal("META-2"), sal("META-3"), sal("META-4", "No answer", "no answer again"), sal("META-5", "No answer", "Call back Friday"),
  sal("META-6", "No answer")], [SHEAD, sal("WA-NM-7", "无人接听"), sal("WA-NM-8"), sal("WA-NM-9")]];

test("no-answer wording", () => {
  for (const yes of ["No answer", "did not pick up the phone", "Phone switched off", "无人接听", "Busy"]) assert.equal(isNoAnswer(yes), true, yes);
  for (const no of ["Call back Friday", "Wants a 2BR villa", ""]) assert.equal(isNoAnswer(no), false, no);
});

test("feedback backlog: per person Day 1 empty after 1 day and no-answer-only after 3 days; test, lost, unjudged and under-age leads left out; Lead quality ignored", () => {
  const f = summarizeFeedbackBacklog(REGISTER, SALES, { now: NOW });
  assert.deepEqual(f.people.map((p) => [p.name, p.noFeedback.count, p.noFeedback.oldest, p.stale.count, p.stale.oldest]),
    [["Rana", 2, ["META-1", "META-2"], 1, ["META-4"]], ["Omar", 0, [], 1, ["WA-NM-7"]]]);
  assert.deepEqual([f.noFeedbackTotal, f.staleTotal], [2, 2]);
  assert.equal(feedbackSectionText(f), "销售反馈待补：Rana Day1未写2条(最久META-1/META-2)，仅未接超3天1条(最久META-4)、Omar 仅未接超3天1条(最久WA-NM-7)");
  assert.match(feedbackSectionText(f, "short"), /^销售反馈待补：Day1未写2条，仅未接超3天2条（Rana3、Omar1）$/);
  assert.ok(!feedbackSectionText(f).includes("质量"), "no Lead quality nagging");
  assert.equal(feedbackSectionText({ people: [] }), "");
  assert.throws(() => summarizeFeedbackBacklog([["Assigned to"]], SALES, { now: NOW }), /header/);
  assert.throws(() => summarizeFeedbackBacklog(REGISTER, [[["Lead key"]]], { now: NOW }), /sales_header/);
});

const leadsFixture = { total: 3, adLeads: 0, byChannel: { fb_form: 3, instagram: 0, whatsapp: 0, website: 0, other: 0 }, prior: { fb_form: 0, instagram: 0, whatsapp: 0, website: 0, other: 0 } };

test("brief: feedback section is appended and stays inside 400 characters, dropped before uncontacted people are cut", () => {
  const feedback = summarizeFeedbackBacklog(REGISTER, SALES, { now: NOW });
  const text = buildBrief({ dateKey: "2026-11-22", leads: leadsFixture, quotes: { count: 0, total: 0 }, feedback });
  assert.match(text, /销售反馈待补：Rana Day1未写2条/);
  const one = { count: 3, oldest: ["META-1234567890", "META-2234567890", "META-3234567890"] };
  const many = { noFeedbackTotal: 90, staleTotal: 90, people: Array.from({ length: 30 }, (_, i) => ({ name: `Salesperson${i}`, noFeedback: one, stale: one })) };
  const people = Array.from({ length: 4 }, (_, i) => ({ name: `销售${i}号`, items: [1], oldest_hours: 30 }));
  const long = buildBrief({ dateKey: "2026-11-22", leads: leadsFixture, quotes: { count: 0, total: 0 }, people, feedback: many });
  assert.ok([...long].length <= 400);
  assert.match(long, /销售3号/);
  assert.ok(!buildBrief({ dateKey: "2026-11-22", leads: leadsFixture, quotes: { count: 0, total: 0 }, feedback: null }).includes("销售反馈"));
});

test("runner: brief with the feedback switch includes the section; a failing sheet read still sends the brief without it; off by default", async () => {
  process.env.NEWME_BRIEF_STATE_DIR = mkdtempSync(`${tmpdir()}/brief-`);
  const { runBrief } = await import("../../scripts/daily-brief.mjs");
  const db = () => fakeDb({ lead_dispatch_state: [], leads: [], profiles: [], quotations: [], ad_spend: [], follow_up_logs: [], transfer_history: [] });
  const sent = [];
  const send = async (m) => { sent.push(m); return true; };
  const env = { NEWME_DAILY_BRIEF_ENABLED: "true", NEWME_BRIEF_FEEDBACK_SECTION_ENABLED: "true" };
  const now = NOW;
  const withSection = await runBrief(db(), { now, send, env, readGrids: async () => ({ registerGrid: REGISTER, salesGrids: SALES }) });
  assert.deepEqual([withSection.feedback_no_day1, withSection.feedback_stale_no_answer], [2, 2]);
  const failed = await runBrief(db(), { execute: true, now, send, env, readGrids: async () => { throw new Error("sheet down"); } });
  assert.equal(failed.sent, true);
  assert.ok(!sent[0].text.includes("销售反馈"));
  let read = 0;
  const off = await runBrief(db(), { now, send, env: { NEWME_DAILY_BRIEF_ENABLED: "true" }, readGrids: async () => { read += 1; return { registerGrid: REGISTER, salesGrids: SALES }; } });
  assert.deepEqual([off.feedback_no_day1, read], [null, 0]);
});
