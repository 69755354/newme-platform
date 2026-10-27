// Ads Manager CSV export -> ad_spend rows.
//
// Why this exists next to meta-ads-insights.mjs: the Marketing API path needs a
// token the business portfolio has never been able to issue, while any ad account
// can be exported from Ads Manager by hand today. This module is the parser for
// that export. It writes nothing; scripts/import-ads-manager-export.mjs owns the
// write and the fences.
//
// The one thing this module refuses to do is guess. An Ads Manager export whose
// reporting window is a range rather than a single day carries one row per ad for
// the whole range, and there is no honest way to turn that into ad_spend rows,
// which are per day. The twelve rows already in ad_spend are what that looks like
// when someone tries: 14,113.50 AED all stamped 2025-12-01. So a range export is
// rejected, by name, with the setting the operator has to change.

import { ACCOUNT_CURRENCY, isIsoDate, normaliseAccountId } from "./meta-ads-insights.mjs";

export const EXPORT_SOURCE = "meta_export";
export const EXPORT_SOURCE_PREFIX = `${EXPORT_SOURCE}:`;

// Same shape as apiSourceForAccount: the account number is part of the namespace,
// so re-pointing the importer at another ad account cannot delete the first
// account's rows, and no migration is needed because ad_spend.source is TEXT with
// no CHECK constraint.
export function exportSourceForAccount(accountId) {
  const account = normaliseAccountId(accountId);
  if (!account) throw new Error("invalid_ad_account_id");
  return `${EXPORT_SOURCE_PREFIX}${account.slice("act_".length)}`;
}

export function isExportSource(source) {
  return typeof source === "string" && source.startsWith(EXPORT_SOURCE_PREFIX);
}

// ── CSV ────────────────────────────────────────────────────────────────────────
// Ads Manager quotes any field containing a comma, quote, or newline, and ad names
// routinely contain all three (and RTL marks, and emoji). A split on "," loses
// those rows silently, which is worse than failing, so this is a real reader.
export function parseCsv(text) {
  if (typeof text !== "string") throw new Error("csv_text_required");
  const source = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  let sawField = false;

  const endField = () => {
    row.push(field);
    field = "";
    sawField = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < source.length) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && !sawField) {
      quoted = true;
      sawField = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    sawField = true;
    i += 1;
  }
  if (quoted) throw new Error("csv_unterminated_quote");
  if (field !== "" || row.length > 0) endRow();

  // Drop trailing blank lines, keep blank lines in the middle so line numbers in
  // the report match what the operator sees in a spreadsheet.
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell.trim() === "")) rows.pop();
  return rows;
}

const HEADER_ALIASES = {
  reporting_starts: [/^reporting starts$/],
  reporting_ends: [/^reporting ends$/],
  ad_name: [/^ad name$/],
  adset_name: [/^ad set name$/, /^adset name$/],
  campaign_name: [/^campaign name$/],
  impressions: [/^impressions$/],
  clicks: [/^link clicks$/, /^clicks \(all\)$/, /^clicks$/],
};

// Reach is deliberately absent above. The Excel parser that produced the twelve
// legacy rows matched "impressions|impression|reach" and therefore filed reach as
// impressions whenever the export had no impressions column; a wrong number that
// looks right is the failure mode this module exists to avoid.
export const REQUIRED_COLUMNS = ["reporting_starts", "reporting_ends", "ad_name"];

const AMOUNT_HEADER = /^amount spent(?:\s*\(\s*([a-z]{3})\s*\))?$/i;

export function detectColumns(header) {
  if (!Array.isArray(header)) return { ok: false, missing: [...REQUIRED_COLUMNS, "amount"], columns: {}, currency: "" };
  const cells = header.map((cell) => String(cell ?? "").replace(/\uFEFF/g, "").trim());
  const lower = cells.map((cell) => cell.toLowerCase());
  const columns = {};
  for (const [key, patterns] of Object.entries(HEADER_ALIASES)) {
    const index = lower.findIndex((cell) => patterns.some((pattern) => pattern.test(cell)));
    if (index >= 0) columns[key] = index;
  }

  // The currency is only ever stated in the header — "Amount spent (AED)" — and a
  // bare "Amount spent" means the export was taken in a way that does not say. An
  // unlabelled number is not assumed to be AED.
  let currency = "";
  const amountIndex = lower.findIndex((cell) => AMOUNT_HEADER.test(cell));
  if (amountIndex >= 0) {
    columns.amount = amountIndex;
    const match = cells[amountIndex].match(AMOUNT_HEADER);
    currency = (match?.[1] ?? "").toUpperCase();
  }

  const missing = [...REQUIRED_COLUMNS, "amount"].filter((key) => !(key in columns));
  return { ok: missing.length === 0, missing, columns, currency, header: cells };
}

function cell(row, index) {
  if (index === undefined || index < 0 || index >= row.length) return "";
  return String(row[index] ?? "").trim();
}

function toAmount(raw) {
  if (raw === "" || raw === "-") return null;
  const cleaned = raw.replace(/,/g, "").replace(/\s+/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return undefined; // undefined = unparseable
  return Math.round(Number(cleaned) * 100) / 100;
}

function toInteger(raw) {
  if (raw === "" || raw === "-") return null;
  const cleaned = raw.replace(/,/g, "").replace(/\s+/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  return Math.trunc(Number(cleaned));
}

// Two segments, and the separator is the \u0000 escape rather than a literal NUL
// byte: a literal one makes git treat this file as binary, which once destroyed a
// whole patch. Ad names repeat across ad sets, so the ad set is part of the key.
export function exportRowKey(row) {
  return [row.spend_date, row.adset_name ?? "", row.ad_name ?? ""].join("\u0000");
}

/**
 * Map an Ads Manager CSV export to ad_spend rows.
 *
 * Returns rejected (the run must stop) separately from skipped (nothing to write
 * for that line, and that is normal): a day an ad did not spend on carries no
 * money, so dropping it is not a loss, while a row whose date or currency cannot
 * be trusted must never be written.
 */
export function mapExportRows(csvText, { accountId } = {}) {
  const source = exportSourceForAccount(accountId);
  const table = parseCsv(csvText);
  if (table.length === 0) {
    return { ok: false, error: "csv_empty", source, rows: [], rejected: [], skipped: [], duplicates: 0 };
  }

  const detected = detectColumns(table[0]);
  if (!detected.ok) {
    return {
      ok: false,
      error: "missing_columns",
      missing: detected.missing,
      header: detected.header,
      next: "export_at_ad_level_with_the_default_columns",
      source,
      rows: [],
      rejected: [],
      skipped: [],
      duplicates: 0,
    };
  }

  const { columns, currency } = detected;
  const seen = new Map();
  let collapsed = 0;
  const rejected = [];
  const skipped = [];

  for (let index = 1; index < table.length; index += 1) {
    const raw = table[index];
    const line = index + 1; // 1-based, matching a spreadsheet
    if (raw.every((value) => String(value ?? "").trim() === "")) continue;

    const starts = cell(raw, columns.reporting_starts);
    const ends = cell(raw, columns.reporting_ends);
    if (!isIsoDate(starts) || !isIsoDate(ends)) {
      rejected.push({ line, reason: "unparseable_reporting_window" });
      continue;
    }
    if (starts !== ends) {
      // The row covers a range. Every ad in the file is one aggregate, so there is
      // nothing to salvage per day.
      rejected.push({ line, reason: "aggregate_window_not_daily", window: `${starts}..${ends}` });
      continue;
    }
    if (currency === "") {
      rejected.push({ line, reason: "missing_currency" });
      continue;
    }
    if (currency !== ACCOUNT_CURRENCY) {
      // Never converted. A rate belongs to a human decision, not to an importer.
      rejected.push({ line, reason: "wrong_currency", currency });
      continue;
    }

    const adName = cell(raw, columns.ad_name);
    if (adName === "") {
      rejected.push({ line, reason: "missing_ad_name" });
      continue;
    }

    const amount = toAmount(cell(raw, columns.amount));
    if (amount === undefined) {
      rejected.push({ line, reason: "unparseable_amount" });
      continue;
    }
    if (amount === null) {
      skipped.push({ line, reason: "no_spend_reported" });
      continue;
    }

    const row = {
      campaign_name: cell(raw, columns.campaign_name) || null,
      adset_name: cell(raw, columns.adset_name) || null,
      ad_name: adName,
      spend_date: starts,
      amount,
      currency: ACCOUNT_CURRENCY,
      impressions: toInteger(cell(raw, columns.impressions)),
      clicks: toInteger(cell(raw, columns.clicks)),
      source,
    };
    const key = exportRowKey(row);
    // Ads Manager can list the same ad twice for one day (an edit mid-day splits
    // the row). Last wins, and the collapse is reported rather than hidden.
    if (seen.has(key)) collapsed += 1;
    seen.set(key, row);
  }

  const rows = [...seen.values()].sort((a, b) =>
    a.spend_date === b.spend_date ? exportRowKey(a).localeCompare(exportRowKey(b)) : a.spend_date.localeCompare(b.spend_date),
  );
  const dates = rows.map((row) => row.spend_date).sort();
  const aggregate = rejected.some((entry) => entry.reason === "aggregate_window_not_daily");

  return {
    ok: rejected.length === 0 && rows.length > 0,
    source,
    currency,
    columns,
    rows,
    rejected,
    skipped,
    duplicates: collapsed,
    duplicates_collapsed: collapsed,
    window: rows.length > 0 ? { since: dates[0], until: dates[dates.length - 1] } : null,
    ...(aggregate
      ? { error: "aggregate_window_not_daily", next: "re_export_with_breakdown_by_day_so_each_row_is_one_day" }
      : {}),
  };
}
