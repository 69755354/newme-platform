import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("SAM-21 runner is disposable and pins the reviewed SAM-20/22 assets", async () => {
  const runner = await read("scripts/run-sam21-first-organization-rehearsal.mjs");

  assert.match(runner, /postgres:17-alpine@sha256:[a-f0-9]{64}/);
  assert.ok(runner.includes("CANONICAL_ASSET_BLOBS"));
  assert.ok(runner.includes("20260730100000_sam20_lead_organization_isolation.sql"));
  assert.ok(runner.includes("20260730100000_sam20_lead_organization_isolation_rollback.sql"));
  assert.ok(runner.includes("20260730110000_sam22_two_organization_isolation.sql"));
  assert.ok(runner.includes("20260730110000_sam22_two_organization_isolation_rollback.sql"));
  assert.ok(runner.includes("scripts/uat/sam20-lead-organization-isolation.mjs"));
  assert.ok(runner.includes("scripts/uat/sam22-two-organization-isolation.mjs"));
  assert.ok(runner.includes('command(["rm", "--force", container])'));
  assert.ok(runner.includes('"-h",\n    "127.0.0.1"'));
  assert.equal(runner.includes("SUPABASE_SERVICE_ROLE_KEY"), false);
  assert.equal(runner.includes("NEXT_PUBLIC_SUPABASE_URL"), false);
  assert.equal(runner.includes("app.newme.ae"), false);
});

test("SAM-21 production reconciliation input is read-only and PII-free", async () => {
  const reconciliation = await read("scripts/uat/sam21-readonly-reconciliation.sql");
  const rehearsal = await read(
    "tests/database/sam21-first-organization-rehearsal.sql",
  );

  assert.ok(
    reconciliation.includes(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    ),
  );
  assert.ok(reconciliation.includes("current_setting('transaction_read_only')"));
  assert.ok(reconciliation.includes("'aggregate_counts'"));
  assert.ok(reconciliation.includes("'lead_owner_digest'"));
  assert.ok(reconciliation.includes("'history_relationship_digest'"));
  assert.ok(reconciliation.includes("'document_ownership_digest'"));
  assert.ok(reconciliation.includes("'orphan_counts'"));
  assert.match(reconciliation, /COMMIT;\s*$/);
  assert.doesNotMatch(
    reconciliation,
    /\b(email|phone|customer_name|file_name|file_url|notes|content|metadata)\b/i,
  );
  assert.doesNotMatch(
    reconciliation,
    /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE)\b/i,
  );
  assert.equal(
    rehearsal.match(/\\ir \.\.\/\.\.\/scripts\/uat\/sam21-readonly-reconciliation\.sql/g)
      ?.length,
    2,
  );
});
