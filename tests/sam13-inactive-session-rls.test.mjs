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
  for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
    assert.match(
      migration,
      new RegExp(`CREATE POLICY active_profile_required_${operation.toLowerCase()} ON %s AS RESTRICTIVE FOR ${operation} TO authenticated`),
    );
  }
  assert.doesNotMatch(migration, /AS RESTRICTIVE FOR ALL/);
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

test("SAM-13 closes every authenticated SECURITY DEFINER RPC behind one active guard", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.require_current_user_active\(\)/);
  assert.match(migration, /IF auth\.uid\(\) IS NULL OR NOT public\.current_user_is_active\(\) THEN/);

  for (const name of [
    "transition_lead_stage",
    "reopen_lead_milestone",
    "recomplete_lead_milestone",
    "next_quote_no",
  ]) {
    assert.match(migration, new RegExp(`ALTER FUNCTION public\\.${name}\\([^;]*?\\)\\s+RENAME TO ${name}_active_impl`, "s"));
    assert.match(
      migration,
      new RegExp(`CREATE FUNCTION public\\.${name}\\([\\s\\S]*?PERFORM public\\.require_current_user_active\\(\\)`, "s"),
    );
  }

  assert.match(migration, /AND p\.prosecdef[\s\S]*REVOKE ALL ON FUNCTION %s FROM authenticated/s);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.transition_lead_stage\(uuid, text, text, text\) TO authenticated/);
});
