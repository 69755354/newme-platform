#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validateCapturedEvidence } from "./capture-staging-sam21-reconciliation.mjs";

const STAGING_PROJECT_REF = "bfsiibofuzoglziltgyd";
const LEGACY_ORGANIZATION_ID = "6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1";
const REQUIRED_MIGRATION_HISTORY = Object.freeze({
  "20260730100000": "sam20_lead_organization_isolation",
  "20260730110000": "sam22_two_organization_isolation",
});

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!plainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function requireSnapshot(snapshot, phase, options) {
  if (!plainObject(snapshot)) throw new Error(`sam21_${phase}_snapshot_invalid`);
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.linearId !== "SAM-21" ||
    snapshot.releaseSha !== options.releaseSha ||
    snapshot.projectRef !== STAGING_PROJECT_REF ||
    snapshot.sqlBlob !== options.sqlBlob ||
    snapshot.schemaPhase !== phase
  ) {
    throw new Error(`sam21_${phase}_snapshot_provenance_invalid`);
  }
  const capturedAt = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(capturedAt)) {
    throw new Error(`sam21_${phase}_captured_at_invalid`);
  }
  const evidence = validateCapturedEvidence(snapshot.evidence);
  if (evidence.schema_phase !== phase) {
    throw new Error(`sam21_${phase}_evidence_phase_invalid`);
  }
  return { capturedAt, evidence };
}

function commonCounts(counts) {
  const result = { ...counts };
  delete result.memberships;
  return result;
}

function requireRollbackBlob(value, label) {
  if (!/^[0-9a-f]{40}$/.test(value ?? "")) {
    throw new Error(`sam21_${label}_rollback_blob_invalid`);
  }
  return value;
}

export function verifyReconciliationPair({
  preSnapshot,
  postSnapshot,
  releaseSha,
  sqlBlob,
  sam20RollbackBlob,
  sam22RollbackBlob,
}) {
  if (!/^[0-9a-f]{40}$/.test(releaseSha ?? "")) {
    throw new Error("sam21_release_sha_invalid");
  }
  if (!/^[0-9a-f]{40}$/.test(sqlBlob ?? "")) {
    throw new Error("sam21_sql_blob_invalid");
  }
  const pre = requireSnapshot(preSnapshot, "pre", { releaseSha, sqlBlob });
  const post = requireSnapshot(postSnapshot, "post", { releaseSha, sqlBlob });
  if (pre.capturedAt >= post.capturedAt) {
    throw new Error("sam21_snapshot_order_invalid");
  }

  const preserved = [
    ["aggregate_counts", commonCounts(pre.evidence.aggregate_counts),
      commonCounts(post.evidence.aggregate_counts)],
    ["quotation_value_total", pre.evidence.quotation_value_total,
      post.evidence.quotation_value_total],
    ["stage_counts", pre.evidence.stage_counts, post.evidence.stage_counts],
    ["lead_owner_digest", pre.evidence.lead_owner_digest,
      post.evidence.lead_owner_digest],
    ["history_relationship_digest", pre.evidence.history_relationship_digest,
      post.evidence.history_relationship_digest],
    ["document_ownership_digest", pre.evidence.document_ownership_digest,
      post.evidence.document_ownership_digest],
    ["orphan_counts", pre.evidence.orphan_counts, post.evidence.orphan_counts],
  ];
  for (const [label, before, after] of preserved) {
    if (!same(before, after)) {
      throw new Error(`sam21_${label}_changed`);
    }
  }

  const preCounts = pre.evidence.aggregate_counts;
  const postCounts = post.evidence.aggregate_counts;
  if (post.evidence.legacy_lead_count !== preCounts.leads) {
    throw new Error("sam21_legacy_lead_backfill_incomplete");
  }
  if (post.evidence.non_legacy_lead_count !== 0) {
    throw new Error("sam21_non_legacy_lead_detected");
  }
  if (post.evidence.legacy_snapshot_count !== preCounts.snapshots) {
    throw new Error("sam21_legacy_snapshot_backfill_incomplete");
  }
  if (
    post.evidence.active_legacy_membership_count !==
      preCounts.active_profiles ||
    postCounts.memberships !== preCounts.active_profiles
  ) {
    throw new Error("sam21_active_membership_backfill_incomplete");
  }
  if (
    !same(
      Object.keys(post.evidence.migration_history).sort(),
      Object.keys(REQUIRED_MIGRATION_HISTORY).sort(),
    )
  ) {
    throw new Error("sam21_migration_history_versions_invalid");
  }
  for (const [version, name] of Object.entries(REQUIRED_MIGRATION_HISTORY)) {
    const history = post.evidence.migration_history[version];
    if (history.name !== name || history.statement_count <= 0) {
      throw new Error(`sam21_migration_history_invalid:${version}`);
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    linearId: "SAM-21",
    releaseSha,
    projectRef: STAGING_PROJECT_REF,
    status: "passed",
    legacyOrganizationId: LEGACY_ORGANIZATION_ID,
    preservation: {
      aggregateCounts: "verified",
      quotationValueTotal: "verified",
      stageCounts: "verified",
      leadOwners: "verified",
      historyRelationships: "verified",
      documentOwnership: "verified",
      orphanCounts: "unchanged",
      legacyLeadBackfill: "verified",
      legacySnapshotBackfill: "verified",
      activeMembershipBackfill: "verified",
      migrationHistory: "verified",
    },
    rollback: {
      status: "versioned_assets_verified",
      sam20Blob: requireRollbackBlob(sam20RollbackBlob, "sam20"),
      sam22Blob: requireRollbackBlob(sam22RollbackBlob, "sam22"),
      order: ["SAM-22", "SAM-20"],
    },
    productionReconciliation: {
      status: "contract_ready_read_only",
      contract: "sam21-readonly-reconciliation-v1",
      pii: "excluded",
      executed: false,
    },
    cleanup: {
      status: "not_applicable",
      reason: "read_only_reconciliation_snapshots",
      fixtureIds: [],
    },
  });
}

async function main() {
  const releaseSha = process.env.SAM21_EXPECTED_RELEASE_SHA;
  const sqlBlob = process.env.SAM21_SQL_BLOB;
  const prePath = process.env.SAM21_PRE_EVIDENCE;
  const postPath = process.env.SAM21_POST_EVIDENCE;
  if (!prePath || !postPath) throw new Error("sam21_evidence_paths_missing");
  const [preSnapshot, postSnapshot] = await Promise.all([
    readFile(prePath, "utf8").then(JSON.parse),
    readFile(postPath, "utf8").then(JSON.parse),
  ]);
  const result = verifyReconciliationPair({
    preSnapshot,
    postSnapshot,
    releaseSha,
    sqlBlob,
    sam20RollbackBlob: process.env.SAM21_SAM20_ROLLBACK_BLOB,
    sam22RollbackBlob: process.env.SAM21_SAM22_ROLLBACK_BLOB,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
