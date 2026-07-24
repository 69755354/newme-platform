import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL("../../supabase/migrations/20260724173351_sam62_allow_transfer_activity.sql", import.meta.url);

test("SAM-62 permits the transfer activity emitted by atomic reassignment", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /DROP CONSTRAINT IF EXISTS activities_type_check/);
  assert.match(sql, /ADD CONSTRAINT activities_type_check/);
  assert.match(sql, /'transfer'/);
});
