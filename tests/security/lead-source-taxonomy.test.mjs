import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("Lead Detail offers Tanya's canonical source values", async () => {
  const source = await read("src/app/(dashboard)/leads/[id]/LeadCustomerProfile.tsx");
  assert.equal(source.includes('"meta_ads"'), false);
  for (const value of ["ins", "fb", "show_room"]) {
    assert.ok(source.includes(`"${value}"`), `missing selectable source: ${value}`);
  }
});

test("import preview and confirmation normalize Instagram, Facebook, and Show room", async () => {
  for (const path of [
    "src/app/api/leads/import/preview/route.ts",
    "src/app/api/leads/import/confirm/route.ts",
  ]) {
    const source = await read(path);
    for (const token of [
      'return "ins"',
      'return "fb"',
      'return "show_room"',
    ]) assert.ok(source.includes(token), `${path} missing canonical mapping: ${token}`);
  }
});
