import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationPath = resolve(
  root,
  "supabase/migrations/20260805120000_sam82_retail_catalog_inventory_pricing.sql",
);
const rollbackPath = resolve(
  root,
  "supabase/rollback/20260805120000_sam82_retail_catalog_inventory_pricing_rollback.sql",
);
const databaseTypesPath = resolve(root, "src/types/database.ts");

async function read(path) {
  return readFile(path, "utf8");
}

test("SAM-82 creates an organization-scoped retail topology and SKU resolver", async () => {
  const sql = await read(migrationPath);
  for (const token of [
    "CREATE TABLE public.retail_locations",
    "CREATE TABLE public.retail_skus",
    "REFERENCES public.organizations(id) ON DELETE RESTRICT",
    "retail_locations_organization_id_id_unique",
    "retail_skus_organization_id_id_unique",
    "retail_skus_organization_product_fkey",
    "REFERENCES public.products(organization_id, id)",
    "retail_locations_organization_code_lower_key",
    "retail_skus_organization_sku_lower_key",
    "retail_skus_organization_barcode_lower_key",
    "jsonb_typeof(variant_attributes) = 'object'",
  ]) {
    assert.match(sql, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("SAM-82 inventory is append-only, scoped, idempotent and derives balances", async () => {
  const sql = await read(migrationPath);
  for (const token of [
    "CREATE TABLE public.retail_inventory_movements",
    "retail_inventory_movements_organization_location_fkey",
    "retail_inventory_movements_organization_sku_fkey",
    "retail_inventory_movements_organization_sku_fkey",
    "retail_inventory_movements_some_delta_check",
    "retail_inventory_movements_no_nan_check",
    "CREATE OR REPLACE FUNCTION public.retail_reject_mutable_ledger()",
    "retail_inventory_movement_is_append_only",
    "BEFORE UPDATE OR DELETE ON public.retail_inventory_movements",
    "CREATE VIEW public.retail_inventory_balances",
    "WITH (security_invoker = true)",
    "sum(on_hand_delta - reserved_delta - blocked_delta - damaged_delta) AS available",
  ]) {
    assert.ok(sql.includes(token), `missing ${token}`);
  }
  assert.doesNotMatch(sql, /DROP TABLE[^;]*retail_inventory_movements[^;]*CASCADE/i);
});

test("SAM-82 prices are positive, tenant-scoped and deterministically resolved", async () => {
  const sql = await read(migrationPath);
  for (const token of [
    "CREATE TABLE public.retail_price_books",
    "CREATE TABLE public.retail_price_book_items",
    "unit_price > 0",
    "max_discount_percent >= 0 AND max_discount_percent <= 100",
    "retail_price_book_items_effective_window_check",
    "retail_price_book_items_revision_unique",
    "CREATE VIEW public.retail_effective_prices",
    "ORDER BY item.effective_from DESC, item.id DESC",
    "WHERE price_revision = 1",
  ]) {
    assert.ok(sql.includes(token), `missing ${token}`);
  }
});

test("SAM-82 grants no public retail access and gates authenticated rows by capabilities", async () => {
  const sql = await read(migrationPath);
  assert.match(sql, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /ALTER TABLE public\.%I FORCE ROW LEVEL SECURITY/);
  for (const capability of [
    "retail.locations.read", "retail.locations.write",
    "retail.catalog.read", "retail.catalog.write",
    "retail.inventory.read", "retail.inventory.write",
    "retail.pricing.read", "retail.pricing.write",
  ]) {
    assert.ok(sql.includes(`'${capability}'`), `capability missing: ${capability}`);
  }
  assert.match(sql, /public\.v4_actor_has_capability\(organization_id, auth\.uid\(\), 'retail\.inventory\.write', 'write'\)/);
  assert.doesNotMatch(sql, /GRANT ALL ON TABLE public\.retail_[a-z_]+ TO authenticated/);
});

test("SAM-82 rollback fails closed outside staging or test and never cascades", async () => {
  const sql = await read(rollbackPath);
  assert.match(sql, /sam82_rollback_requires_staging_or_test/);
  assert.match(sql, /COALESCE\(environment_name, ''\) NOT IN \('staging', 'test'\)/);
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|VIEW|FUNCTION)[^;]*\bCASCADE\b/i);
  for (const token of [
    "DROP VIEW IF EXISTS public.retail_effective_prices",
    "DROP VIEW IF EXISTS public.retail_inventory_balances",
    "DROP TABLE IF EXISTS public.retail_price_book_items",
    "DROP TABLE IF EXISTS public.retail_price_books",
    "DROP TABLE IF EXISTS public.retail_inventory_movements",
    "DROP TABLE IF EXISTS public.retail_skus",
    "DROP TABLE IF EXISTS public.retail_locations",
  ]) {
    assert.ok(sql.includes(token), `rollback missing ${token}`);
  }
});

test("SAM-82 exposes its committed tables and derived views to TypeScript", async () => {
  const types = await read(databaseTypesPath);
  for (const token of [
    "retail_locations: {",
    "retail_skus: {",
    "retail_inventory_movements: {",
    "retail_price_books: {",
    "retail_price_book_items: {",
    "retail_inventory_balances: {",
    "retail_effective_prices: {",
    "retail_inventory_movements_organization_sku_fkey",
  ]) {
    assert.ok(types.includes(token), `database type missing ${token}`);
  }
});
