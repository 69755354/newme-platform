import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260726130911_harden_audit_session_table_grants.sql",
    import.meta.url,
  ),
  "utf8",
);
const rollback = await readFile(
  new URL(
    "../../supabase/rollback/20260726130911_harden_audit_session_table_grants_rollback.sql",
    import.meta.url,
  ),
  "utf8",
);

test("SAM-61 makes audit and session evidence read-only to browser roles", () => {
  for (const table of ["activity_logs", "audit_logs", "user_session_daily"]) {
    assert.match(
      migration,
      new RegExp(
        `REVOKE ALL PRIVILEGES ON TABLE[\\s\\S]*public\\.${table}[\\s\\S]*FROM PUBLIC, anon, authenticated`,
        "i",
      ),
    );
    assert.match(
      migration,
      new RegExp(
        `GRANT SELECT ON TABLE[\\s\\S]*public\\.${table}[\\s\\S]*TO authenticated`,
        "i",
      ),
    );
  }
});

test("SAM-61 prevents admin and boss from rewriting session evidence", () => {
  assert.match(
    migration,
    /CREATE POLICY policy_user_session_daily_update_none[\s\S]*USING \(false\)[\s\S]*WITH CHECK \(false\)/i,
  );
  assert.match(
    migration,
    /CREATE POLICY policy_user_session_daily_delete_none[\s\S]*USING \(false\)/i,
  );
  assert.doesNotMatch(migration, /CREATE POLICY policy_user_session_daily_(?:update|delete)_admin/i);
});

test("SAM-61 keeps the emergency rollback outside the forward chain", () => {
  assert.match(rollback, /Emergency rollback/i);
  assert.match(rollback, /GRANT ALL PRIVILEGES[\s\S]*TO anon, authenticated, service_role/i);
  assert.match(rollback, /CREATE POLICY policy_user_session_daily_update_admin/i);
  assert.match(rollback, /CREATE POLICY policy_user_session_daily_delete_admin/i);
});
