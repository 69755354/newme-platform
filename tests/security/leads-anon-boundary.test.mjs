import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL(
  "../../supabase/migrations/20260725234600_restrict_legacy_unassigned_leads_policy.sql",
  import.meta.url,
);

test("unassigned leads remain visible only to authenticated callers", async () => {
  const sql = await readFile(migration, "utf8");

  assert.match(
    sql,
    /DROP POLICY IF EXISTS "sales_own_leads" ON public\.leads;/i,
  );
  assert.match(
    sql,
    /CREATE POLICY "sales_own_leads"[\s\S]*?FOR SELECT[\s\S]*?TO authenticated[\s\S]*?assigned_to = \(SELECT auth\.uid\(\)\)[\s\S]*?assigned_to IS NULL/i,
  );
  assert.doesNotMatch(
    sql,
    /CREATE POLICY "sales_own_leads"[\s\S]*?TO\s+(?:PUBLIC|anon)\b/i,
  );
  assert.match(sql, /NOTIFY pgrst,\s*'reload schema';/i);
});
