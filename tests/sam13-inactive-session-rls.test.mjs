import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/20260720000000_enforce_active_profile_rls.sql", import.meta.url),
  "utf8",
);

test("SAM-13 denies every current RLS business-table operation to an inactive JWT", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.current_user_is_active\(\)/);
  assert.match(migration, /WHERE id = auth\.uid\(\)\s+AND is_active IS TRUE/s);
  assert.match(migration, /c\.relrowsecurity/);
  assert.match(migration, /c\.relname <> 'profiles'/);
  assert.match(migration, /AS RESTRICTIVE FOR ALL TO authenticated/);
  assert.match(migration, /USING \(public\.current_user_is_active\(\)\) WITH CHECK \(public\.current_user_is_active\(\)\)/);
  assert.doesNotMatch(migration, /WITH CHECK \(true\)/);
});

test("SAM-13 does not let an inactive JWT reactivate its own profile", () => {
  assert.match(
    migration,
    /CREATE POLICY policy_profiles_update_self[\s\S]*USING \(id = auth\.uid\(\) AND is_active IS TRUE\)/,
  );
  assert.match(
    migration,
    /CREATE POLICY policy_profiles_update_self[\s\S]*WITH CHECK \([\s\S]*AND is_active IS TRUE/,
  );
  assert.match(
    migration,
    /CREATE POLICY policy_profiles_update_admin[\s\S]*role IN \('admin', 'boss'\)[\s\S]*AND is_active IS TRUE/,
  );
});
