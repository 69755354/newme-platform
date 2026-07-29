#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function valueAfter(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const root = process.cwd();
const manifestPath = path.resolve(
  root,
  valueAfter(
    "--manifest",
    "supabase/security/authenticated-security-definer-rpc-allowlist.json",
  ),
);
const sqlPath = path.resolve(
  root,
  valueAfter(
    "--sql",
    "supabase/security/check-authenticated-security-definer-rpc-allowlist.sql",
  ),
);

const failures = [];
const fail = (message) => failures.push(message);

let manifest;
let sql;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  sql = fs.readFileSync(sqlPath, "utf8");
} catch (error) {
  console.error(`SECURITY DEFINER RPC allowlist gate failed: ${error.message}`);
  process.exit(1);
}

if (manifest.schema_version !== 2) {
  fail("schema_version must be 2");
}
if (manifest.required_search_path !== "pg_catalog, public, pg_temp") {
  fail("required_search_path must be the reviewed fixed search path");
}
if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
  fail("entries must be a non-empty array");
}

const manifestSignatures = [];
const today = new Date().toISOString().slice(0, 10);
const exactDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const linkedIssuePattern = /^SAM-[1-9]\d*$/;
const ownerPattern = /^[a-z][a-z0-9-]{2,63}$/;

function isExactCalendarDate(value) {
  if (typeof value !== "string" || !exactDatePattern.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value;
}

for (const [index, entry] of (manifest.entries ?? []).entries()) {
  const label = `entries[${index}]`;
  if (typeof entry.regprocedure !== "string" || !entry.regprocedure) {
    fail(`${label}.regprocedure is required`);
    continue;
  }
  manifestSignatures.push(entry.regprocedure);
  if (typeof entry.owner !== "string" || !ownerPattern.test(entry.owner)) {
    fail(`${label}.owner must be a stable lowercase owner slug`);
  }
  for (const field of ["justification", "authorization_boundary"]) {
    if (typeof entry[field] !== "string" || entry[field].trim().length < 20) {
      fail(`${label}.${field} must contain a substantive review`);
    }
  }
  if (!isExactCalendarDate(entry.expiry)) {
    fail(`${label}.expiry must be an exact YYYY-MM-DD calendar date`);
  } else if (entry.expiry <= today) {
    fail(`${label}.expiry ${entry.expiry} is expired as of ${today}`);
  }
  if (
    typeof entry.linked_issue !== "string"
    || !linkedIssuePattern.test(entry.linked_issue)
  ) {
    fail(`${label}.linked_issue must be a valid SAM-N Linear issue key`);
  }
  if (!Array.isArray(entry.test_evidence) || entry.test_evidence.length === 0) {
    fail(`${label}.test_evidence must name at least one test`);
  } else {
    for (const evidence of entry.test_evidence) {
      if (!fs.existsSync(path.resolve(root, evidence))) {
        fail(`${label}.test_evidence does not exist: ${evidence}`);
      }
    }
  }
}

if (new Set(manifestSignatures).size !== manifestSignatures.length) {
  fail("manifest contains duplicate regprocedure entries");
}
if ([...manifestSignatures].sort().join("\n") !== manifestSignatures.join("\n")) {
  fail("manifest regprocedure entries must be sorted");
}

const begin = "-- BEGIN AUTHENTICATED_SECURITY_DEFINER_ALLOWLIST";
const end = "-- END AUTHENTICATED_SECURITY_DEFINER_ALLOWLIST";
const startIndex = sql.indexOf(begin);
const endIndex = sql.indexOf(end);
if (startIndex < 0 || endIndex <= startIndex) {
  fail("SQL allowlist markers are missing or out of order");
}
const sqlAllowlist =
  startIndex >= 0 && endIndex > startIndex
    ? [...sql.slice(startIndex + begin.length, endIndex).matchAll(/\('([^']+)'\)/g)].map(
        (match) => match[1],
      )
    : [];

if (new Set(sqlAllowlist).size !== sqlAllowlist.length) {
  fail("SQL gate contains duplicate regprocedure entries");
}
if ([...sqlAllowlist].sort().join("\n") !== sqlAllowlist.join("\n")) {
  fail("SQL regprocedure entries must be sorted");
}
if (manifestSignatures.join("\n") !== sqlAllowlist.join("\n")) {
  fail("manifest and live SQL gate allowlists differ");
}

for (const requiredToken of [
  "unexpected_authenticated",
  "missing_expected",
  "anon_execute",
  "unsafe_search_path",
  "p.prosecdef",
  "has_function_privilege('anon'",
  "has_function_privilege('authenticated'",
  "search_path=pg_catalog, public, pg_temp",
]) {
  if (!sql.includes(requiredToken)) {
    fail(`SQL live gate is missing required check: ${requiredToken}`);
  }
}

if (failures.length > 0) {
  for (const message of failures) {
    console.error(`FAIL ${message}`);
  }
  console.error(
    `SECURITY DEFINER RPC allowlist gate failed with ${failures.length} finding(s).`,
  );
  process.exit(1);
}

console.log(
  `SECURITY DEFINER RPC allowlist gate passed: ${manifestSignatures.length} reviewed authenticated RPCs.`,
);
