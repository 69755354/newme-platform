import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWeeklyAdReview, parseSpendFile, reviewCsv, reviewMessage, reviewText, reviewWindow, MESSAGE_MAX_CHARS, quoteAmounts,
} from "../../src/lib/weekly-ad-review.mjs";
import { normalizedPhone } from "../../src/lib/capi-hash.mjs";
import { buildMetaCapiLeadPayload } from "../../src/lib/meta-capi.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/weekly-ad-review.json", import.meta.url), "utf8"));
const window = reviewWindow(new Date("2026-11-23T05:10:00Z")); // Monday 09:10 Dubai

test("window is the 7 whole Dubai days before Monday", () => {
  assert.equal(window.since, "2026-11-16");
  assert.equal(window.until, "2026-11-22");
  assert.equal(window.endInstant.toISOString(), "2026-11-22T20:00:00.000Z");
});

test("per ad numbers with spend", () => {
  const r = buildWeeklyAdReview({ window, ...fixture });
  const a = r.rows.find((x) => x.ad_id === "111");
  assert.deepEqual([a.spend, a.leads, a.cpl, a.good_leads, a.quotes, a.quote_value], [600, 4, 150, 3, 2, 70000]);
  const b = r.rows.find((x) => x.ad_id === "222");
  assert.deepEqual([b.spend, b.leads, b.good_leads, b.quotes], [900, 3, 0, 0]);
  assert.equal(r.spend_available, true);
  assert.equal(r.totals.spend, 1500 + 120);
  assert.ok(r.rows.some((x) => x.ad === "Old reel" && x.leads === 0 && x.spend === 120));
});

test("quote amount: newest non-rejected quotation, else reported value, AED only", () => {
  const m = quoteAmounts([{ id: "x" }, { id: "y", quotation_value: 5000 }, { id: "z" }], [
    { lead_id: "x", total_amount: 100, status: "sent", created_at: "2026-11-01" },
    { lead_id: "x", total_amount: 300, status: "sent", created_at: "2026-11-02" },
    { lead_id: "x", total_amount: 999, status: "rejected", created_at: "2026-11-03" },
    { lead_id: "z", total_amount: 50, currency: "USD", status: "sent", created_at: "2026-11-03" },
  ]);
  assert.equal(m.get("x"), 300); assert.equal(m.get("y"), 5000); assert.equal(m.has("z"), false);
});

test("suggestions: 3 to 5, plain Chinese, scale/pause/test, never an action", () => {
  const r = buildWeeklyAdReview({ window, ...fixture });
  assert.ok(r.suggestions.length >= 3 && r.suggestions.length <= 5);
  const all = r.suggestions.join("\n");
  assert.match(all, /可以加预算：「Villa tour A/);
  assert.match(all, /建议暂停或减量：「Promo B/);
  assert.match(all, /新素材/);
  assert.ok(!/[A-Za-z]{4,}\(|CPL|ROAS/.test(all.replace(/「[^」]*」/g, "")));
});

test("works without spend and says so", () => {
  const r = buildWeeklyAdReview({ window, ...fixture, spendRows: [] });
  assert.equal(r.spend_available, false);
  assert.equal(r.totals.spend, null);
  assert.ok(r.rows.every((x) => x.spend === null && x.cpl === null));
  assert.match(r.suggestions[0], /花费数据还没接入/);
  assert.match(reviewText(r), /花费数据还没接入/);
  assert.match(reviewMessage(r), /花费数据未接入/);
});

test("no leads at all still gives suggestions", () => {
  const r = buildWeeklyAdReview({ window, spendRows: [], leads: [], quotations: [] });
  assert.ok(r.suggestions.length >= 3);
});

test("WhatsApp message fits the sender limit; CSV has BOM, header, formula guard", () => {
  const r = buildWeeklyAdReview({ window, ...fixture });
  assert.ok(reviewMessage(r).length <= MESSAGE_MAX_CHARS);
  assert.ok(!reviewMessage(r).includes("\n"));
  const csv = reviewCsv({ ...r, rows: [{ ...r.rows[0], ad: "=HYPERLINK(1)" }] });
  assert.ok(csv.startsWith("﻿广告,广告编号"));
  assert.match(csv, /'=HYPERLINK\(1\)/);
});

test("phone normalisation to E.164 digits", () => {
  for (const [raw, want] of [["+971 50 123 4567", "971501234567"], ["0501234567", "971501234567"], ["+971 0501234567", "971501234567"],
    ["00971501234567", "971501234567"], ["501234567", "971501234567"], ["+44 7700 900123", "447700900123"]]) {
    assert.equal(normalizedPhone(raw), want, raw);
  }
});

test("website CAPI payload: hashed ph/em/country, fbc rebuilt from fbclid, same event id as the browser", () => {
  const input = { customerName: "Nadia Khan", phone: "+971 0501234567", email: "N@x.ae",
    attribution: { eventId: "evt-1", fbclid: "ABC", fbc: null, fbp: "fb.1.1.2", landingPage: "https://newme.ae/" } };
  const e = buildMetaCapiLeadPayload({ leadId: "l1", input, clientIp: "203.0.113.1", clientUserAgent: "ua", eventTime: 1_700_000_000 }).data[0];
  assert.equal(e.event_id, "evt-1");
  assert.match(e.user_data.ph[0], /^[0-9a-f]{64}$/);
  assert.equal(e.user_data.fbc, "fb.1.1700000000000.ABC");
  assert.equal(e.user_data.country.length, 1);
  const none = buildMetaCapiLeadPayload({ leadId: "l1", input: { ...input, phone: "12", attribution: { ...input.attribution, fbclid: null } }, clientIp: "unknown", clientUserAgent: null }).data[0];
  assert.equal(none.user_data.ph, undefined);
  assert.equal(none.user_data.fbc, undefined);
});

test("units: switch default off, timer Monday 09:10 Dubai, installer installs but never enables", () => {
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
  const service = read("infra/systemd/newme-weekly-ad-review.service");
  const timer = read("infra/systemd/newme-weekly-ad-review.timer");
  const installer = read("scripts/install-systemd-assets.sh");
  assert.match(timer, /^OnCalendar=Mon \*-\*-\* 09:10:00 Asia\/Dubai$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/node scripts\/weekly-ad-review\.mjs --execute$/m);
  assert.match(service, /^OnFailure=newme-unit-alert@%n\.service$/m);
  assert.ok(installer.includes("/etc/systemd/system/newme-weekly-ad-review.timer\n"));
  assert.ok(installer.includes("infra/systemd/newme-weekly-ad-review.timer"));
  assert.ok(!/enable[^\n]*newme-weekly-ad-review/.test(installer));
});

test("runner: switched off does nothing; dry run touches nothing", async () => {
  const { main } = await import("../../scripts/weekly-ad-review.mjs");
  assert.equal(await main(["--execute"], {}), 0);
  assert.equal(await main(["--bogus"], {}), 2);
});

// ---- spend file (Meta connector) ----
const spendFile = JSON.parse(readFileSync(new URL("../fixtures/weekly-ad-review-spend-file.json", import.meta.url), "utf8"));
const metaRows = parseSpendFile(spendFile).rows;
const { spendRows: _unusedSpendRows, ...leadData } = fixture;

test("spend file: matches by ad_id even when the Meta name differs; spend table is not used", () => {
  const r = buildWeeklyAdReview({ window, ...leadData, spendRows: [{ ad_name: "Promo B", amount: 99999 }], metaRows });
  const a = r.rows.find((x) => x.ad_id === "111");
  assert.deepEqual([a.spend, a.leads, a.cpl, a.good_leads, a.quotes], [600, 4, 150, 3, 2]);
  assert.equal(a.cost_per_good, 200); assert.equal(a.cost_per_quote, 300);
  assert.deepEqual([a.meta_leads, a.meta_conversations, a.clicks, a.impressions], [1, 7, 900, 40000]);
  assert.equal(r.rows.find((x) => x.ad_id === "222").spend, 900);
  const old = r.rows.find((x) => x.ad_id === "999");
  assert.deepEqual([old.leads, old.spend], [0, 120]);
  assert.equal(r.totals.spend, 1620);
  assert.equal(r.totals.cost_per_good, 540); assert.equal(r.totals.cost_per_quote, 810);
  assert.equal(r.spend_source, "meta_file");
});

test("spend file: falls back to ad name when a lead has no ad_id", () => {
  const leads = [{ id: "n1", ad_name: "Promo B", quality: "good", created_at: "2026-11-18T08:00:00Z", source: "fb", archived: false }];
  const r = buildWeeklyAdReview({ window, leads, quotations: [], metaRows });
  const row = r.rows.find((x) => x.leads === 1);
  assert.equal(row.spend, 900); assert.equal(row.meta_conversations, 3);
});

test("spend file: gap line shows Meta reports versus OS leads", () => {
  const r = buildWeeklyAdReview({ window, ...leadData, metaRows });
  assert.deepEqual(r.meta, { leads: 1, conversations: 10, os_leads: 7, gap: 4 });
  const msg = reviewMessage(r);
  assert.match(msg, /Meta报告线索1条、WhatsApp对话10条，OS记录7条，有4条没进OS/);
  assert.ok(msg.length <= MESSAGE_MAX_CHARS && !msg.includes("\n"));
  assert.match(reviewText(r), /有4条没进OS/);
  const none = buildWeeklyAdReview({ window, ...leadData, metaRows: metaRows.map((m) => ({ ...m, meta_leads: 0, messaging_conversations: 0 })) });
  assert.match(reviewMessage(none), /没有缺口/);
});

test("spend file: suggestions use cost per good lead and cost per quote, suggestions only", () => {
  const r = buildWeeklyAdReview({ window, ...leadData, metaRows });
  const all = r.suggestions.join("\n");
  assert.match(all, /可以加预算：「Villa tour A.*每条好线索200.*每个报价300/);
  assert.match(all, /建议暂停或减量：「Promo B.*花了900/);
  assert.match(reviewText(r), /每条好线索 540.*每个报价 810/);
  assert.match(reviewText(r), /不会自动改任何投放/);
  assert.ok(r.suggestions.length >= 3 && r.suggestions.length <= 5);
});

test("spend file: CSV carries the new columns", () => {
  const csv = reviewCsv(buildWeeklyAdReview({ window, ...leadData, metaRows }));
  assert.match(csv.split("\r\n")[0], /每条好线索成本\(AED\),每个报价成本\(AED\),Meta报告线索,Meta报告WhatsApp对话,点击,展示$/);
  assert.match(csv, /Villa tour A \(111\),111,Villas,600,4,150,3,0,2,70000,,200,300,1,7,900,40000/);
});

test("spend file validation: strict, rejects with a reason and no row contents", () => {
  const ok = { ad_id: "1", ad_name: "A", campaign_name: "C", adset_name: "S", spend: 1, currency: "AED", impressions: 1, clicks: 1, meta_leads: 0, messaging_conversations: 0 };
  assert.equal(parseSpendFile([ok]).rows.length, 1);
  assert.ok(parseSpendFile([]).rows);
  const bad = [
    ["not array", { a: 1 }], ["row not object", [1]], ["no ad_id", [{ ...ok, ad_id: "" }]], ["odd ad_id", [{ ...ok, ad_id: "1; drop" }]],
    ["negative spend", [{ ...ok, spend: -1 }]], ["string spend", [{ ...ok, spend: "5" }]], ["NaN spend", [{ ...ok, spend: NaN }]],
    ["missing spend", [{ ...ok, spend: undefined }]], ["negative clicks", [{ ...ok, clicks: -3 }]], ["currency USD", [{ ...ok, currency: "USD" }]],
    ["no currency", [{ ...ok, currency: undefined }]], ["duplicate", [ok, ok]], ["long name", [{ ...ok, ad_name: "x".repeat(301) }]],
    ["501 rows", Array.from({ length: 501 }, (_, i) => ({ ...ok, ad_id: String(i) }))],
  ];
  for (const [label, data] of bad) assert.ok(parseSpendFile(data).error, label);
  assert.ok(parseSpendFile(Array.from({ length: 500 }, (_, i) => ({ ...ok, ad_id: String(i) }))).rows);
  assert.ok(!/secret-name/.test(parseSpendFile([{ ...ok, ad_name: "secret-name", spend: -1 }]).error));
});

test("runner: --spend-file validation exits 2 before touching the database; arguments checked", async () => {
  const { main, parseArgs } = await import("../../scripts/weekly-ad-review.mjs");
  const dir = mkdtempSync(join(tmpdir(), "adr-"));
  const badFile = join(dir, "bad.json");
  writeFileSync(badFile, JSON.stringify([{ ad_id: "1", ad_name: "A", spend: -5, currency: "AED" }]));
  const usdFile = join(dir, "usd.json");
  writeFileSync(usdFile, JSON.stringify([{ ad_id: "1", ad_name: "A", spend: 5, currency: "USD" }]));
  const notJson = join(dir, "x.json");
  writeFileSync(notJson, "{nope");
  for (const f of [badFile, usdFile, notJson, join(dir, "missing.json")]) assert.equal(await main(["--spend-file", f], {}), 2, f);
  assert.equal(await main(["--spend-file"], {}), 2);
  assert.equal(await main(["--print", "--execute"], {}), 2);
  assert.deepEqual(parseArgs(["--spend-file=/x.json", "--print"]), { execute: false, print: true, spendFile: "/x.json" });
  assert.deepEqual(parseArgs(["--spend-file", "/x.json"]), { execute: false, print: false, spendFile: "/x.json" });
  assert.equal(parseArgs(["--spend-file", "/a", "--spend-file", "/b"]), null);
  // a valid file passes validation and then stops at the missing database configuration (exit 1), still sending nothing
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify(spendFile));
  assert.equal(await main(["--spend-file", good, "--print"], {}), 1);
  rmSync(dir, { recursive: true, force: true });
});

test("suggestions: no quality marks or quotes anywhere means no pause advice, cost per lead only", () => {
  const leads = fixture.leads.map((l) => ({ ...l, quality: null, ai_quality: null, quotation_value: null }));
  const r = buildWeeklyAdReview({ window, ...fixture, leads, quotations: [] });
  const all = r.suggestions.join("\n");
  assert.equal(r.totals.good_leads, 0);
  assert.doesNotMatch(all, /建议暂停或减量：「(?!.*没有带来线索)/);
  assert.match(all, /还没有标好坏/);
});

test("suggestions: leads explicitly marked bad still get pause advice (marks exist, none good)", () => {
  const leads = fixture.leads.map((l) => ({ ...l, quality: "bad", ai_quality: null, quotation_value: null }));
  const r = buildWeeklyAdReview({ window, ...fixture, leads, quotations: [] });
  const all = r.suggestions.join("\n");
  assert.doesNotMatch(all, /还没有标好坏/);
  assert.match(all, /建议暂停或减量/);
});
