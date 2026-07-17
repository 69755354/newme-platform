import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Lead deletion may cascade First Contact while direct milestone deletion stays blocked", async () => {
  const migration = await readFile(
    new URL("../../supabase/migrations/20260717000000_allow_lead_delete_with_first_contact.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /OLD\.milestone_key = 'first_contact'/);
  assert.match(migration, /pg_trigger_depth\(\) = 1/);
  assert.match(migration, /RAISE EXCEPTION 'first_contact milestone is fact-driven and cannot be deleted'/);
});
