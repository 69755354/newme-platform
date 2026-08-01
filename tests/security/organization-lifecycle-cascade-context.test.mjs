import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260802064000_organization_lifecycle_cascade_context.sql",
    import.meta.url,
  ),
  "utf8",
);
const rollback = await readFile(
  new URL(
    "../../supabase/rollback/20260802064000_organization_lifecycle_cascade_context_rollback.sql",
    import.meta.url,
  ),
  "utf8",
);
const fixture = await readFile(
  new URL("../database/organization-lifecycle-cascade-context.sql", import.meta.url),
  "utf8",
);
const gate = await readFile(
  new URL("../../scripts/run-sam23-database-gate.mjs", import.meta.url),
  "utf8",
);
const databaseHarness = await readFile(
  new URL("../database/sam23-organization-commercial-core.sql", import.meta.url),
  "utf8",
);

test("nested deletes use only the explicit organization request context", () => {
  assert.match(migration, /TG_OP = 'DELETE'/);
  assert.match(migration, /pg_trigger_depth\(\) > 1/);
  assert.match(migration, /target_organization_id := public\.requested_organization_id\(\)/);
  assert.match(migration, /organization_lifecycle_context_missing/);
  assert.doesNotMatch(
    migration,
    /target_organization_id IS NULL\s+THEN\s+RETURN OLD/,
  );
});

test("database fixture proves exact cascade cleanup and missing-context atomicity", () => {
  assert.match(
    databaseHarness,
    /CREATE TABLE public\.lead_milestones \([\s\S]*?REFERENCES public\.leads\(id\) ON DELETE CASCADE/,
  );
  assert.match(fixture, /DELETE FROM public\.leads/);
  assert.match(fixture, /organization_lifecycle_cascade_cleanup_not_exact/);
  assert.match(fixture, /missing_cascade_organization_context_was_accepted/);
  assert.match(fixture, /failed_cascade_delete_was_not_atomic/);
});

test("rollback and disposable PostgreSQL gate remain fail closed", () => {
  assert.match(rollback, /organization_lifecycle_cascade_rollback_requires_staging_or_test/);
  assert.doesNotMatch(rollback, /pg_trigger_depth\(\) > 1/);
  assert.match(gate, /organization_lifecycle_cascade_fixture/);
  assert.match(gate, /organization_lifecycle_cascade_failed_rollback_atomicity/);
  assert.match(gate, /organization_lifecycle_cascade_rollback/);
});
