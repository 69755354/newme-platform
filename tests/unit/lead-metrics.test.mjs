// S5: one definition of each lead metric (总报告 三; 4c #15; 4a #14).
import assert from "node:assert/strict";
import test from "node:test";

import { dubaiMonthBounds } from "../../src/lib/dubai-time.mjs";
import {
  aggregateAttribution,
  conversionRate,
  followUpOverdue,
  isCountedLead,
  isWonInPeriod,
  leadSourceKey,
  overdueDays,
  qualityBucket,
  summarizeLeads,
  totalAttribution,
} from "../../src/lib/lead-metrics.mjs";

const NOW = new Date("2026-11-03T05:00:00.000Z"); // 09:00 Dubai, 3 Nov 2026
const lead = (o) => ({ archived: false, stage: "new", final_status: null, created_at: "2026-10-01T08:00:00Z", ...o });

test("archived leads are never counted", () => {
  const rows = [lead({ id: "a" }), lead({ id: "b" }), lead({ id: "c", archived: true, final_status: "won", won_at: "2026-11-01T08:00:00Z" })];
  const s = summarizeLeads(rows, { now: NOW, period: dubaiMonthBounds("2026-11") });
  assert.equal(s.total, 2);
  assert.equal(s.won, 0);
  assert.equal(s.periodWonCount, 0);
  assert.equal(isCountedLead(rows[2]), false);
  const groups = aggregateAttribution(rows);
  assert.equal(totalAttribution(groups).total, 2);
});

test("won in a month uses won_at inside the Dubai month (quote-conversion wins included)", () => {
  const nov = dubaiMonthBounds("2026-11");
  const rows = [
    lead({ id: "w1", final_status: "won", stage: "quotation_submitted", won_at: "2026-11-02T10:00:00Z", quotation_value: 1000, assigned_to: "u1" }),
    lead({ id: "w2", final_status: "won", won_at: "2026-10-31T19:30:00Z", quotation_value: 500, assigned_to: "u1" }), // 23:30 Dubai 31 Oct
    lead({ id: "w3", final_status: "won", won_at: "2026-10-31T20:30:00Z", quotation_value: 250, assigned_to: "u2" }), // 00:30 Dubai 1 Nov
    lead({ id: "l1", final_status: "lost", assigned_to: "u1" }),
  ];
  const s = summarizeLeads(rows, { now: NOW, period: nov });
  assert.equal(s.won, 3); // all-time
  assert.equal(s.periodWonCount, 2);
  assert.equal(s.periodWonValue, 1250);
  assert.equal(isWonInPeriod(rows[1], nov), false);
  // personal performance: this period's won, not all-time won
  assert.equal(s.byAssignee.u1.wonValue, 1500);
  assert.equal(s.byAssignee.u1.periodWonValue, 1000);
  assert.equal(s.byAssignee.u2.periodWonValue, 250);
  assert.equal(s.stageCounts.won, 3);
  assert.equal(s.stageCounts.lost, 1);
});

test("conversion is won / counted leads, whole percent", () => {
  assert.equal(conversionRate(1, 3), 33);
  assert.equal(conversionRate(0, 0), 0);
  const s = summarizeLeads([lead({ final_status: "won" }), lead({}), lead({ stage: "contacted" }), lead({})], { now: NOW });
  assert.equal(s.conversionRate, 25);
});

test("follow-up overdue and days late are the same everywhere (Dubai days)", () => {
  const due = lead({ next_followup_date: "2026-06-26T19:30:00Z", last_contact_date: "2026-06-20T08:00:00Z" });
  const state = followUpOverdue(due, NOW);
  assert.equal(state.overdue, true);
  // 23:30 Dubai 26 Jun -> 3 Nov Dubai = 130 days; floor(ms)=129, ceil(ms)=130 before.
  assert.equal(state.days, overdueDays("2026-06-26T19:30:00Z", NOW));
  assert.equal(state.days, 130);
  assert.equal(followUpOverdue({ ...due, final_status: "won" }, NOW).overdue, false);
  assert.equal(followUpOverdue({ ...due, archived: true }, NOW).overdue, false);
  // never contacted: due 48h after creation
  const fresh = lead({ created_at: "2026-11-01T04:00:00Z" });
  assert.equal(followUpOverdue(fresh, NOW).overdue, true);
  assert.equal(followUpOverdue(fresh, NOW).days, 0);
  assert.equal(followUpOverdue(lead({ created_at: "2026-11-02T06:00:00Z" }), NOW).overdue, false);
});

test("quality buckets cover every stored value (no undefined chart label)", () => {
  for (const q of ["pending", "valid", "job_seeker", "fake", "duplicate", "poor", "normal", "good", null, "weird"]) {
    assert.ok(["pending", "good", "normal", "bad", "unknown"].includes(qualityBucket({ quality: q })), String(q));
  }
  assert.equal(qualityBucket({ quality: "normal" }), "normal");
  assert.equal(qualityBucket({ quality: "poor" }), "bad");
  assert.equal(qualityBucket({ quality: null, ai_quality: "hot" }), "good");
});

test("attribution groups by source before platform and counts good/normal as valid", () => {
  const rows = [
    lead({ source: "fb", quality: "good", final_status: "won", quotation_value: 100 }),
    lead({ source: null, source_platform: "meta", quality: "normal", stage: "negotiation", quotation_value: 50 }),
    lead({ source: null, source_platform: null, quality: "poor", quotation_value: 999 }),
  ];
  assert.equal(leadSourceKey(rows[2]), "other");
  const g = aggregateAttribution(rows);
  assert.deepEqual(g.fb, { total: 1, valid: 1, quoted: 1, won: 1, value: 100 });
  assert.deepEqual(g.meta, { total: 1, valid: 1, quoted: 1, won: 0, value: 50 });
  assert.deepEqual(g.other, { total: 1, valid: 0, quoted: 0, won: 0, value: 0 });
});

test("source table and per-assignee rollups add up to the company totals", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push(lead({
      id: String(i), source: ["fb", "ins", "website", null][i % 4],
      assigned_to: i % 5 === 0 ? null : `u${i % 3}`,
      final_status: i % 7 === 0 ? "won" : i % 11 === 0 ? "lost" : null,
      won_at: i % 7 === 0 ? "2026-11-01T10:00:00Z" : null,
      archived: i % 13 === 0,
    }));
  }
  const s = summarizeLeads(rows, { now: NOW, period: dubaiMonthBounds("2026-11") });
  const srcTotal = Object.values(s.bySource).reduce((a, b) => a + b.total, 0);
  const srcWon = Object.values(s.bySource).reduce((a, b) => a + b.won, 0);
  assert.equal(srcTotal, s.total);
  assert.equal(srcWon, s.won);
  const unassigned = rows.filter((r) => !r.archived && !r.assigned_to).length;
  const assigneeTotal = Object.values(s.byAssignee).reduce((a, b) => a + b.total, 0);
  assert.equal(assigneeTotal + unassigned, s.total);
  assert.equal(totalAttribution(aggregateAttribution(rows)).total, s.total);
});

test("10k leads aggregate well inside the dashboard budget", () => {
  const rows = Array.from({ length: 10000 }, (_, i) => lead({ id: String(i), assigned_to: `u${i % 8}`, source: "fb", final_status: i % 9 ? null : "won", won_at: "2026-11-01T10:00:00Z", last_contact_date: "2026-10-20T10:00:00Z" }));
  const t0 = performance.now();
  const s = summarizeLeads(rows, { now: NOW, period: dubaiMonthBounds("2026-11") });
  const ms = performance.now() - t0;
  assert.equal(s.total, 10000);
  assert.ok(ms < 500, `took ${ms}ms`);
});

test("a DATE follow-up is due for the whole Dubai day and N days late on day N after", () => {
  const base = lead({ last_contact_date: "2026-10-20T08:00:00Z" });
  // NOW is 09:00 Dubai on 3 Nov
  assert.equal(followUpOverdue({ ...base, next_followup_date: "2026-11-03" }, NOW).overdue, false);
  const yesterday = followUpOverdue({ ...base, next_followup_date: "2026-11-02" }, NOW);
  assert.deepEqual([yesterday.overdue, yesterday.days], [true, 1]);
  assert.equal(followUpOverdue({ ...base, next_followup_date: "2026-10-04" }, NOW).days, 30);
});

test("stage 'won'/'lost' without final_status is still an outcome, never an active lead", () => {
  const s = summarizeLeads([lead({ stage: "won" }), lead({ stage: "lost" }), lead({})], { now: NOW });
  assert.equal(s.active, 1);
  assert.equal(s.won, 1);
  assert.equal(s.lost, 1);
});

test("quality buckets, dormant and zero-follow-up are counted once, here", () => {
  const rows = [
    lead({ quality: "normal", lead_status: "dormant", followup_count: 0, last_contact_date: null }),
    lead({ quality: "good", followup_count: 2, last_contact_date: "2026-10-01T08:00:00Z" }), // 33 days quiet
    lead({ quality: "poor", followup_count: 1, last_contact_date: "2026-11-02T08:00:00Z" }),
    lead({ quality: null }),
  ];
  const s = summarizeLeads(rows, { now: NOW });
  assert.deepEqual(s.qualityBreakdown, { pending: 0, good: 1, normal: 1, bad: 1, unknown: 1 });
  assert.equal(s.dormant, 2);
  assert.equal(s.zeroFollowup, 2);
});

test("imported counts follow the same archived rule", () => {
  const s = summarizeLeads([lead({ imported_by: "u1" }), lead({ imported_by: "u1", archived: true })], { now: NOW });
  assert.equal(s.byAssignee.u1.imported, 1);
});
