import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationPath = resolve(root, "supabase/migrations/20260805130000_sam83_retail_order_procurement_fulfillment_finance.sql");
const rollbackPath = resolve(root, "supabase/rollback/20260805130000_sam83_retail_order_procurement_fulfillment_finance_rollback.sql");
const databaseTypesPath = resolve(root, "src/types/database.ts");
const read = (path) => readFile(path, "utf8");

test("SAM-83 makes quotation conversion organization-scoped and exactly once", async () => {
  const sql = await read(migrationPath);
  for (const token of [
    "CREATE TABLE public.retail_orders",
    "REFERENCES public.quotations(organization_id, id)",
    "retail_orders_organization_quotation_unique UNIQUE (organization_id, source_quotation_id)",
    "CREATE TABLE public.retail_order_items",
    "retail_orders_transition",
    "retail_inventory_movements",
  ]) assert.ok(sql.includes(token), `missing ${token}`);
});

test("SAM-83 posts receiving inventory and separates COD collection from finance confirmation", async () => {
  const sql = await read(migrationPath);
  for (const token of [
    "CREATE TABLE public.retail_purchase_orders",
    "CREATE TABLE public.retail_goods_receipts",
    "retail_goods_receipts_organization_idempotency_unique",
    "CREATE TABLE public.retail_delivery_handoffs",
    "CREATE TABLE public.retail_cod_events",
    "event_type IN ('cash_collected', 'cash_handover', 'finance_confirmed')",
    "retail_cod_requires_completed_handoff",
    "retail_cod_handover_requires_separate_collection",
    "retail_finance_confirmation_requires_separate_handover",
    "CREATE TABLE public.retail_finance_allocations",
    "retail_finance_allocations_organization_idempotency_unique",
  ]) assert.ok(sql.includes(token), `missing ${token}`);
});

test("SAM-83 requires finance allocations to reconcile before completion", async () => {
  const sql = await read(migrationPath);
  for (const token of [
    "CREATE TABLE public.retail_finance_reconciliations",
    "CREATE OR REPLACE FUNCTION public.retail_sam83_validate_finance_allocation()",
    "CREATE OR REPLACE FUNCTION public.retail_sam83_validate_reconciliation()",
    "retail_reconciliation_difference_requires_exception",
    "CREATE VIEW public.retail_order_finance_summary WITH (security_invoker = true)",
  ]) assert.ok(sql.includes(token), `missing ${token}`);
});

test("SAM-83 is capability-gated and does not grant retail data to public roles", async () => {
  const sql = await read(migrationPath);
  assert.match(sql, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /ALTER TABLE public\.%I FORCE ROW LEVEL SECURITY/);
  for (const capability of [
    "retail.orders.read", "retail.orders.write", "retail.procurement.read", "retail.procurement.write",
    "retail.delivery.read", "retail.delivery.write", "retail.finance.read", "retail.finance.write",
  ]) assert.ok(sql.includes(`'${capability}'`), `capability missing: ${capability}`);
  assert.doesNotMatch(sql, /GRANT ALL ON TABLE public\.retail_[a-z_]+ TO authenticated/);
});

test("SAM-83 rollback is staging-test-only and removes no objects with cascade", async () => {
  const sql = await read(rollbackPath);
  assert.match(sql, /sam83_rollback_requires_staging_or_test/);
  assert.match(sql, /COALESCE\(environment_name, ''\) NOT IN \('staging', 'test'\)/);
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|VIEW|FUNCTION)[^;]*\bCASCADE\b/i);
  for (const token of [
    "DROP VIEW IF EXISTS public.retail_order_finance_summary",
    "DROP TABLE IF EXISTS public.retail_finance_reconciliations",
    "DROP TABLE IF EXISTS public.retail_finance_allocations",
    "DROP TABLE IF EXISTS public.retail_cod_events",
    "DROP TABLE IF EXISTS public.retail_delivery_handoffs",
    "DROP TABLE IF EXISTS public.retail_goods_receipt_items",
    "DROP TABLE IF EXISTS public.retail_goods_receipts",
    "DROP TABLE IF EXISTS public.retail_purchase_order_items",
    "DROP TABLE IF EXISTS public.retail_purchase_orders",
    "DROP TABLE IF EXISTS public.retail_order_items",
    "DROP TABLE IF EXISTS public.retail_orders",
  ]) assert.ok(sql.includes(token), `rollback missing ${token}`);
});

test("SAM-83 exposes order, receiving, handoff and finance records to TypeScript", async () => {
  const types = await read(databaseTypesPath);
  for (const token of [
    "retail_orders: {", "retail_order_items: {", "retail_purchase_orders: {", "retail_purchase_order_items: {",
    "retail_goods_receipts: {", "retail_goods_receipt_items: {", "retail_delivery_handoffs: {", "retail_cod_events: {",
    "retail_finance_allocations: {", "retail_finance_reconciliations: {", "retail_order_finance_summary: {",
  ]) assert.ok(types.includes(token), `database type missing ${token}`);
});
