import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260727130000_add_activities_project_fk_index.sql",
    import.meta.url,
  ),
  "utf8",
);

test("SAM-69 adds only the additive activities.project_id FK index", () => {
  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS idx_activities_project\s+ON public\.activities\s*\(project_id\);/i,
  );
  assert.doesNotMatch(migration, /\bCONCURRENTLY\b/i);
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|INDEX)\b/i);
});
