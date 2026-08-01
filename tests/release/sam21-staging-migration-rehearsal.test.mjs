import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { verifyReconciliationPair } from "../../scripts/verify-staging-sam21-migration-rehearsal.mjs";

const SHA = "a".repeat(40);
const SQL_BLOB = "b".repeat(40);
const ROLLBACK_20 = "c".repeat(40);
const ROLLBACK_22 = "d".repeat(40);
const digest = (character) => character.repeat(32);

function evidence(phase) {
  const common = {
    contract: "sam21-readonly-reconciliation-v1",
    schema_phase: phase,
    transaction_read_only: true,
    aggregate_counts: {
      profiles: 5,
      active_profiles: 4,
      leads: 3,
      activities: 2,
      business_events: 2,
      chat_messages: 1,
      follow_up_logs: 1,
      lead_documents: 2,
      lead_milestones: 2,
      tasks: 2,
      snapshots: 3,
      ...(phase === "post" ? { memberships: 4 } : {}),
    },
    quotation_value_total: 1234.5,
    stage_counts: { new: 2, qualified: 1 },
    lead_owner_digest: digest("1"),
    history_relationship_digest: digest("2"),
    document_ownership_digest: digest("3"),
    orphan_counts: {
      lead_owner_missing: 0,
      history_parent_missing: 0,
      document_parent_missing: 0,
    },
  };
  if (phase === "post") {
    Object.assign(common, {
      legacy_lead_count: 3,
      non_legacy_lead_count: 0,
      legacy_snapshot_count: 3,
      active_legacy_membership_count: 4,
      migration_history: {
        "20260730100000": {
          name: "sam20_lead_organization_isolation",
          statement_count: 12,
        },
        "20260730110000": {
          name: "sam22_two_organization_isolation",
          statement_count: 8,
        },
      },
    });
  }
  return common;
}

function snapshot(phase) {
  return {
    schemaVersion: 1,
    linearId: "SAM-21",
    releaseSha: SHA,
    projectRef: "bfsiibofuzoglziltgyd",
    sqlBlob: SQL_BLOB,
    capturedAt:
      phase === "pre"
        ? "2026-07-31T00:00:00.000Z"
        : "2026-07-31T00:01:00.000Z",
    schemaPhase: phase,
    evidence: evidence(phase),
  };
}

function verify(preSnapshot = snapshot("pre"), postSnapshot = snapshot("post")) {
  return verifyReconciliationPair({
    preSnapshot,
    postSnapshot,
    releaseSha: SHA,
    sqlBlob: SQL_BLOB,
    sam20RollbackBlob: ROLLBACK_20,
    sam22RollbackBlob: ROLLBACK_22,
  });
}

test("SAM-21 accepts only a preserved pre/post staging reconciliation pair", () => {
  const result = verify();
  assert.equal(result.status, "passed");
  assert.deepEqual(result.rollback.order, ["SAM-22", "SAM-20"]);
  assert.equal(result.productionReconciliation.executed, false);
  assert.equal(result.cleanup.status, "not_applicable");
});

test("SAM-21 fails closed on counts, ownership, ordering, and backfill drift", () => {
  for (const mutate of [
    (post) => { post.evidence.aggregate_counts.leads += 1; },
    (post) => { post.evidence.lead_owner_digest = digest("4"); },
    (post) => { post.evidence.history_relationship_digest = digest("4"); },
    (post) => { post.evidence.document_ownership_digest = digest("4"); },
    (post) => { post.evidence.non_legacy_lead_count = 1; },
    (post) => { post.evidence.active_legacy_membership_count = 3; },
    (post) => { post.evidence.migration_history["20260730110000"].name = "wrong"; },
    (post) => { post.capturedAt = "2026-07-30T23:59:59.000Z"; },
  ]) {
    const post = structuredClone(snapshot("post"));
    mutate(post);
    assert.throws(() => verify(snapshot("pre"), post));
  }
});

test("SAM-21 capture path is fixed-staging, read-only, credential-safe, and PII-free", async () => {
  const [capture, reconciliation] = await Promise.all([
    readFile(
      new URL("../../scripts/capture-staging-sam21-reconciliation.mjs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../scripts/uat/sam21-readonly-reconciliation.sql", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(capture, /aws-0-ap-southeast-1\.pooler\.supabase\.com/);
  assert.match(
    capture,
    /`newme_staging_backup\.\$\{STAGING_PROJECT_REF\}`/,
  );
  assert.doesNotMatch(capture, /`postgres\.\$\{STAGING_PROJECT_REF\}`/);
  assert.doesNotMatch(capture, /db\.\$\{STAGING_PROJECT_REF\}\.supabase\.co/);
  assert.match(capture, /PGSSLMODE: "verify-full"/);
  assert.match(
    capture,
    /PGSSLROOTCERT: STAGING_DATABASE_ROOT_CA/,
  );
  assert.match(
    capture,
    /"\/etc\/newme-staging\/supabase-root-2021-ca\.crt"/,
  );
  assert.match(capture, /rootCaStat\.isSymbolicLink\(\)/);
  assert.match(capture, /\(rootCaStat\.mode & 0o777\) !== 0o600/);
  assert.match(capture, /default_transaction_read_only=on/);
  assert.match(capture, /\/etc\/newme-staging\/sam21-db\.pgpass/);
  assert.match(capture, /pgpassStat\.uid !== 0/);
  assert.match(capture, /\(pgpassStat\.mode & 0o777\) !== 0o600/);
  assert.doesNotMatch(capture, /vfopmpxlhwzpxqegayew/);
  assert.doesNotMatch(capture, /SUPABASE_SERVICE_ROLE_KEY|SUPABASE_DB_PASSWORD/);
  assert.doesNotMatch(capture, /\.\.\.process\.env/);
  assert.match(
    reconciliation,
    /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/,
  );
  assert.match(reconciliation, /supabase_migrations\.schema_migrations/);
  assert.match(reconciliation, /20260730100000/);
  assert.match(reconciliation, /20260730110000/);
  assert.doesNotMatch(
    reconciliation,
    /\b(email|phone|customer_name|file_name|file_url|notes|content|metadata)\b/i,
  );
});

test("SAM-21 controller exposes fixed capture/final gates and root-only evidence", async () => {
  const [control, readme] = await Promise.all([
    readFile(
      new URL("../../scripts/newme-staging-control.sh", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../infra/staging/uat-runner/README.md", import.meta.url),
      "utf8",
    ),
  ]);
  for (const pattern of [
    /SAM21_CAPTURE="scripts\/capture-staging-sam21-reconciliation\.mjs"/,
    /SAM21_VERIFY="scripts\/verify-staging-sam21-migration-rehearsal\.mjs"/,
    /SAM21_RECONCILIATION="scripts\/uat\/sam21-readonly-reconciliation\.sql"/,
    /SAM21_PGPASS="\/etc\/newme-staging\/sam21-db\.pgpass"/,
    /copy_commit_blob "\$SHA" "\$SAM21_CAPTURE"/,
    /copy_commit_blob "\$SHA" "\$SAM21_RECONCILIATION"/,
    /PGPASSFILE="\$SAM21_PGPASS"/,
    /SAM21_PROJECT_REF="\$STAGING_REF"/,
    /SAM21_EXPECTED_RELEASE_SHA="\$SHA"/,
    /target="\$SAM21_STATE_DIR\/\$SHA-\$phase\.json"/,
    /\[ ! -e "\$target" \]/,
    /for snapshot in "\$pre" "\$post"; do/,
    /stat -c '%u:%g:%a' "\$snapshot"/,
    /body\.linearId !== "SAM-21"/,
    /body\.status !== "passed"/,
    /body\.rollback\?\.status !== "versioned_assets_verified"/,
    /body\.productionReconciliation\?\.executed !== false/,
    /chmod 0600 "\$output"/,
    /mv -f "\$output" "\$SAM21_EVIDENCE"/,
    /reconcile-sam21\) run_reconcile_sam21/,
    /uat-sam21\) run_uat_sam21/,
  ]) assert.match(control, pattern);
  assert.match(readme, /reconcile-sam21 <SHA>/);
  assert.match(readme, /uat-sam21 <SHA>/);
  assert.doesNotMatch(control, /cat "\$SAM21_PGPASS"/);
  assert.doesNotMatch(control, /cat "\$output"/);
  assert.doesNotMatch(control, /supabase\s+(?:db|migration|link)/);
});
