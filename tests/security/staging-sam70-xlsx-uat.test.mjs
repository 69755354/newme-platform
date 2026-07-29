import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("SAM-70 runner refuses production and invalid staging boundaries before cleanup", async () => {
  const source = await read("scripts/verify-staging-sam70-xlsx.mjs");
  assert.match(source, /const STAGING_REF = "bfsiibofuzoglziltgyd"/);
  assert.match(source, /const PRODUCTION_REF = "vfopmpxlhwzpxqegayew"/);
  assert.match(source, /assert\.equal\(expectedRef, STAGING_REF\)/);
  assert.match(source, /assert\.equal\(baseUrl, "https:\/\/staging\.newme\.ae"\)/);
  assert.match(source, /assert\.equal\(releaseManifestPath, "\/runner\/release\/manifest\.json"\)/);
  assert.match(source, /assert\.equal\(confirmation, "SAM70_STAGING_ONLY"\)/);
  assert.match(source, /if \(boundariesValidated\) \{\s*try \{\s*await cleanupFixtures\(\)/);
  assert.doesNotMatch(source, /app\.newme\.ae/);
});

test("SAM-70 runner covers auth, normal import, idempotency, and exact evidence", async () => {
  const source = await read("scripts/verify-staging-sam70-xlsx.mjs");
  for (const token of [
    "unauthenticated import endpoints return 401",
    "non-management import endpoints return 403",
    "admin import succeeds with exact IDs and batch",
    "boss idempotent replay creates no duplicate",
    "initialBatchId = confirm.payload.batch_id",
    "idempotentBatchId = replay.payload.batch_id",
    "importedLeadIds.add(id)",
    "assert.equal(residue[0].id, [...importedLeadIds][0])",
    "assert.equal(residue[0].import_batch_id, initialBatchId)",
  ]) assert.ok(source.includes(token), `missing contract token: ${token}`);
  assert.match(source, /await createUser\("admin"\)/);
  assert.match(source, /await createUser\("boss"\)/);
  assert.match(source, /await createUser\("sales"\)/);
  assert.match(source, /expectStatus\(result, 401/);
  assert.match(source, /expectStatus\(forbidden, 403/);
});

test("SAM-70 runner covers XLSX and server abuse boundaries", async () => {
  const source = await read("scripts/verify-staging-sam70-xlsx.mjs");
  assert.match(source, /const MAX_XLSX_BYTES = 5 \* 1024 \* 1024/);
  assert.match(source, /const MAX_XLSX_ROWS = 2_000/);
  assert.match(source, /MAX_XLSX_BYTES \+ 1/);
  assert.match(source, /MAX_XLSX_ROWS \+ 1/);
  assert.match(source, /\["__proto__", "constructor", "prototype"\]/);
  for (const token of [
    "requests over 5 MiB fail closed",
    "2,001 rows fail closed",
    "prototype-pollution keys fail closed",
    "normal workbook reaches authenticated preview",
    "corrupt workbook is rejected before preview",
    "workbook over 5 MiB is rejected before preview",
  ]) assert.ok(source.includes(token), `missing abuse case: ${token}`);
  assert.match(source, /assert\.equal\(previewRequests, 0\)/);
});

test("SAM-70 runner verifies export ownership and removes exact marker residue", async () => {
  const source = await read("scripts/verify-staging-sam70-xlsx.mjs");
  assert.match(source, /quotation export enforces ownership and management access/);
  assert.match(source, /expectStatus\(unauthenticated, 401/);
  assert.match(source, /expectStatus\(forbidden, 403/);
  assert.match(source, /\["owner", owner\.token\]/);
  assert.match(source, /\["admin", admin\.token\]/);
  assert.match(source, /\["boss", boss\.token\]/);
  assert.match(source, /\/api\/quotations\/export\?id=/);
  assert.match(source, /delete dependent follow-up logs/);
  assert.match(source, /quote_no=eq\.\$\{encodeURIComponent\(marker\)\}/);
  assert.match(source, /customer_name=eq\.\$\{encodeURIComponent\(marker\)\}/);
  assert.match(source, /cleanup: cleanupError \? "failed" : "verified"/);
  for (const name of [
    "leads",
    "follow_up_logs",
    "quotations",
    "profiles",
    "auth_fixtures",
  ]) assert.ok(source.includes(`${name}:`));
});

test("SAM-70 report contains no credential fields", async () => {
  const source = await read("scripts/verify-staging-sam70-xlsx.mjs");
  const reportStart = source.indexOf("const report = {");
  const reportEnd = source.indexOf("console.log(JSON.stringify(report))");
  assert.ok(reportStart > 0 && reportEnd > reportStart);
  const report = source.slice(reportStart, reportEnd);
  assert.doesNotMatch(report, /\b(?:password|token|secretKey|publishableKey|email)\b/);
  assert.equal((source.match(/console\.log/g) ?? []).length, 2);
  assert.doesNotMatch(source, /console\.(?:debug|info|warn|error)/);
});
