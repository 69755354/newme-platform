#!/usr/bin/env node
// Import an Ads Manager CSV export into ad_spend.
//
// The Marketing API path (/api/meta/ads-sync) needs a token this business
// portfolio has not been able to issue. This is the path that works without one:
// export the ad table from Ads Manager, run this. Same invariant as the API path —
// one spend_date belongs to one source — and the same order of operations: parse
// everything, refuse on any rejected row, prove the window is not already owned by
// another source, replace the window inside this account's own namespace, then read
// it back and report a short count instead of accepting it.
//
// Usage
//   node scripts/import-ads-manager-export.mjs --file <export.csv> --account <id> [--parse-only] [--apply]
//
//   default      parse, then run the read-only overlap probe. Writes nothing.
//   --parse-only parse and report. No database access at all.
//   --apply      do the write.
//
// How to take the export so this accepts it (Ads Manager):
//   1. Ad level (the Ads tab), not Campaigns and not Ad sets.
//   2. Breakdown -> By Day. Without it every row covers the whole date range and
//      there is no per-day number to store; this refuses the file by name.
//   3. Reports -> Export table data -> Export as .csv.
//
// Environment
//   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
// Neither is ever printed, including inside error text.

import { readFile } from "node:fs/promises";
import { mapExportRows } from "../src/lib/meta-ads-export.mjs";

const BATCH = 500;

function parseArgv(argv) {
  const options = { file: "", account: "", apply: false, parseOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--file") options.file = argv[++i] ?? "";
    else if (token === "--account") options.account = argv[++i] ?? "";
    else if (token === "--apply") options.apply = true;
    else if (token === "--parse-only") options.parseOnly = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else return { ...options, error: `unknown_argument:${token}` };
  }
  return options;
}

function fail(code, payload) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(code);
}

// Any string that reaches a log goes through here. A service role key in a terminal
// scrollback is a published credential.
function redact(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}

async function main() {
  const options = parseArgv(process.argv);
  if (options.error) fail(2, { error: options.error });
  if (options.help) {
    console.log("node scripts/import-ads-manager-export.mjs --file <export.csv> --account <ad_account_id> [--parse-only] [--apply]");
    process.exit(0);
  }
  if (!options.file || !options.account) fail(2, { error: "file_and_account_are_required" });
  if (options.apply && options.parseOnly) fail(2, { error: "parse_only_and_apply_are_mutually_exclusive" });

  let csv;
  try {
    csv = await readFile(options.file, "utf8");
  } catch (error) {
    fail(2, { error: "csv_unreadable", detail: String(error?.message ?? error) });
  }

  let parsed;
  try {
    parsed = mapExportRows(csv, { accountId: options.account });
  } catch (error) {
    fail(2, { error: String(error?.message ?? error) });
  }
  const namespace = parsed.source;
  const report = {
    namespace,
    file: options.file,
    currency: parsed.currency || null,
    mappable: parsed.rows.length,
    rejected: parsed.rejected.length,
    skipped: parsed.skipped.length,
    duplicates_collapsed: parsed.duplicates,
    window: parsed.window,
  };

  // Fail closed before touching the database. A partly understood export is not a
  // smaller import, it is a wrong number that nobody can later separate out.
  if (parsed.rejected.length > 0) {
    const reasons = {};
    for (const entry of parsed.rejected) reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
    fail(3, {
      ...report,
      error: parsed.error ?? "export_rows_rejected",
      reasons,
      first_rejected: parsed.rejected.slice(0, 5),
      next: parsed.next ?? "fix_or_re_export_those_lines_then_re_run",
    });
  }
  if (parsed.rows.length === 0) fail(4, { ...report, error: "no_spend_rows_in_export" });

  if (options.parseOnly) {
    console.log(JSON.stringify({ ...report, mode: "parse-only", wrote: false }, null, 2));
    return;
  }

  const baseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!baseUrl || !serviceKey) fail(5, { ...report, error: "supabase_url_and_service_role_key_required" });
  const secrets = [serviceKey];
  const rest = `${baseUrl}/rest/v1/ad_spend`;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
  const { since, until } = parsed.window;
  const windowFilter = `spend_date=gte.${since}&spend_date=lte.${until}`;

  const request = async (url, init) => {
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      return { ok: false, status: 0, detail: redact(error?.message ?? error, secrets) };
    }
    const body = await response.text();
    return { ok: response.ok, status: response.status, body: redact(body, secrets), headers: response.headers };
  };

  // Fence 1: does any other source already describe a day in this window? The probe
  // looks outside this namespace on purpose — a re-run of this importer must be
  // allowed to replace its own rows, and anything else must not be silently added
  // to. A failed probe is not an absent conflict, so it stops the run.
  const probe = await request(`${rest}?select=spend_date,source&source=neq.${encodeURIComponent(namespace)}&${windowFilter}`, {
    method: "GET",
    headers,
  });
  if (!probe.ok) fail(5, { ...report, error: "overlap_probe_failed", status: probe.status, detail: probe.body?.slice(0, 400) });
  let owned = [];
  try {
    owned = JSON.parse(probe.body);
  } catch {
    fail(5, { ...report, error: "overlap_probe_unreadable" });
  }
  if (Array.isArray(owned) && owned.length > 0) {
    const days = [...new Set(owned.map((row) => String(row.spend_date).slice(0, 10)))].sort();
    const sources = [...new Set(owned.map((row) => String(row.source)))].sort();
    fail(6, {
      ...report,
      error: "overlapping_spend_window",
      days: days.slice(0, 20),
      day_count: days.length,
      sources,
      next: "retire_or_re_source_the_overlapping_rows_before_importing_this_window",
    });
  }

  if (!options.apply) {
    console.log(JSON.stringify({ ...report, mode: "dry-run", overlap: "none", wrote: false, next: "re_run_with_--apply" }, null, 2));
    return;
  }

  // Replace, scoped to this account's namespace and this window. Without the source
  // filter this would delete the Excel history and the API rows as well.
  const cleared = await request(`${rest}?source=eq.${encodeURIComponent(namespace)}&${windowFilter}`, {
    method: "DELETE",
    headers: { ...headers, Prefer: "count=exact,return=minimal" },
  });
  if (!cleared.ok) fail(7, { ...report, error: "window_clear_failed", status: cleared.status, detail: cleared.body?.slice(0, 400) });
  const deleted = Number((cleared.headers?.get?.("content-range") || "*/0").split("/")[1] || 0);

  let inserted = 0;
  for (let offset = 0; offset < parsed.rows.length; offset += BATCH) {
    const batch = parsed.rows.slice(offset, offset + BATCH);
    const written = await request(rest, {
      method: "POST",
      headers: { ...headers, Prefer: "return=minimal,count=exact" },
      body: JSON.stringify(batch),
    });
    if (!written.ok) {
      fail(7, {
        ...report,
        error: "insert_failed",
        status: written.status,
        offset,
        deleted,
        inserted,
        detail: written.body?.slice(0, 400),
        next: "re_run_this_window_alone",
      });
    }
    inserted += batch.length;
  }

  // Read the window back. An insert that reports success and a window that holds a
  // different number of rows is the only way this can double count, so it is
  // reported as a failure rather than trusted.
  const verify = await request(`${rest}?select=id&source=eq.${encodeURIComponent(namespace)}&${windowFilter}`, {
    method: "HEAD",
    headers: { ...headers, Prefer: "count=exact" },
  });
  if (!verify.ok) fail(8, { ...report, error: "window_verify_failed", status: verify.status, deleted, inserted });
  const present = Number((verify.headers?.get?.("content-range") || "*/0").split("/")[1] || 0);
  if (present !== parsed.rows.length) {
    fail(8, {
      ...report,
      error: "window_row_count_mismatch",
      expected: parsed.rows.length,
      present,
      deleted,
      inserted,
      next: "re_run_this_window_alone",
    });
  }

  console.log(JSON.stringify({ ...report, mode: "apply", deleted, inserted, present, ok: true }, null, 2));
}

await main();
