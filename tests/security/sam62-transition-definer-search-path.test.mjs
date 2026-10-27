import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL(
  "../../supabase/migrations/20260724100000_fix_transition_lead_stage_definer_search_path.sql",
  import.meta.url,
);
const signature = "transition_lead_stage(uuid, text, text, text, uuid)";
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("SAM-62 fixes the five-argument stage RPC search path and execution boundary", async () => {
  const sql = await readFile(migration, "utf8");
  const escapedSignature = escapeRegExp(signature).replace(/ /g, "\\s+");

  assert.match(
    sql,
    new RegExp(`ALTER FUNCTION public\\.${escapedSignature}\\s+SET search_path = pg_catalog, public, pg_temp;`),
  );
  assert.doesNotMatch(sql, /SET\s+search_path\s*=\s*public\s*;/i);
  assert.match(
    sql,
    new RegExp(`REVOKE ALL ON FUNCTION public\\.${escapedSignature}\\s+FROM PUBLIC, anon, authenticated;`),
  );
  assert.match(
    sql,
    new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${escapedSignature}\\s+TO authenticated;`),
  );
});
