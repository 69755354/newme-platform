import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("lead imports generate stable row fingerprints and ignore conflicts", async () => {
  const source = await read("src/app/api/leads/import/confirm/route.ts");
  for (const token of [
    'createHash("sha256")',
    "import_fingerprint: importFingerprint(row)",
    'onConflict: "import_fingerprint"',
    "ignoreDuplicates: true",
    "skipped_duplicates: skippedDuplicates",
  ]) assert.ok(source.includes(token), `missing idempotency evidence: ${token}`);
  assert.ok(source.includes("row_number: row.row_number"));
  assert.ok(source.includes("raw_import_data: row.raw_import_data"));
});

test("database enforces import fingerprint uniqueness without rewriting legacy rows", async () => {
  const migration = await read(
    "supabase/migrations/20260712000000_add_lead_import_fingerprint.sql",
  );
  assert.ok(migration.includes("ADD COLUMN IF NOT EXISTS import_fingerprint text"));
  assert.ok(migration.includes("CREATE UNIQUE INDEX IF NOT EXISTS leads_import_fingerprint_unique"));
  assert.ok(migration.includes("WHERE import_fingerprint IS NOT NULL"));
  assert.equal(migration.includes("UPDATE public.leads"), false);
});

test("production conflict target is a full unique index", async () => {
  const repair = await read(
    "supabase/migrations/20260716000000_fix_import_fingerprint_conflict.sql",
  );
  assert.ok(repair.includes("DROP INDEX IF EXISTS public.leads_import_fingerprint_unique"));
  assert.ok(repair.includes("CREATE UNIQUE INDEX leads_import_fingerprint_unique"));
  assert.equal(repair.includes("WHERE import_fingerprint IS NOT NULL"), false);
});