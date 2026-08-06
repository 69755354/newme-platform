import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("SAM-78 cleanup matches the Product/SaaS runner's exact 20-seat fixture", async () => {
  const [migration, rollback, fixture] = await Promise.all([
    read("supabase/migrations/20260806090000_sam78_product_saas_billable_seat_cleanup_boundary.sql"),
    read("supabase/rollback/20260806090000_sam78_product_saas_billable_seat_cleanup_boundary_rollback.sql"),
    read("tests/database/sam78-product-saas-billable-seat-cleanup-boundary.sql"),
  ]);
  assert.match(migration, /organization\.billable_seat_limit = 20/);
  assert.match(rollback, /organization\.billable_seat_limit = 10/);
  assert.match(rollback, /requires_staging_or_test/);
  assert.match(fixture, /'real_estate','growth',20,'active'/);
  assert.match(fixture, /SET ROLE service_role/);
});
