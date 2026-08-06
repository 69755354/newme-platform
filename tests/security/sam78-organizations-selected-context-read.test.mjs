import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL("../../" + path, import.meta.url), "utf8");

test("SAM-78 organization reads require selected context and retain a staging/test-only rollback", async () => {
  const [migration, rollback, regression, gate] = await Promise.all([
    read("supabase/migrations/20260806120000_sam78_organizations_selected_context_read_boundary.sql"),
    read("supabase/rollback/20260806120000_sam78_organizations_selected_context_read_boundary_rollback.sql"),
    read("tests/database/sam78-organizations-selected-context-read.sql"),
    read("scripts/run-sam23-database-gate.mjs"),
  ]);
  assert.match(migration, /CREATE POLICY sam78_organizations_selected_context_read/);
  assert.match(migration, /AS RESTRICTIVE[\s\S]*FOR SELECT[\s\S]*TO authenticated/);
  assert.match(migration, /id = \(SELECT public\.product_organization_context\(\)\)/);
  assert.doesNotMatch(migration, /FOR ALL/);
  assert.match(rollback, /sam78_organizations_selected_context_read_rollback_requires_staging_or_test/);
  assert.match(rollback, /COALESCE\(current_setting\('newme\.environment', true\), ''\)/);
  assert.match(rollback, /DROP POLICY IF EXISTS sam78_organizations_selected_context_read/);
  assert.match(regression, /selected organization read boundary exposed foreign organization/);
  assert.match(regression, /multi-organization headerless read was not fail-closed/);
  assert.match(gate, /sam78_organizations_selected_context_read_boundary_apply/);
  assert.match(gate, /sam78_organizations_selected_context_read_fixture/);
  assert.match(gate, /sam78_organizations_selected_context_read_rollback/);
});
