import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const baseline = new URL("../../supabase/migrations/20260630200000_rls_policy_remediation.sql", import.meta.url);
const policies = new URL("../../supabase/migrations/20260701000002_final_for_all_cleanup.sql", import.meta.url);

test("SAM-62 clean-room chain creates the transfer history required by atomic reassignment", async () => {
  const [schemaSql, policySql] = await Promise.all([
    readFile(baseline, "utf8"),
    readFile(policies, "utf8"),
  ]);

  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS transfer_history/);
  assert.match(schemaSql, /lead_id UUID NOT NULL REFERENCES leads\(id\) ON DELETE CASCADE/);
  assert.match(schemaSql, /from_user_id UUID REFERENCES profiles\(id\)/);
  assert.match(schemaSql, /to_user_id UUID NOT NULL REFERENCES profiles\(id\)/);
  assert.match(schemaSql, /transferred_by UUID NOT NULL REFERENCES profiles\(id\)/);

  assert.match(policySql, /policy_transfer_history_select_admin/);
  assert.match(policySql, /policy_transfer_history_select_sales/);
  assert.match(policySql, /from_user_id = auth\.uid\(\) OR to_user_id = auth\.uid\(\)/);
  assert.match(policySql, /policy_transfer_history_insert_admin/);
});
