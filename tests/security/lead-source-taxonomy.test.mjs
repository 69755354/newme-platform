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


test("historical Meta Ads migration changes only the canonical legacy value", async () => {
  const migration = await read("supabase/migrations/20260712000001_replace_meta_ads_source.sql").catch(() => "");
  assert.match(migration, /UPDATE public\.leads\s+SET source = 'ins'\s+WHERE source = 'meta_ads';/s);
});

test("source migration expands the constraint before rewriting Meta Ads", async () => {
  const migration = await read("supabase/migrations/20260712000001_replace_meta_ads_source.sql");
  const constraint = migration.indexOf("ADD CONSTRAINT leads_source_check");
  const rewrite = migration.indexOf("UPDATE public.leads");

  assert.notEqual(constraint, -1, "migration must replace leads_source_check");
  assert.ok(constraint < rewrite, "constraint must be expanded before the source rewrite");
  for (const source of ["ins", "fb", "show_room", "unknown"]) {
    assert.ok(migration.includes(`'${source}'`), `constraint must allow ${source}`);
  }
});


test("new Lead form uses Tanya's canonical source values", async () => {
  const source = await read("src/app/(dashboard)/leads/new/page.tsx");
  assert.equal(source.includes('value="meta_ads"'), false);
  for (const value of ["ins", "fb", "show_room"]) {
    assert.ok(source.includes(`value="${value}"`), `new Lead form missing source: ${value}`);
  }
});

test("all user-facing ins labels stay canonical", async () => {
  const translations = await read("src/lib/i18n/translations.ts");
  assert.equal((translations.match(/ins: "ins"/g) ?? []).length, 2);
  const dashboard = await read("src/app/(dashboard)/dashboard/page.tsx");
  assert.match(dashboard, /ins: t\("sourceLabels\.ins"\)/);
});
