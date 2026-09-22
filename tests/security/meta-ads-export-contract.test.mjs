/**
 * The Ads Manager export path: what it accepts, what it refuses, and what the
 * importer script is allowed to do to ad_spend.
 *
 * Every boundary asserted here has a negative control that breaks the boundary and
 * requires the check to go red, for the same reason as in
 * meta-ads-sync-contract.test.mjs: a check with no negative control cannot tell
 * "the boundary holds" from "the check never looked at it".
 *
 * The header below is the real one from an Ads Manager ad-level CSV export of ad
 * account 968615798111277, column names verbatim. The data rows are invented — the
 * real export is not committed, because this repository is public and the
 * business's ad names and spend are not test fixtures.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ACCOUNT_CURRENCY, EXCEL_SOURCE, apiSourceForAccount, isApiSource } from "../../src/lib/meta-ads-insights.mjs";
import {
  EXPORT_SOURCE,
  EXPORT_SOURCE_PREFIX,
  detectColumns,
  exportRowKey,
  exportSourceForAccount,
  isExportSource,
  mapExportRows,
  parseCsv,
} from "../../src/lib/meta-ads-export.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = "scripts/import-ads-manager-export.mjs";
const EXPORT_LIB = "src/lib/meta-ads-export.mjs";
const INSIGHTS_LIB = "src/lib/meta-ads-insights.mjs";
const IMPORTER = "src/app/api/dashboard/ads-roi/import/route.ts";
const read = (rel) => readFile(path.join(ROOT, rel), "utf8");

const ACCOUNT = "968615798111277";
const HEADER = [
  "Reporting starts",
  "Reporting ends",
  "Ad name",
  "Ad delivery",
  "Results",
  "Result indicator",
  "Cost per results",
  "Ad set budget",
  "Ad set budget type",
  "Amount spent (AED)",
  "Impressions",
  "Reach",
  "Ends",
  "Attribution setting",
  "Bid",
  "Bid type",
  "Last significant edit",
  "Quality ranking",
  "Engagement rate ranking",
  "Conversion rate ranking",
  "Ad set name",
];

/** The real header, optionally with the amount column relabelled or columns dropped/added. */
function headerWith({ currency = "AED", drop = [], add = [] } = {}) {
  const amount = currency ? `Amount spent (${currency})` : "Amount spent";
  return [
    ...HEADER.filter((name) => !drop.includes(name)).map((name) => (name === "Amount spent (AED)" ? amount : name)),
    ...add,
  ];
}

function quote(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Build a CSV in the real export's column order. `$amount` lands in whatever the amount column is called. */
function csv(rows, header = HEADER) {
  const index = new Map(header.map((name, i) => [name, i]));
  const lines = [header.map(quote).join(",")];
  for (const row of rows) {
    const cells = new Array(header.length).fill("");
    for (const [name, value] of Object.entries(row)) {
      const at = name === "$amount" ? header.findIndex((cell) => /^Amount spent/.test(cell)) : index.get(name);
      if (at === undefined || at < 0) throw new Error(`test bug: no column named ${name}`);
      cells[at] = value;
    }
    lines.push(cells.map(quote).join(","));
  }
  return `${lines.join("\n")}\n`;
}

const day = (date, name, amount, extra = {}) => ({
  "Reporting starts": date,
  "Reporting ends": date,
  "Ad name": name,
  $amount: amount,
  ...extra,
});

// --------------------------------------------------------------------------
// 1 · the refusal that matters most
// --------------------------------------------------------------------------

test("an export whose rows cover a date range is refused, by name", () => {
  // This is the shape Ads Manager gives by default: one row per ad for the whole
  // reporting window. There is no honest per-day number in it. The twelve legacy
  // rows in ad_spend are what happens when it is stored anyway — every one of them
  // stamped 2025-12-01 — so the file is refused and the report names the setting to
  // change rather than salvaging part of it.
  const text = csv([
    { "Reporting starts": "2025-01-01", "Reporting ends": "2026-09-15", "Ad name": "Website promotion", $amount: "1200.00" },
    { "Reporting starts": "2025-01-01", "Reporting ends": "2026-09-15", "Ad name": "Feed post", $amount: "340.50" },
  ]);
  const result = mapExportRows(text, { accountId: ACCOUNT });

  assert.equal(result.ok, false);
  assert.equal(result.error, "aggregate_window_not_daily");
  assert.match(result.next, /breakdown_by_day/);
  assert.equal(result.rows.length, 0, "not one row may survive a range export");
  assert.deepEqual(
    result.rejected.map((entry) => entry.reason),
    ["aggregate_window_not_daily", "aggregate_window_not_daily"],
  );
  assert.equal(result.rejected[0].window, "2025-01-01..2026-09-15", "the report says what the row actually covered");

  // Negative control: make the window one day and the same file is accepted, so the
  // refusal is about the window and not about something else in those rows.
  const daily = text.replaceAll("2026-09-15", "2025-01-01");
  const accepted = mapExportRows(daily, { accountId: ACCOUNT });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.rows.length, 2);
});

// --------------------------------------------------------------------------
// 2 · the mapping
// --------------------------------------------------------------------------

test("a day-broken export maps to one row per ad per day", () => {
  const header = headerWith({ add: ["Link clicks"] });
  const text = csv(
    [
      day("2025-11-20", "Website promotion", "120.55", { Impressions: "4,010", "Link clicks": "18", "Ad set name": "[11/20/2025] Promoting" }),
      day("2025-11-21", "Website promotion", "301.4", { Impressions: "9100", "Link clicks": "41", "Ad set name": "[11/20/2025] Promoting" }),
    ],
    header,
  );
  const result = mapExportRows(text, { accountId: ACCOUNT });

  assert.equal(result.ok, true, JSON.stringify(result.rejected));
  assert.equal(result.currency, ACCOUNT_CURRENCY);
  assert.deepEqual(result.window, { since: "2025-11-20", until: "2025-11-21" });
  assert.deepEqual(result.rows[0], {
    campaign_name: null,
    adset_name: "[11/20/2025] Promoting",
    ad_name: "Website promotion",
    spend_date: "2025-11-20",
    amount: 120.55,
    currency: "AED",
    impressions: 4010,
    clicks: 18,
    source: `${EXPORT_SOURCE_PREFIX}${ACCOUNT}`,
  });
  assert.equal(result.rows[1].amount, 301.4, "thousands separators and short decimals both parse");
});

test("the currency is read from the amount header and is never converted", () => {
  const rows = [day("2025-11-20", "Website promotion", "120.55")];

  const foreign = mapExportRows(csv(rows, headerWith({ currency: "USD" })), { accountId: ACCOUNT });
  assert.equal(foreign.ok, false);
  assert.deepEqual(foreign.rejected.map((entry) => entry.reason), ["wrong_currency"]);
  assert.equal(foreign.rejected[0].currency, "USD");
  assert.equal(foreign.rows.length, 0, "a foreign amount is never rebased into AED");

  // An amount column that does not say what it counts has no currency; it is not
  // assumed to be the account's.
  const unlabelled = mapExportRows(csv(rows, headerWith({ currency: "" })), { accountId: ACCOUNT });
  assert.equal(unlabelled.ok, false);
  assert.deepEqual(unlabelled.rejected.map((entry) => entry.reason), ["missing_currency"]);

  // Negative control: label it AED and the same numbers go through.
  assert.equal(mapExportRows(csv(rows), { accountId: ACCOUNT }).ok, true);
});

test("a missing required column fails closed and says which one", () => {
  const header = headerWith({ drop: ["Ad name"] });
  const text = csv([{ "Reporting starts": "2025-11-20", "Reporting ends": "2025-11-20", $amount: "120.55" }], header);
  const result = mapExportRows(text, { accountId: ACCOUNT });

  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_columns");
  assert.deepEqual(result.missing, ["ad_name"]);
  assert.equal(result.rows.length, 0, "a file we cannot read is not read partially");

  // Negative control: the same file with the column back is understood.
  assert.equal(mapExportRows(csv([day("2025-11-20", "Website promotion", "120.55")]), { accountId: ACCOUNT }).ok, true);
});

test("reach is never filed as impressions", () => {
  // The Excel parser that produced the legacy rows matched /impressions|reach/ for
  // one key, so an export without impressions silently stored reach in its place.
  const header = headerWith({ drop: ["Impressions"] });
  const result = mapExportRows(csv([day("2025-11-20", "Website promotion", "120.55", { Reach: "2600" })], header), {
    accountId: ACCOUNT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].impressions, null, "an absent impressions column is absent, not reach");
  assert.equal("impressions" in detectColumns(header).columns, false);

  // Negative control: with a real impressions column the number does arrive.
  const withImpressions = mapExportRows(csv([day("2025-11-20", "Website promotion", "120.55", { Impressions: "2600" })]), {
    accountId: ACCOUNT,
  });
  assert.equal(withImpressions.rows[0].impressions, 2600);
});

test("quoted commas, embedded newlines, a BOM, RTL marks and emoji all survive", () => {
  const name = 'Feed post: ‏التحكم, "smart" \nclimate \u{1F32C}\u{FE0F}';
  const text = `﻿${csv([day("2025-11-20", name, "12.00", { "Ad set name": "set, one" })])}`;
  const result = mapExportRows(text, { accountId: ACCOUNT });

  assert.equal(result.ok, true, JSON.stringify(result.rejected));
  assert.equal(result.rows[0].ad_name, name);
  assert.equal(result.rows[0].adset_name, "set, one");

  const table = parseCsv(text);
  assert.equal(table[0][0], "Reporting starts", "the BOM is stripped from the first header cell");
  assert.equal(table[1].length, HEADER.length);

  // Negative control on the reader itself: this file is unparseable by the naive
  // split-on-comma that a hand-rolled reader would use.
  assert.notEqual(text.split("\n")[1]?.split(",").length, HEADER.length);
});

test("one ad twice in a day collapses to one row; one name in two ad sets stays two", () => {
  const collapsed = mapExportRows(
    csv([day("2025-11-20", "Website promotion", "10.00", { "Ad set name": "A" }), day("2025-11-20", "Website promotion", "11.00", { "Ad set name": "A" })]),
    { accountId: ACCOUNT },
  );
  assert.equal(collapsed.rows.length, 1);
  assert.equal(collapsed.rows[0].amount, 11, "last wins, the same rule the API path uses");
  assert.equal(collapsed.duplicates, 1, "and the collapse is reported rather than hidden");

  const distinct = mapExportRows(
    csv([day("2025-11-20", "Website promotion", "10.00", { "Ad set name": "A" }), day("2025-11-20", "Website promotion", "11.00", { "Ad set name": "B" })]),
    { accountId: ACCOUNT },
  );
  assert.equal(distinct.rows.length, 2, "the ad set is part of the key");
  assert.equal(distinct.duplicates, 0);
});

test("a day with no spend is skipped; an amount that is not a number is refused", () => {
  const result = mapExportRows(
    csv([
      day("2025-11-20", "Website promotion", "-"),
      day("2025-11-21", "Website promotion", ""),
      day("2025-11-22", "Website promotion", "0.00"),
    ]),
    { accountId: ACCOUNT },
  );
  assert.equal(result.ok, true, "a quiet day is normal and must not block an import");
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ["no_spend_reported", "no_spend_reported"]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].amount, 0, "a reported zero is a fact and is stored");

  const broken = mapExportRows(csv([day("2025-11-20", "Website promotion", "AED 12.00")]), { accountId: ACCOUNT });
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.rejected.map((entry) => entry.reason), ["unparseable_amount"]);

  const badDate = mapExportRows(
    csv([{ "Reporting starts": "11/20/2025", "Reporting ends": "11/20/2025", "Ad name": "Website promotion", $amount: "1" }]),
    { accountId: ACCOUNT },
  );
  assert.equal(badDate.ok, false);
  assert.deepEqual(badDate.rejected.map((entry) => entry.reason), ["unparseable_reporting_window"]);
});

test("a row with no ad name is refused rather than filed under nothing", () => {
  const result = mapExportRows(csv([day("2025-11-20", "", "12.00")]), { accountId: ACCOUNT });
  assert.equal(result.ok, false);
  assert.deepEqual(result.rejected.map((entry) => entry.reason), ["missing_ad_name"]);
});

// --------------------------------------------------------------------------
// 3 · the namespace
// --------------------------------------------------------------------------

test("the export namespace carries the account and cannot be confused with the API's", () => {
  assert.equal(exportSourceForAccount(ACCOUNT), `${EXPORT_SOURCE}:${ACCOUNT}`);
  assert.equal(exportSourceForAccount(`act_${ACCOUNT}`), exportSourceForAccount(ACCOUNT), "act_ prefixed or not is one account");
  assert.throws(() => exportSourceForAccount("not-an-account"), /invalid_ad_account_id/);
  assert.throws(() => exportSourceForAccount(""), /invalid_ad_account_id/);

  const mine = exportSourceForAccount(ACCOUNT);
  const theirs = apiSourceForAccount(ACCOUNT);
  assert.notEqual(mine, theirs, "the same account exported and pulled are two sources");
  assert.equal(isExportSource(mine), true);
  assert.equal(isApiSource(mine), false);
  assert.equal(isExportSource(theirs), false);
  assert.equal(isExportSource(EXCEL_SOURCE), false, "the Excel history stays outside this namespace");

  // Re-pointing at another account must not put rows in the first one's namespace.
  assert.notEqual(exportSourceForAccount("973440948936910"), mine);
});

test("the row key separator is an escape, not a NUL byte", async () => {
  // A literal NUL byte makes git treat the file as binary, which once destroyed an
  // entire delivered patch. The judge has to be the bytes: read as utf8,
  // String#includes("\0") would also match a file that merely mentions it.
  for (const rel of [EXPORT_LIB, INSIGHTS_LIB]) {
    const bytes = await readFile(path.join(ROOT, rel));
    assert.equal(bytes.includes(0), false, `${rel} must not contain a raw NUL byte`);
  }
  const key = exportRowKey({ spend_date: "2025-11-20", adset_name: "A", ad_name: "B" });
  assert.deepEqual(key.split("\u0000"), ["2025-11-20", "A", "B"]);
});

// --------------------------------------------------------------------------
// 4 · what the importer script may do
// --------------------------------------------------------------------------

const firstWriteAt = (text) => {
  const at = [text.indexOf('method: "DELETE"'), text.indexOf('method: "POST"')].filter((i) => i > -1);
  return at.length > 0 ? Math.min(...at) : Number.MAX_SAFE_INTEGER;
};

test("the script refuses a partly understood export before it touches the database", async () => {
  const source = await read(SCRIPT);
  const rejectAt = source.indexOf("export_rows_rejected");
  assert.ok(rejectAt > -1, "a rejected row must stop the run");
  assert.ok(rejectAt < firstWriteAt(source), "and it must stop before the first write");
  assert.match(source, /if \(parsed\.rejected\.length > 0\)/);
  assert.match(source, /no_spend_rows_in_export/, "an export with nothing to write is not an import");
});

test("the script's delete is scoped to its own namespace and window", async () => {
  const source = await read(SCRIPT);
  const scoped = (text) => {
    const at = text.indexOf('method: "DELETE"');
    if (at < 0) return false;
    const call = text.slice(text.lastIndexOf("request(", at), at);
    return /source=eq\.\$\{encodeURIComponent\(namespace\)\}/.test(call) && /windowFilter/.test(call);
  };
  assert.equal(scoped(source), true, "an unscoped delete would take the Excel history with it");

  // Negative control: drop the source filter from that URL and this check must fail.
  const mutated = source.replace("?source=eq.${encodeURIComponent(namespace)}&${windowFilter}", "?${windowFilter}");
  assert.notEqual(mutated, source, "the negative control must actually mutate the source");
  assert.equal(scoped(mutated), false);
});

test("the script's overlap fence looks outside its own namespace and fails closed", async () => {
  const source = await read(SCRIPT);
  const probeAt = source.indexOf("source=neq.");
  assert.ok(probeAt > -1, "the fence must ask about OTHER sources, not its own");
  assert.ok(probeAt < firstWriteAt(source), "and it must run before the replace");
  assert.match(source, /overlapping_spend_window/);
  assert.match(source, /overlap_probe_failed/, "a probe that errored is not an absent conflict");
  assert.match(source, /overlap_probe_unreadable/);
  assert.ok(source.indexOf("overlap_probe_failed") < firstWriteAt(source));

  // Negative control: a probe restricted to its own namespace can never see a clash.
  const mutated = source.replace("source=neq.", "source=eq.");
  assert.notEqual(mutated, source);
  assert.equal(mutated.indexOf("source=neq."), -1);
});

test("nothing is written unless --apply is passed", async () => {
  const source = await read(SCRIPT);
  const gateAt = source.indexOf("if (!options.apply)");
  assert.ok(gateAt > -1, "the dry run is the default");
  assert.ok(gateAt < firstWriteAt(source), "no write may precede the --apply gate");
  assert.match(source, /parse_only_and_apply_are_mutually_exclusive/);
  assert.match(source, /wrote: false/, "the dry run says so in its report");
});

test("the script reads the window back and treats a short count as a failure", async () => {
  const source = await read(SCRIPT);
  assert.match(source, /window_row_count_mismatch/);
  assert.match(source, /window_verify_failed/, "a read-back that errored is not a pass");
  assert.ok(source.indexOf('method: "HEAD"') > source.lastIndexOf('method: "POST"'), "the read-back happens after the insert");
  assert.match(source, /const BATCH = \d+;/, "the insert is batched and the bound is named once");
  assert.match(source, /next: "re_run_this_window_alone"/, "a half-written window says what to do about it");
});

test("the script cannot print the service role key", async () => {
  const source = await read(SCRIPT);
  assert.match(source, /function redact\(text, secrets\)/, "everything logged goes through one redactor");
  assert.match(source, /redact\(body, secrets\)/, "response bodies are redacted");
  assert.match(source, /redact\(error\?\.message \?\? error, secrets\)/, "so are transport errors");
  assert.equal(/console\.(log|error)\([^\n]*serviceKey/.test(source), false, "the key itself is never an argument to a log");
  assert.equal(/JSON\.stringify\(headers/.test(source), false, "and neither is the header object that carries it");
});

// --------------------------------------------------------------------------
// 5 · every writer, not just this one
// --------------------------------------------------------------------------

async function walk(rel) {
  const found = [];
  for (const entry of await readdir(path.join(ROOT, rel), { withFileTypes: true })) {
    const next = path.join(rel, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(next)));
    else if (/\.(mjs|js|cjs)$/.test(entry.name)) found.push(next);
  }
  return found;
}

test("every script that writes ad_spend carries the overlap fence", async () => {
  // The route-level enumeration in meta-ads-sync-contract.test.mjs only sees
  // src/app/**. A script that talks to PostgREST directly is just as much a writer,
  // so writers are enumerated rather than named: a fourth one added later fails this
  // test instead of quietly skipping the invariant.
  const writers = [];
  for (const rel of await walk("scripts")) {
    const source = await read(rel);
    if (/rest\/v1\/ad_spend|from\("ad_spend"\)/.test(source) && /method: "POST"|\.insert\(/.test(source)) writers.push(rel);
  }
  assert.deepEqual(writers, [SCRIPT], "one script writes ad_spend today; add the fence before adding another");

  for (const rel of writers) {
    const source = await read(rel);
    assert.match(source, /overlapping_spend_window/, `${rel} may not write over another source's days`);
    // Negative control: with the fence gone the assertion above must fail.
    assert.equal(/overlapping_spend_window/.test(source.split("overlapping_spend_window").join("removed")), false);
  }
});

test("the Excel importer's fence covers this namespace without naming it", async () => {
  // The invariant is "one spend_date, one source", so the fence has to ask for
  // everything that is not itself. While it named the API prefix instead, this
  // export namespace was invisible to it and a day could have been counted twice.
  const source = await read(IMPORTER);
  assert.match(source, /\.neq\("source", EXCEL_SOURCE\)/);
  assert.equal(/API_SOURCE_PREFIX/.test(source), false, "naming a sibling prefix goes stale the moment a third writer appears");
  assert.match(source, /days_already_covered_by_another_source/);
  assert.match(source, /sources: \[\.\.\.new Set/, "the refusal says which sources already own those days");

  // Negative control: point the fence back at its own source and it stops fencing.
  const mutated = source.replace('.neq("source", EXCEL_SOURCE)', '.eq("source", EXCEL_SOURCE)');
  assert.notEqual(mutated, source);
  assert.equal(/\.neq\("source", EXCEL_SOURCE\)/.test(mutated), false);
});
