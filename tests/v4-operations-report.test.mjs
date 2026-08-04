import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateOperationsEvidence } from "../scripts/v4-operations-report.mjs";

const SHA = "a".repeat(40);
const ROLLBACK = "b".repeat(40);
const ARTIFACT = "c".repeat(64);

function validEvidence() {
  return {
    schema_version: 1,
    release: {
      git_sha: SHA,
      artifact_sha256: ARTIFACT,
      manifest_git_sha: SHA,
      runtime_git_sha: SHA,
      active_release_sha: SHA,
      rollback_release_sha: ROLLBACK,
      observed_at: "2026-08-05T00:00:00Z",
    },
    health: { http_status: 200, status: "ok" },
    readiness: { http_status: 200, status: "ready", latency_ms: 12 },
    observation: {
      started_at: "2026-08-05T00:00:00Z",
      ended_at: "2026-08-05T00:05:00Z",
      requests: 10,
      errors: 1,
      latency_ms: { p50: 5, p95: 10, p99: 12 },
      queue_delay_ms: { p50: 1, p95: 2, p99: 3 },
      tenants: [
        { tenant_ref: "tenant-a", requests: 6, errors: 1, latency_ms: { p50: 5, p95: 10, p99: 12 } },
        { tenant_ref: "tenant-b", requests: 4, errors: 0, latency_ms: { p50: 4, p95: 9, p99: 11 } },
      ],
    },
    alerts: { owner: "platform-operations", delivery_verified_at: "2026-08-05T00:06:00Z", channels: ["staging-test"] },
    restore: {
      backup_id: "backup-20260805",
      isolated_target_id: "restore-synthetic-20260805",
      backup_completed_at: "2026-08-05T00:00:00Z",
      started_at: "2026-08-05T00:01:00Z",
      completed_at: "2026-08-05T00:03:00Z",
      destroyed_at: "2026-08-05T00:04:00Z",
      rpo_seconds: 60,
      rto_seconds: 120,
      verified: true,
    },
  };
}

test("accepts measured multi-tenant operational evidence without inventing an SLO target", () => {
  const result = validateOperationsEvidence(validEvidence());
  assert.equal(result.release_sha, SHA);
  assert.equal(result.error_rate, 0.1);
  assert.equal(result.tenant_count, 2);
  assert.equal(result.largest_tenant_request_share, 0.6);
  assert.deepEqual(result.restore, { rpo_seconds: 60, rto_seconds: 120 });
});

test("fails closed on release-provenance drift", () => {
  const input = validEvidence();
  input.release.runtime_git_sha = ROLLBACK;
  assert.throws(() => validateOperationsEvidence(input), /release_provenance_mismatch/);
});

test("fails closed when noisy-neighbor evidence is not actually multi-tenant", () => {
  const input = validEvidence();
  input.observation.tenants.pop();
  input.observation.requests = 6;
  assert.throws(() => validateOperationsEvidence(input), /tenant_observations_insufficient/);
});

test("fails closed on invalid metric and restore evidence", () => {
  const input = validEvidence();
  input.observation.latency_ms = { p50: 10, p95: 5, p99: 12 };
  assert.throws(() => validateOperationsEvidence(input), /latency_ms_quantiles_out_of_order/);

  const restore = validEvidence();
  restore.restore.isolated_target_id = restore.restore.backup_id;
  assert.throws(() => validateOperationsEvidence(restore), /restore_target_not_isolated/);
});

test("CLI emits only the derived operational summary", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "newme-sam86-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "evidence.json");
  await writeFile(input, JSON.stringify(validEvidence()));
  const output = execFileSync(process.execPath, ["scripts/v4-operations-report.mjs", input], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(output), validateOperationsEvidence(validEvidence()));
});
