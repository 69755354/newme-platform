import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL("../../supabase/migrations/20260724174225_sam62_create_transfer_history.sql", import.meta.url);

test("SAM-62 forward migration creates transfer history for already-migrated environments", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.transfer_history/);
  assert.match(sql, /lead_id uuid NOT NULL REFERENCES public\.leads\(id\) ON DELETE CASCADE/);
  assert.match(sql, /ALTER TABLE public\.transfer_history ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /policy_transfer_history_select_sales/);
  assert.match(sql, /policy_transfer_history_insert_admin/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.transfer_history FROM anon/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.transfer_history TO authenticated/);
});

test("SAM-62 forward migration is safe when the historical baseline already exists", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/);
  assert.match(sql, /DROP POLICY IF EXISTS/);
});
