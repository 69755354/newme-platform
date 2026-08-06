import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(path, "utf8");

test("SAM-82 staging UAT is exact-SHA, staging-only and release-bound", async () => {
  const [runner, controller, shell] = await Promise.all([
    read("scripts/uat/v4-staging-acceptance.mjs"),
    read("scripts/newme-staging-control.sh"),
    read("infra/staging/uat-runner/run.sh"),
  ]);
  for (const token of [
    'export const SCENARIOS = ["SAM-80", "SAM-81", "SAM-82", "SAM-83", "SAM-84", "SAM-86"];',
    'V4_STAGING_ACCEPTANCE_ONLY', 'PRODUCTION_REF', 'base_url_not_loopback',
    'manifest_sha_mismatch', 'results["SAM-82"] = await sam82(state)',
  ]) assert.ok(runner.includes(token), `missing ${token}`);
  for (const token of [
    'uat-v4) run_uat_v4', 'V4_UAT_RELEASE_SHA=$SHA',
    'body.scenarios?.["SAM-82"]?.topology !== "verified"',
    'body.scenarios?.["SAM-82"]?.rls_acl !== "verified"',
  ]) assert.ok(controller.includes(token), `missing ${token}`);
  assert.ok(shell.includes('v4-acceptance)'));
  assert.ok(shell.includes('exec node /runner/v4-staging-acceptance.mjs'));
});

test("SAM-82 runner validates deterministic retail facts and denies unsafe paths", async () => {
  const runner = await read("scripts/uat/v4-staging-acceptance.mjs");
  for (const token of [
    'retail_locations', 'retail_skus', 'retail_price_books',
    'retail_price_book_items', 'retail_inventory_movements',
    'retail_inventory_balances', 'retail_effective_prices',
    'sam82_duplicate_idempotency_allowed', 'sam82_mutable_ledger_allowed',
    'sam82_zero_price_allowed', 'sam82_excessive_discount_allowed',
    'sam82_sales_inventory_write_allowed', 'sam82_cross_organization_read_allowed',
    'sam82_cross_organization_catalog_write_allowed',
  ]) assert.ok(runner.includes(token), `missing ${token}`);
});

test("SAM-83 fixture keys cannot collide with the preceding SAM-82 fixture", async () => {
  const runner = await read("scripts/uat/v4-staging-acceptance.mjs");
  assert.match(runner, /\$\{state\.marker\}-sam83-wh/);
  assert.match(runner, /\$\{state\.marker\}-sam83-sku/);
});

test("SAM-82 cleanup remains exact-ID and ordered below append-only facts", async () => {
  const runner = await read("scripts/uat/v4-staging-acceptance.mjs");
  const cleanup = runner.slice(runner.indexOf("async function cleanup"));
  const discovery = runner.slice(runner.indexOf("async function collectRetailInventoryCleanup"), runner.indexOf("async function sam86"));
  assert.match(discovery, /\.from\("retail_inventory_movements"\)\.select\("id"\)/);
  assert.match(discovery, /\.in\("organization_id", organizationIds\)\.in\("sku_id", skuIds\)/);
  assert.match(discovery, /cleanup_retail_inventory_discovery_failed/);
  assert.ok(cleanup.indexOf("await collectRetailInventoryCleanup(state)") < cleanup.indexOf('"retail_inventory_movements"'));
  for (const token of [
    '["retail_inventory_movements", i.inventoryMovements, "inventory_movements"]',
    '["retail_price_book_items", i.priceBookItems, "price_book_items"]',
    '["retail_price_books", i.priceBooks, "price_books"]',
    '["retail_skus", i.skus, "skus"]',
    '["retail_locations", i.locations, "locations"]',
  ]) assert.ok(cleanup.includes(token), `missing ${token}`);
  assert.ok(cleanup.indexOf('"retail_inventory_movements"') < cleanup.indexOf('"retail_price_book_items"'));
  assert.ok(cleanup.indexOf('"retail_price_book_items"') < cleanup.indexOf('"retail_price_books"'));
  assert.ok(cleanup.indexOf('"retail_price_books"') < cleanup.indexOf('"retail_skus"'));
  assert.ok(cleanup.indexOf('"retail_skus"') < cleanup.indexOf('"retail_locations"'));
  assert.doesNotMatch(cleanup, /truncate|delete\(\)\.neq/i);
});
