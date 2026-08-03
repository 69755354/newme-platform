import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("lead imports generate stable row fingerprints and delegate tenant-local conflicts to one RPC", async () => {
  const [source, migration] = await Promise.all([
    read("src/app/api/leads/import/confirm/route.ts"),
    read("supabase/migrations/20260803143000_v4_tenant_lifecycle_closure.sql"),
  ]);
  for (const token of [
    'createHash("sha256")',
    "import_fingerprint: importFingerprint(row)",
    '"v4_import_leads_for_organization"',
    "p_organization_id: access.organizationId",
  ]) assert.ok(source.includes(token), `missing idempotency evidence: ${token}`);
  assert.ok(source.includes("row_number: row.row_number"));
  assert.ok(source.includes("raw_import_data: toJson(raw)"));
  assert.ok(source.includes("p_rows: normalizedRows"));
  assert.ok(source.includes("validateXlsxImportRows(rows)"));
  assert.ok(migration.includes("ON CONFLICT (organization_id, import_fingerprint) DO NOTHING"));
  assert.ok(migration.includes("skipped_duplicates"));
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

test("production conflict target is unique inside each organization", async () => {
  const repair = await read(
    "supabase/migrations/20260730110000_sam22_two_organization_isolation.sql",
  );
  assert.ok(repair.includes("DROP INDEX IF EXISTS public.leads_import_fingerprint_unique"));
  assert.ok(repair.includes("CREATE UNIQUE INDEX leads_organization_import_fingerprint_unique"));
  assert.ok(repair.includes("organization_id, import_fingerprint"));
  assert.equal(repair.includes("WHERE import_fingerprint IS NOT NULL"), false);
});
