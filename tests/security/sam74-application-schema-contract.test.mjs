import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260724181538_sam74_restore_application_schema_contract.sql",
    import.meta.url,
  ),
  "utf8",
);
const circuitMigration = await readFile(
  new URL(
    "../../supabase/migrations/20260724181940_sam74_restore_circuit_diagrams_contract.sql",
    import.meta.url,
  ),
  "utf8",
);

test("SAM-74 restores application columns missing from the migration chain", () => {
  assert.match(migration, /ALTER TABLE public\.leads[\s\S]*expected_close_date DATE/i);
  assert.match(migration, /ALTER TABLE public\.leads[\s\S]*archive_reason TEXT/i);
  assert.match(migration, /ALTER TABLE public\.profiles[\s\S]*password_changed_at TIMESTAMPTZ/i);
  assert.match(
    circuitMigration,
    /ALTER TABLE public\.leads[\s\S]*circuit_diagrams BOOLEAN/i,
  );
});

test("SAM-74 application views preserve caller RLS and browser read boundaries", () => {
  for (const view of ["v_lead_trace", "v_risk_pool"]) {
    assert.match(
      migration,
      new RegExp(`CREATE OR REPLACE VIEW public\\.${view}[\\s\\S]*?security_invoker = true`, "i"),
    );
    assert.match(
      migration,
      new RegExp(`REVOKE ALL ON TABLE public\\.${view} FROM PUBLIC, anon`, "i"),
    );
    assert.match(
      migration,
      new RegExp(
        `GRANT SELECT ON TABLE public\\.${view} TO authenticated, service_role`,
        "i",
      ),
    );
  }
});

test("SAM-74 reloads the PostgREST schema cache after restoring the contract", () => {
  assert.match(migration, /NOTIFY pgrst,\s*'reload schema'/i);
  assert.match(circuitMigration, /NOTIFY pgrst,\s*'reload schema'/i);
});

test("SAM-74 keeps rollback scripts out of the forward migration chain", async () => {
  const migrationDirectory = new URL("../../supabase/migrations/", import.meta.url);
  const migrationFiles = (await readdir(migrationDirectory)).filter((name) =>
    name.endsWith(".sql"),
  );

  for (const filename of migrationFiles) {
    assert.match(filename, /^\d{14}_.+\.sql$/);
    assert.doesNotMatch(filename, /^rollback_/i);
  }

  for (const filename of ["rollback_crm_v3.sql", "rollback_p0_10.sql"]) {
    await readFile(new URL(`../../supabase/rollback/${filename}`, import.meta.url), "utf8");
  }
});
