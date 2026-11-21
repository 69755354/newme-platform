import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildWeeklyAdReview, reviewCsv, reviewMessage, reviewText, reviewWindow, MESSAGE_MAX_CHARS, quoteAmounts,
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
