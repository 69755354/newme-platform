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


test("all source selectors and analytics use canonical source values", async () => {
  for (const path of [
    "src/app/(dashboard)/leads/new/page.tsx",
    "src/components/QuickCreateLeadDialog.tsx",
    "src/app/(dashboard)/leads/_utils/constants.ts",
    "src/app/(dashboard)/dashboard/page.tsx",
  ]) {
    const source = await read(path);
    assert.equal(source.includes('"meta_ads"'), false, `legacy source remains in ${path}`);
  }

  const ads = await read("src/app/api/dashboard/ads-roi/route.ts");
  assert.match(ads, /\.in\("source", \["ins", "fb"\]\)/);
  const analytics = await read("src/app/api/analytics/summary/route.ts");
  assert.match(analytics, /\["ins", "fb"\]\.includes\(l\.source\)/);
  const webhook = await read("src/app/api/leads/meta-capi/route.ts");
  assert.doesNotMatch(webhook, /source = "meta_ads"|source = "instagram"/);
});

test("database rejects new legacy source values after normalization", async () => {
  const migration = await read("supabase/migrations/20260714000001_normalize_lead_sources.sql");
  assert.match(migration, /WHERE source IN \('meta_ads', 'instagram'\)/);
  const constraint = migration.slice(migration.indexOf("ADD CONSTRAINT leads_source_check"));
  assert.doesNotMatch(constraint, /'meta_ads'|'instagram'/);
});


test("legacy Meta import aliases normalize to ins", async () => {
  for (const path of [
    "src/app/api/leads/import/preview/route.ts",
    "src/app/api/leads/import/confirm/route.ts",
  ]) {
    const source = await read(path);
    for (const alias of ["meta_ads", "meta ads", "meta"]) {
      assert.ok(source.includes(`"${alias}"`), `${path} missing legacy alias: ${alias}`);
    }
  }
});

test("unknown Meta webhook input preserves an existing Lead source", async () => {
  const source = await read("src/app/api/leads/meta-capi/route.ts");
  assert.match(source, /\.\.\.\(source !== "unknown" \? \{ source \} : \{\}\)/);
});

test("translations contain no visible Meta Ads label", async () => {
  const translations = await read("src/lib/i18n/translations.ts");
  assert.equal(translations.includes('sourceMetaAds: "Meta Ads"'), false);
  assert.equal(translations.includes('meta: "Meta Ads"'), false);
  assert.equal(translations.includes('meta: "Meta 广告"'), false);
});
