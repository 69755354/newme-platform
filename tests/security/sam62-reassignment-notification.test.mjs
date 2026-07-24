import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const original = new URL("../../supabase/migrations/20260723140000_atomic_lead_reassignment.sql", import.meta.url);
const forward = new URL("../../supabase/migrations/20260724173708_sam62_fix_reassignment_notification_uuid.sql", import.meta.url);

test("SAM-62 writes the lead UUID to notification.related_id without a text cast", async () => {
  const [originalSql, forwardSql] = await Promise.all([
    readFile(original, "utf8"),
    readFile(forward, "utf8"),
  ]);
  for (const sql of [originalSql, forwardSql]) {
    assert.match(sql, /was assigned to you\.', p_lead_id, 'lead'/);
    assert.doesNotMatch(sql, /p_lead_id::text, 'lead'/);
  }
});
