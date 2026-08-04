import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("SAM-78 V4 exit completion preserves the exported digest and rejects later drift", async () => {
  const [migration, rollback, fixture, gate, controller, verifier] = await Promise.all([
    read("supabase/migrations/20260805010000_sam78_v4_exit_digest_contract.sql"),
    read("supabase/rollback/20260805010000_sam78_v4_exit_digest_contract_rollback.sql"),
    read("tests/database/v4-tenant-lifecycle-closure.sql"),
    read("scripts/run-sam23-database-gate.mjs"),
    read("scripts/newme-staging-control.sh"),
    read("scripts/uat/sam78-staging-migration-verify.sql"),
  ]);

  assert.match(migration, /organization\.customer_export\.v4/);
  assert.match(migration, /v4_export_evidence_not_unique/);
  assert.match(migration, /jsonb_array_elements\(snapshot #> '\{tables,audit_events\}'\)/);
  assert.match(migration, /organization_changed_after_export/);
  assert.match(migration, /SET search_path = pg_catalog, public, pg_temp/);
  assert.match(migration, /FROM PUBLIC, anon, authenticated, service_role/);
  assert.doesNotMatch(migration, /GRANT EXECUTE/);
  assert.match(rollback, /sam78_v4_exit_digest_rollback_requires_staging_or_test/);
  assert.match(
    rollback,
    /COALESCE\(current_setting\('newme\.environment', true\), ''\)[\s\S]*NOT IN \('staging', 'test'\)/,
  );
  assert.match(rollback, /complete_organization_customer_exit/);
  assert.match(fixture, /sam78-v4-export-before-exit-b/);
  assert.match(fixture, /V4 export-to-complete result drifted/);
  assert.match(fixture, /V4 exit accepted an export digest without exact audit evidence/);
  assert.match(fixture, /V4 exit accepted organization changes after export/);
  assert.match(fixture, /organization_changed_after_export/);
  assert.match(gate, /sam78_v4_exit_digest_contract_apply/);
  assert.match(gate, /sam78_v4_exit_digest_contract_rollback/);
  assert.match(controller, /SAM78_MIGRATION_050100_BLOB/);
  assert.match(verifier, /SAM78 V4 exit digest contract is missing/);
});
