// S37 "boss numbers trustworthy": one definition per number, new leads are not dormant,
// ads page states what is missing, formats are uniform. Findings B9/F07, B6/F11, missing #4, B4.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  aggregateAttribution,
  effectiveLeadStatus,
  isActiveUnassignedLead,
  summarizeLeads,
  totalAttribution,
} from "../../src/lib/lead-metrics.mjs";
import { formatAED, formatDateTime, formatDubaiTime, formatShortDate, isDateOnly } from "../../src/lib/display-format.mjs";

const NOW = new Date("2026-11-22T08:00:00.000Z"); // 12:00 Dubai, 22 Nov 2026
const lead = (o) => ({ archived: false, stage: "new", final_status: null, created_at: "2026-10-01T08:00:00Z", ...o });
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

// ── B6 / F11 : temperature ────────────────────────────────────────────────
test("a lead created in the last 48h and never contacted is hot, not dormant", () => {
  const fresh = lead({ created_at: "2026-11-21T12:00:00Z", last_contact_date: null, lead_status: "dormant" });
  assert.equal(effectiveLeadStatus(fresh, NOW), "hot");
});

test("a never-contacted lead older than 48h is dormant; contacted leads age by days", () => {
  assert.equal(effectiveLeadStatus(lead({ created_at: "2026-11-19T07:00:00Z", last_contact_date: null }), NOW), "dormant");
  assert.equal(effectiveLeadStatus(lead({ last_contact_date: "2026-11-20" }), NOW), "hot");
  assert.equal(effectiveLeadStatus(lead({ last_contact_date: "2026-11-10" }), NOW), "warm");
  assert.equal(effectiveLeadStatus(lead({ last_contact_date: "2026-10-30" }), NOW), "cold");
  assert.equal(effectiveLeadStatus(lead({ last_contact_date: "2026-09-01" }), NOW), "dormant");
});

test("won and lost leads keep their stored temperature", () => {
  assert.equal(effectiveLeadStatus(lead({ final_status: "won", lead_status: "cold" }), NOW), "cold");
});

test("time passing turns a fresh lead dormant on read, with no database update", () => {
  const l = lead({ created_at: "2026-11-22T06:00:00Z", last_contact_date: null });
  assert.equal(effectiveLeadStatus(l, NOW), "hot");
  assert.equal(effectiveLeadStatus(l, new Date("2026-11-25T06:00:00Z")), "dormant");
});

test("summary counts new uncontacted ad leads as hot and not as dormant", () => {
  const rows = [
    lead({ id: "n1", created_at: "2026-11-22T05:00:00Z", source: "fb", lead_status: "dormant" }),
    lead({ id: "n2", created_at: "2026-11-22T06:00:00Z", source: "ins", lead_status: "dormant" }),
    lead({ id: "old", created_at: "2026-09-01T06:00:00Z", lead_status: "dormant" }),
  ];
  const s = summarizeLeads(rows, { now: NOW });
  assert.equal(s.hot, 2);
  assert.equal(s.dormant, 1);
});

test("migration makes a fresh never-contacted lead hot and keeps the definer posture", () => {
  const sql = read("supabase/migrations/20261122300000_s37_new_lead_not_dormant.sql");
  assert.match(sql, /^-- NO_ROLLBACK: \S/);
  assert.match(sql, /create or replace function public\.derive_lead_status\(\)/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /set search_path to 'pg_catalog', 'public', 'pg_temp'/i);
  assert.match(sql, /interval '48 hours'[\s\S]*'hot'[\s\S]*'dormant'/i);
  // only values the CHECK constraint allows
  const assigned = [...sql.matchAll(/new\.lead_status := '(\w+)'/g)].map((m) => m[1]);
  assert.ok(assigned.length > 0);
  for (const v of assigned) assert.ok(["hot", "warm", "cold", "dormant"].includes(v), v);
});

test("cockpit hot-lead query includes new uncontacted leads", () => {
  const src = read("src/app/api/dashboard/summary/route.ts");
  assert.match(src, /lead_status\.eq\.hot/);
  assert.match(src, /last_contact_date\.is\.null/);
});

// ── B9 / F07 : one definition ─────────────────────────────────────────────
test("risk pool never exceeds active leads and ignores archived and closed leads", () => {
  const rows = [
    lead({ id: "a", next_followup_date: null }),
    lead({ id: "b", next_followup_date: "2026-11-20" }),
    lead({ id: "c", next_followup_date: "2026-11-30" }),
    lead({ id: "d", archived: true }),
    lead({ id: "e", final_status: "won" }),
  ];
  const s = summarizeLeads(rows, { now: NOW });
  assert.equal(s.active, 3);
  assert.equal(s.riskPool, 2);
  assert.ok(s.riskPool <= s.active);
});

test("pipeline value counts only leads that carry a value; unassigned means active and unowned", () => {
  const rows = [
    lead({ id: "a", quotation_value: 1000, assigned_to: "u1" }),
    lead({ id: "b", quotation_value: 0 }),
    lead({ id: "c", quotation_value: null }),
    lead({ id: "d", archived: true, quotation_value: 9999 }),
    lead({ id: "e", final_status: "lost" }),
  ];
  const s = summarizeLeads(rows, { now: NOW });
  assert.equal(s.active, 3);
  assert.equal(s.valuedCount, 1);
  assert.equal(s.pipelineValue, 1000);
  assert.equal(s.unassignedActive, 2);
  assert.equal(isActiveUnassignedLead(rows[3]), false, "archived");
  assert.equal(isActiveUnassignedLead(rows[4]), false, "lost");
});

test("quoted count is one definition shared with the ads pages", () => {
  const rows = [
    lead({ id: "q1", stage: "quotation_submitted" }),
    lead({ id: "q2", stage: "negotiation" }),
    lead({ id: "w", final_status: "won", stage: "quotation_submitted" }),
    lead({ id: "n" }),
  ];
  const s = summarizeLeads(rows, { now: NOW });
  assert.equal(s.quotedCount, totalAttribution(aggregateAttribution(rows)).quoted);
});

test("settings data route and page count only non-archived leads, active unassigned", () => {
  const route = read("src/app/api/settings/data/route.ts");
  assert.match(route, /\.eq\("archived", false\)/);
  const page = read("src/app/(dashboard)/settings/page.tsx");
  assert.match(page, /isActiveUnassignedLead/);
});

test("risk pool on the dashboard comes from the lead summary, not a task or view count", () => {
  const route = read("src/app/api/dashboard/summary/route.ts");
  assert.doesNotMatch(route, /v_risk_pool/);
  assert.match(route, /riskPoolCount\s*=\s*leadStats\.riskPool|riskPoolCount: leadStats\.riskPool/);
});

test("dashboard no longer prints an amount as a count and labels contracts, valued deals and periods", () => {
  const page = read("src/app/(dashboard)/dashboard/page.tsx");
  assert.doesNotMatch(page, /nPending"\)\.replace\("\{n\}", String\(financeStats\.dueNextWeek\)\)/);
  assert.doesNotMatch(page, /nDeals"\)\.replace\("\{n\}", String\(stats\.pipelineSize\)\)/);
  assert.doesNotMatch(page, /t\("dashboard\.kpiActive"\)/, "106 is the contract count: it is not 'ACTIVE'");
  assert.match(page, /valuedCount/);
  assert.match(page, /s37\.captions?\./);
});

test("every key the cockpit asks for exists in both languages, with Chinese in zh", async () => {
  const src = read("src/lib/i18n/translations.ts");
  const enBlock = src.slice(src.indexOf("  en: {"), src.indexOf("  zh: {"));
  const zhBlock = src.slice(src.indexOf("  zh: {"));
  const keys = [...read("src/app/(dashboard)/dashboard/page.tsx").matchAll(/t\("(s37\.[A-Za-z0-9_.]+)"\)/g)].map((m) => m[1]);
  assert.ok(keys.length > 10);
  for (const key of new Set(keys)) {
    const leaf = key.split(".").pop();
    assert.ok(new RegExp(`\\b${leaf}:`).test(enBlock), `en ${key}`);
    assert.ok(new RegExp(`\\b${leaf}:`).test(zhBlock), `zh ${key}`);
  }
  assert.match(zhBlock, /unknown_import:\s*"[^"]*[一-鿿]/);
  assert.match(enBlock, /unknown_import:\s*"[A-Z]/);
});

// ── missing #4 : ads page ─────────────────────────────────────────────────
test("valid leads are split into rated and not yet rated", () => {
  const rows = [
    lead({ id: "g", source: "fb", quality: "good" }),
    lead({ id: "n", source: "fb", quality: "normal" }),
    lead({ id: "b", source: "fb", quality: "bad" }),
    lead({ id: "p1", source: "fb", quality: "pending" }),
    lead({ id: "p2", source: "fb" }),
  ];
  const g = aggregateAttribution(rows).fb;
  assert.equal(g.total, 5);
  assert.equal(g.valid, 2);
  assert.equal(g.rated, 3);
  assert.equal(g.unrated, 2);
  assert.equal(g.rated + g.unrated, g.total);
});

test("ads page says spend is not connected instead of showing an empty cost column", () => {
  const page = read("src/app/(dashboard)/ads/page.tsx");
  assert.match(page, /ads\.spendNotConnected/);
  assert.match(page, /ads\.notYetRated/);
  const dict = read("src/lib/i18n/translations.ts");
  assert.match(dict, /花费数据未接入，单条线索成本请看 Meta 广告后台/);
  assert.match(dict, /Spend not connected — see Meta Ads Manager for cost per lead/);
});

test("analytics ads block states its window", () => {
  const src = read("src/app/(dashboard)/analytics/_components/AdsROI.tsx");
  assert.match(src, /analytics\.adLeadsWindow/);
});

// ── B4 : WhatsApp ad badge, last touch ────────────────────────────────────
test("whatsapp ad leads are counted as last touch whatever their stored source", () => {
  const rows = [
    lead({ id: "a", source: "show_room", ctwa_clid: "AbC" }),
    lead({ id: "b", source: "show_room" }),
  ];
  const g = aggregateAttribution(rows).show_room;
  assert.equal(g.total, 2);
  assert.equal(g.waAd, 1);
});

test("list card and lead header show the WhatsApp ad badge", () => {
  assert.match(read("src/app/(dashboard)/leads/_components/LeadCard.tsx"), /isWhatsAppAdLead/);
  assert.match(read("src/app/(dashboard)/leads/[id]/page.tsx"), /isWhatsAppAdLead/);
});

// ── formats ───────────────────────────────────────────────────────────────
test("money is whole dirhams with thousands separators", () => {
  assert.equal(formatAED(12345), "AED 12,345");
  assert.equal(formatAED(731686.04), "AED 731,686");
  assert.equal(formatAED(0), "AED 0");
  assert.equal(formatAED(1234567), "AED 1,234,567");
  assert.equal(formatAED(null), "—");
});

test("dates read 22 Nov / 11月22日 and clock times are 24h Dubai", () => {
  assert.equal(formatShortDate("2026-11-22T08:00:00Z"), "22 Nov");
  assert.equal(formatShortDate("2026-11-22T08:00:00Z", "zh"), "11月22日");
  assert.equal(formatDubaiTime("2026-11-22T10:05:00Z"), "14:05");
  assert.equal(formatDateTime("2026-11-22T19:30:00Z"), "22 Nov 23:30");
  // 20:30 UTC on the 22nd is already the 23rd in Dubai
  assert.equal(formatShortDate("2026-11-22T20:30:00Z"), "23 Nov");
});

test("a date-only value never shows a time and never shifts", () => {
  assert.equal(isDateOnly("2026-11-22"), true);
  assert.equal(formatDubaiTime("2026-11-22"), "");
  assert.equal(formatDateTime("2026-11-22"), "22 Nov");
  assert.equal(formatDateTime("2026-11-22", "zh"), "11月22日");
});

test("cockpit has no emoji alert bar and no raw status codes", () => {
  const alert = read("src/app/(dashboard)/dashboard/_components/AlertPanel.tsx");
  const weekly = read("src/app/(dashboard)/dashboard/_components/WeeklyReview.tsx");
  const dash = read("src/app/(dashboard)/dashboard/page.tsx");
  const emoji = /[\u{1F300}-\u{1FAFF}☀-➿⚠]/u;
  for (const [name, src] of [["AlertPanel", alert], ["WeeklyReview", weekly], ["dashboard", dash]]) {
    assert.doesNotMatch(src, emoji, `${name} still contains an emoji`);
  }
  assert.match(alert, /s37\.alertLine|overdueSentence/);
});
