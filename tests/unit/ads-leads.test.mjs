// S27: the ads page and ads-roi stop at leads, count click-to-WhatsApp leads, and read one Dubai window.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  adLabel, attributionGroup, buildAdNameMap, costPerLead, dubaiWeekStartKey, isAdLead, resolveAdsWindow,
  spendFreshness, weeklyLeadCost,
} from "../../src/lib/ads-leads.mjs";
import { defaultWindow } from "../../src/lib/meta-ads-insights.mjs";
import { aggregateAttribution } from "../../src/lib/lead-metrics.mjs";

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const wa = (o = {}) => ({ archived: false, source: "whatsapp", ctwa_clid: "AbCdEfGhIjKlMn", ad_id: "120001", ...o });

test("a click-to-WhatsApp lead is an ad lead even with no campaign fields; a plain WhatsApp lead is not", () => {
  assert.equal(isAdLead(wa()), true);
  assert.equal(isAdLead({ source: "whatsapp", ctwa_clid: "AbCdEfGhIjKlMn" }), true);
  assert.equal(isAdLead({ source: "whatsapp", ad_id: "120001" }), true);
  assert.equal(isAdLead({ source: "ins" }), true);
  assert.equal(isAdLead({ source: "website" }), false);
  assert.equal(isAdLead({ source: "whatsapp", ctwa_clid: "", ad_id: null }), false);
});

test("the ads-roi query takes ctwa_clid / ad_id leads and the same window for spend and leads", () => {
  const src = read("src/app/api/dashboard/ads-roi/route.ts");
  assert.match(src, /ctwa_clid\.not\.is\.null,ad_id\.not\.is\.null/);
  assert.match(src, /\.gte\("spend_date", window\.since\)[\s\S]*\.lte\("spend_date", window\.until\)/);
  assert.match(src, /\.gte\("created_at", window\.startInstant\.toISOString\(\)\)[\s\S]*\.lt\("created_at", window\.endInstant\.toISOString\(\)\)/);
  assert.doesNotMatch(src, /roas|signed_amount|isWonLead|wonLeadValue/i, "no deal amount in the ad return");
});

test("ad view groups by ad id; the name only labels; names come from any lead of that ad", () => {
  const leads = [
    wa({ id: "1", ad_name: null, created_at: "2026-11-02T08:00:00Z" }),
    wa({ id: "2", ad_name: "Villa Spring", created_at: "2026-11-03T08:00:00Z" }),
    wa({ id: "3", ad_id: "120002", ad_name: null }),
    { source: "ins", ad_id: null, ad_name: "Old ad" },
    { source: "ins" },
  ];
  const names = buildAdNameMap(leads);
  assert.equal(names.get("120001"), "Villa Spring");
  const key = (l) => attributionGroup(l, "ad", names);
  assert.deepEqual(key(leads[0]), { key: "ad:120001", label: "Villa Spring (120001)" });
  assert.equal(key(leads[0]).key, key(leads[1]).key, "renaming/unnamed copies of one ad id stay one row");
  assert.deepEqual(key(leads[2]), { key: "ad:120002", label: "120002" });
  assert.deepEqual(key(leads[3]), { key: "name:Old ad", label: "Old ad" });
  assert.equal(key(leads[4]).key, "uncategorized");
  const groups = aggregateAttribution(leads, (l) => key(l).key);
  assert.equal(groups["ad:120001"].total, 2);
  assert.equal(adLabel("9", ""), "9");
});

test("campaign / adset views show a click-to-WhatsApp lead under its ad id, not uncategorized", () => {
  assert.equal(attributionGroup(wa(), "campaign").key, "ad:120001");
  assert.equal(attributionGroup(wa(), "adset").key, "ad:120001");
  assert.equal(attributionGroup(wa({ campaign_name: "Eid" }), "campaign").key, "Eid");
  assert.equal(attributionGroup(wa({ ad_id: null, campaign_id: "77" }), "campaign").key, "campaign:77");
  assert.equal(attributionGroup({ source: "ins" }, "campaign").key, "uncategorized");
  assert.equal(attributionGroup({ source: "ins", source_platform: "meta" }, "source").key, "ins");
});

test("window is Dubai dates: 30 days ending today by default, selectable, bad input refused", () => {
  const now = new Date("2026-11-19T21:00:00Z"); // 01:00 on 20 Nov in Dubai
  const w = resolveAdsWindow({ now });
  assert.equal(w.until, "2026-11-20");
  assert.equal(w.since, "2026-10-22");
  assert.equal(w.startInstant.toISOString(), "2026-10-21T20:00:00.000Z");
  assert.equal(w.endInstant.toISOString(), "2026-11-20T20:00:00.000Z");
  assert.equal(resolveAdsWindow({ days: "7", now }).since, "2026-11-14");
  assert.deepEqual(
    [resolveAdsWindow({ since: "2026-11-01", until: "2026-11-05", now }).since, resolveAdsWindow({ since: "2026-11-01", until: "2026-11-05", now }).until],
    ["2026-11-01", "2026-11-05"],
  );
  for (const bad of [{ days: "0" }, { days: "abc" }, { days: "9999" }, { since: "2026-11-05", until: "2026-11-01" }, { since: "x", until: "y" }]) {
    assert.ok(resolveAdsWindow({ ...bad, now }).error, JSON.stringify(bad));
  }
});

test("the Meta default sync window ends yesterday in Dubai, not UTC", () => {
  // 21:00 UTC on 14 Sep is already 15 Sep in Dubai, so "yesterday" is 14 Sep (UTC would say 13 Sep)
  assert.deepEqual(defaultWindow(7, new Date("2026-09-14T21:00:00Z")), { since: "2026-09-08", until: "2026-09-14" });
  assert.deepEqual(defaultWindow(1, new Date("2026-09-15T06:00:00Z")), { since: "2026-09-14", until: "2026-09-14" });
});

test("weekly spend and leads use Dubai Monday weeks; cost per lead is spend / leads and null without leads", () => {
  assert.equal(dubaiWeekStartKey("2026-11-15T21:00:00Z"), "2026-11-16", "Sunday 21:00Z is Monday in Dubai");
  assert.equal(dubaiWeekStartKey("2026-11-15"), "2026-11-09");
  const rows = weeklyLeadCost(
    [{ spend_date: "2026-11-09", amount: 100 }, { spend_date: "2026-11-15", amount: 50.5 }, { spend_date: "2026-11-16", amount: 40 }],
    [{ created_at: "2026-11-10T08:00:00Z" }, { created_at: "2026-11-12T08:00:00Z" }, { created_at: "2026-11-15T21:30:00Z" }, { created_at: "2026-11-30T08:00:00Z" }],
  );
  assert.deepEqual(rows.map((r) => r.week_start), ["2026-11-30", "2026-11-16", "2026-11-09"]);
  const byWeek = Object.fromEntries(rows.map((r) => [r.week_start, r]));
  assert.deepEqual(byWeek["2026-11-09"], { week_start: "2026-11-09", week_end: "2026-11-15", spend: 150.5, leads: 2, cpl: 75.25 });
  assert.equal(byWeek["2026-11-16"].leads, 1);
  assert.equal(byWeek["2026-11-30"].cpl, null, "leads but no spend: no cost per lead");
  assert.equal(costPerLead(10, 0), null);
  assert.equal(costPerLead(undefined, 3), null);
});

test("stale spend: older than 3 days or no spend at all", () => {
  const now = new Date("2026-11-19T06:00:00Z");
  assert.deepEqual(spendFreshness("2026-11-19", now), { last_date: "2026-11-19", days_old: 0, stale: false });
  assert.equal(spendFreshness("2026-11-16", now).stale, false);
  assert.equal(spendFreshness("2026-11-15", now).stale, true);
  assert.deepEqual(spendFreshness("2026-10-23", now), { last_date: "2026-10-23", days_old: 27, stale: true });
  assert.equal(spendFreshness(null, now).stale, true);
});

test("/ads and AdsROI show no quotation, won or amount columns, and /api/ads/leads uses the page whitelist", () => {
  const page = read("src/app/(dashboard)/ads/page.tsx");
  assert.doesNotMatch(page, /ads\.quoted|ads\.won|ads\.value|fmtAED\(g\.value|dashboard\.conversionRate/);
  const panel = read("src/app/(dashboard)/analytics/_components/AdsROI.tsx");
  assert.doesNotMatch(panel, /roas|signed_amount|wonAmount|conversions/);
  const route = read("src/app/api/ads/leads/route.ts");
  const roles = (src, re) => src.match(re)[1].split(",").map((x) => x.replace(/["'\s]/g, "")).sort();
  assert.deepEqual(roles(route, /ADS_PAGE_ROLES = \[([^\]]*)\]/), roles(page, /useRequireRole\(\[([^\]]*)\]\)/));
  assert.doesNotMatch(route, /role === "sales"/);
});

test("the daily ads-sync cron: route is flag-gated and secret-gated, schedule row and timer exist", () => {
  const route = read("src/app/api/cron/ads-sync/route.ts");
  assert.match(route, /x-cron-secret/);
  assert.match(route, /ADS_SYNC_CRON_ENABLED !== "true"/);
  assert.ok(route.indexOf("ADS_SYNC_CRON_ENABLED") < route.indexOf("fetch("), "nothing is fetched from Meta before the flag check");
  assert.match(route, /replace_meta_ad_spend_window/);
  const row = JSON.parse(read("infra/cron/schedule.json")).endpoints.find((e) => e.name === "ads-sync");
  assert.deepEqual([row.install, row.dubaiTime, row.idempotent], ["after-flag", "06:20", true]);
  assert.ok(row.why.length > 40);
  assert.match(read("infra/cron/newme-cron-ads-sync.timer"), /OnCalendar=\*-\*-\* 06:20:00 Asia\/Dubai/);
});
