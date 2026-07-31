import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL(
  "../../supabase/migrations/20260726160522_harden_next_quote_no_authorization.sql",
  import.meta.url,
);
const rollback = new URL(
  "../../supabase/rollback/20260726160522_harden_next_quote_no_authorization_rollback.sql",
  import.meta.url,
);

test("SAM-61 next_quote_no enforces the quotation workflow role boundary", async () => {
  const sql = await readFile(migration, "utf8");

  assert.match(sql, /v_actor_id uuid := auth\.uid\(\)/);
  assert.match(sql, /id = v_actor_id\s+AND is_active = true/);
  assert.match(
    sql,
    /v_actor_role, ''\) NOT IN \('admin', 'boss', 'sales'\)/,
  );
  assert.match(sql, /RAISE EXCEPTION 'UNAUTHORIZED'/);
  assert.match(sql, /RAISE EXCEPTION 'FORBIDDEN_QUOTE_NUMBER'/);
  assert.match(
    sql,
    /SET search_path = pg_catalog, public, pg_temp/,
  );
  assert.match(
    sql,
    /REVOKE EXECUTE ON FUNCTION public\.next_quote_no\(\) FROM PUBLIC, anon/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION public\.next_quote_no\(\) TO authenticated/,
  );
});

test("SAM-61 next_quote_no has a controlled cleanroom rollback", async () => {
  const sql = await readFile(rollback, "utf8");

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.next_quote_no\(\)/);
  assert.doesNotMatch(sql, /auth\.uid\(\)/);
  assert.match(sql, /SET search_path = pg_catalog, public, pg_temp/);
  assert.match(
    sql,
    /REVOKE EXECUTE ON FUNCTION public\.next_quote_no\(\) FROM PUBLIC, anon/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION public\.next_quote_no\(\) TO authenticated/,
  );
});
