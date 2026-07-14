import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("preview accepts current and legacy CRM workbook headers", async () => {
  const source = await read("src/app/api/leads/import/preview/route.ts");
  for (const header of [
    '"client name": "customer_name"',
    '"customer name": "customer_name"',
    '"contact number": "phone"',
    '"phone number": "phone"',
    '"ledes from": "source"',
    '"leads from": "source"',
    '"lead source": "source"',
    '"emirate/location": "location"',
  ]) assert.ok(source.includes(header), `missing workbook header: ${header}`);
});

test("confirm revalidates original workbook values instead of normalized labels", async () => {
  const source = await read("src/app/api/leads/import/confirm/route.ts");
  assert.ok(source.includes("rawImportData.raw_quality ?? row.quality"));
  assert.ok(source.includes("rawImportData.raw_source ?? row.source"));
  assert.ok(source.includes("mapQuality(String(rawQuality ??"));
  assert.equal(source.includes("mapQuality(String(row.quality ??"), false);
});

test("country stays in raw import data until the leads schema supports it", async () => {
  const preview = await read("src/app/api/leads/import/preview/route.ts");
  const confirm = await read("src/app/api/leads/import/confirm/route.ts");
  assert.ok(preview.includes("raw_country: norm.country ||"));
  assert.equal(confirm.includes("country: row.country"), false);
});

test("first contact date stays in raw import data until the leads schema supports it", async () => {
  const preview = await read("src/app/api/leads/import/preview/route.ts");
  const confirm = await read("src/app/api/leads/import/confirm/route.ts");
  assert.ok(preview.includes("raw_first_contact_date: firstContact ||"));
  assert.equal(confirm.includes("\n        first_contact_date: row.first_contact_date"), false);
});
