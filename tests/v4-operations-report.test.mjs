import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { validateOperationsEvidence } from "../scripts/v4-operations-report.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const SHA = digest("sam86-release").slice(0, 40);
const TREE = digest("sam86-tree").slice(0, 40);
const ROLLBACK = digest("sam86-rollback").slice(0, 40);

function validEvidence() {
  return {
    schema_version: 2,
    release: {
      git_sha: SHA, tree_sha: TREE, artifact_sha256: digest("artifact"), manifest_sha256: digest("manifest"),
      manifest_git_sha: SHA, runtime_git_sha: SHA, active_release_sha: SHA, rollback_release_sha: ROLLBACK,
      observed_at: "2026-08-05T00:06:00.000Z",
    },
    health: { http_status: 200, status: "ok", release_sha: SHA, observed_at: "2026-08-05T00:00:00.000Z" },
    readiness: { http_status: 200, status: "ready", release_sha: SHA, latency_ms: 12, observed_at: "2026-08-05T00:00:01.000Z" },
    observation: {
      started_at: "2026-08-05T00:00:02.000Z", ended_at: "2026-08-05T00:05:00.000Z", requests: 10, errors: 1,
      latency_ms: { p50: 5, p95: 10, p99: 12 }, queue_delay_ms: { p50: 1, p95: 2, p99: 3 },
      tenants: [
        { tenant_ref: "tenant://synthetic/a", requests: 6, errors: 1, latency_ms: { p50: 5, p95: 10, p99: 12 } },
        { tenant_ref: "tenant://synthetic/b", requests: 4, errors: 0, latency_ms: { p50: 4, p95: 9, p99: 11 } },
      ],
    },
    load: { run_id: "load://sam86/run-20260805", release_sha: SHA, dataset_shape_sha256: digest("dataset"), tenants: 2, duration_seconds: 298, concurrency: 2, requests: 10, errors: 1, latency_ms: { p50: 5, p95: 10, p99: 12 }, throughput_per_second: 10 / 298, error_rate: 0.1 },
    noisy_neighbor: { stressed_tenant_ref: "tenant://synthetic/a", collateral_tenant_refs: ["tenant://synthetic/b"], cross_tenant_leakage_count: 0, decision: "accept", max_safe_concurrency: 2 },
    alerts: { owner: "platform-operations", rule_ref: "alert-rule://sam86/high-error", route_ref: "alert-route://isolated/sink", stimulus_ref: "stimulus://sam86/known-error", triggered_at: "2026-08-05T00:01:00.000Z", delivered_at: "2026-08-05T00:01:10.000Z", acknowledged_at: "2026-08-05T00:01:20.000Z", delivery_latency_ms: 10_000, channels: ["isolated-test-sink"] },
    restore: { backup_id: "backup://sam86/20260805", isolated_target_id: "restore://isolated/sam86/20260805", backup_metadata_sha256: digest("backup-metadata"), pitr_metadata_sha256: digest("pitr-metadata"), recovery_point_at: "2026-08-05T00:00:00.000Z", failure_at: "2026-08-05T00:01:00.000Z", backup_completed_at: "2026-08-05T00:01:00.000Z", started_at: "2026-08-05T00:02:00.000Z", completed_at: "2026-08-05T00:04:00.000Z", destroyed_at: "2026-08-05T00:05:00.000Z", rpo_seconds: 60, rto_seconds: 120, before_aggregate_sha256: digest("restore-counts"), after_aggregate_sha256: digest("restore-counts"), verified: true },
  };
}

test("accepts one SHA-bound aggregate operational evidence report", () => {
  const result = validateOperationsEvidence(validEvidence());
  assert.equal(result.release_sha, SHA);
  assert.equal(result.tree_sha, TREE);
  assert.equal(result.error_rate, 0.1);
  assert.equal(result.tenant_count, 2);
  assert.equal(result.alerts.delivery_latency_ms, 10_000);
  assert.deepEqual(result.restore, { rpo_seconds: 60, rto_seconds: 120 });
});

test("fails closed on provenance, runtime, alert, load and restore drift", async (t) => {
  const cases = [
    ["placeholder manifest", (e) => { e.release.manifest_sha256 = "a".repeat(64); }, /release_manifest_sha256_placeholder/],
    ["health SHA", (e) => { e.health.release_sha = ROLLBACK; }, /health_release_provenance_mismatch/],
    ["readiness ordering", (e) => { e.readiness.observed_at = "2026-08-05T00:07:00.000Z"; }, /runtime_observation_timeline_invalid/],
    ["alert timing", (e) => { e.alerts.delivery_latency_ms = 1; }, /alerts_delivery_latency_mismatch/],
    ["load arithmetic", (e) => { e.load.throughput_per_second = 1; }, /load_throughput_mismatch/],
    ["neighbor leak", (e) => { e.noisy_neighbor.cross_tenant_leakage_count = 1; }, /noisy_neighbor_cross_tenant_leakage/],
    ["PITR restoration hash", (e) => { e.restore.after_aggregate_sha256 = digest("wrong"); }, /restore_aggregate_hash_mismatch/],
    ["RTO measurement", (e) => { e.restore.rto_seconds = 121; }, /restore_measurement_mismatch/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      const evidence = validEvidence();
      mutate(evidence);
      assert.throws(() => validateOperationsEvidence(evidence), expected);
    });
  }
});

test("CLI accepts a regular bounded evidence file and emits only derived evidence", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "newme-sam86-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "evidence.json");
  await writeFile(input, JSON.stringify(validEvidence()), { mode: 0o600 });
  const output = execFileSync(process.execPath, ["scripts/v4-operations-report.mjs", input], { cwd: process.cwd(), encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), validateOperationsEvidence(validEvidence()));
  const link = path.join(directory, "evidence-link.json");
  await symlink(input, link);
  assert.throws(() => execFileSync(process.execPath, ["scripts/v4-operations-report.mjs", link], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" }), /input_file_invalid/);
});
