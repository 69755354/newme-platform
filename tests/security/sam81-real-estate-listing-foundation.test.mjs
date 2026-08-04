import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("SAM-81 listing foundation is organization-bound, adapter-disabled and reversible", async () => {
  const [migration, rollback, fixture, types, gate, workflow] = await Promise.all([
    read("supabase/migrations/20260805020000_sam81_real_estate_listing_foundation.sql"),
    read("supabase/rollback/20260805020000_sam81_real_estate_listing_foundation_rollback.sql"),
    read("tests/database/sam81-real-estate-listing-foundation.sql"),
    read("src/types/database.ts"),
    read("scripts/run-sam81-real-estate-database-gate.mjs"),
    read(".github/workflows/ci.yml"),
  ]);

  for (const table of [
    "real_estate_parties", "real_estate_properties", "real_estate_listings",
    "real_estate_listing_assets", "real_estate_viewings",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE public\\.${table}`));
    assert.match(migration, new RegExp(`['\"]${table}['\"]`));
    assert.match(types, new RegExp(`      ${table}: \\{`));
    assert.match(rollback, new RegExp(`DROP TABLE IF EXISTS public\\.${table}`));
  }
  assert.match(migration, /FOREIGN KEY \(organization_id, owner_party_id\)/);
  assert.match(migration, /FOREIGN KEY \(organization_id, property_id\)/);
  assert.match(migration, /FOREIGN KEY \(organization_id, lead_id\)/);
  assert.match(migration, /UNIQUE \(organization_id, idempotency_key\)/);
  assert.match(migration, /publish_state text NOT NULL DEFAULT 'disabled' CHECK \(publish_state = 'disabled'\)/);
  assert.match(migration, /WITH \(security_invoker = true\)/);
  assert.match(migration, /v_real_estate_listing_publish_readiness/);
  assert.match(types, /v_real_estate_listing_publish_readiness: \{/);
  assert.match(migration, /organization_id = public\.requested_organization_id\(\)/);
  assert.match(migration, /public\.v4_actor_has_capability\(organization_id, auth\.uid\(\), ''organization\.data\.create'', ''write''\)/);
  assert.match(rollback, /sam81_rollback_requires_staging_or_test/);
  assert.match(rollback, /sam81_rollback_records_present/);
  assert.match(fixture, /sam81_cross_org_read_visible/);
  assert.match(fixture, /sam81_inactive_write_accepted/);
  assert.match(fixture, /sam81_viewing_idempotency_not_enforced/);
  assert.match(fixture, /sam81_external_publish_state_accepted/);
  assert.match(fixture, /sam81_rollback_residue/);
  assert.match(gate, /sam81-real-estate-listing-foundation\.sql/);
  assert.match(gate, /postgres:17-alpine@sha256:/);
  assert.match(gate, /"pg_isready", "-h", "127\.0\.0\.1", "-U", "postgres"/);
  assert.match(gate, /"psql", "-X", "-v", "ON_ERROR_STOP=1", "-h", "127\.0\.0\.1", "-U", "postgres"/);
  assert.match(gate, /sam81_disposable_cleanup_failed/);
  assert.match(workflow, /SAM-81 real-estate listing foundation database gate/);
});
