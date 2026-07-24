import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL("../../supabase/migrations/20260724172009_sam61_finish_definer_boundary_cleanup.sql", import.meta.url);

test("SAM-61 makes every clean-room security-definer view use invoker semantics", async () => {
  const sql = await readFile(migration, "utf8");

  for (const view of ["lead_funnel_daily", "pipeline_summary", "sales_performance"]) {
    assert.ok(sql.includes(`ALTER VIEW public.${view} SET (security_invoker = true);`));
  }
});

test("SAM-61 closes the remaining round-robin definer grants and search paths", async () => {
  const sql = await readFile(migration, "utf8");
  const autoAssign = "public.auto_assign_lead()";
  const assignLead = "public.assign_new_lead(text, text, text, text, text, text, text)";

  assert.ok(sql.includes("ALTER FUNCTION public.create_business_event(uuid, text, uuid, text, jsonb, uuid) SET search_path = pg_catalog, public, pg_temp;"));
  for (const fn of [autoAssign, assignLead]) {
    assert.ok(sql.includes(`ALTER FUNCTION ${fn} SET search_path = pg_catalog, public, pg_temp;`));
    assert.ok(sql.includes(`REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated;`));
    assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION ${fn} TO service_role;`));
  }
});
