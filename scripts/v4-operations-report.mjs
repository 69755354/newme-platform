import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`v4_operations_evidence_invalid:${message}`);
}

function object(value, name) {
  if (!value || Array.isArray(value) || typeof value !== "object") fail(`${name}_must_be_object`);
  return value;
}

function string(value, name, pattern = /\S/) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${name}_invalid`);
  return value;
}

function number(value, name, { integer = false, min = 0 } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    fail(`${name}_invalid`);
  }
  return value;
}

function utc(value, name) {
  string(value, name, ISO_UTC);
  if (Number.isNaN(Date.parse(value))) fail(`${name}_invalid`);
  return value;
}

function quantiles(value, name) {
  const metrics = object(value, name);
  const p50 = number(metrics.p50, `${name}_p50`);
  const p95 = number(metrics.p95, `${name}_p95`);
  const p99 = number(metrics.p99, `${name}_p99`);
  if (p50 > p95 || p95 > p99) fail(`${name}_quantiles_out_of_order`);
  return { p50, p95, p99 };
}

/**
 * Validate the evidence shape used to make a V4 operational release decision.
 * This intentionally records measurements and provenance only: it never invents
 * SLO thresholds that have not yet been approved from a pilot baseline.
 */
export function validateOperationsEvidence(input) {
  const evidence = object(input, "evidence");
  if (evidence.schema_version !== 1) fail("schema_version_unsupported");

  const release = object(evidence.release, "release");
  for (const field of ["git_sha", "manifest_git_sha", "runtime_git_sha", "active_release_sha", "rollback_release_sha"]) {
    string(release[field], `release_${field}`, SHA);
  }
  string(release.artifact_sha256, "release_artifact_sha256", SHA256);
  utc(release.observed_at, "release_observed_at");
  if (release.git_sha !== release.manifest_git_sha || release.git_sha !== release.runtime_git_sha || release.git_sha !== release.active_release_sha) {
    fail("release_provenance_mismatch");
  }
  if (release.rollback_release_sha === release.active_release_sha) fail("release_rollback_not_distinct");

  const health = object(evidence.health, "health");
  if (health.http_status !== 200 || health.status !== "ok") fail("health_not_ok");
  const readiness = object(evidence.readiness, "readiness");
  if (readiness.http_status !== 200 || readiness.status !== "ready") fail("readiness_not_ready");
  number(readiness.latency_ms, "readiness_latency_ms");

  const observation = object(evidence.observation, "observation");
  const startedAt = utc(observation.started_at, "observation_started_at");
  const endedAt = utc(observation.ended_at, "observation_ended_at");
  if (Date.parse(endedAt) <= Date.parse(startedAt)) fail("observation_window_invalid");
  const requests = number(observation.requests, "observation_requests", { integer: true, min: 1 });
  const errors = number(observation.errors, "observation_errors", { integer: true });
  if (errors > requests) fail("observation_errors_exceed_requests");
  const latency = quantiles(observation.latency_ms, "latency_ms");
  const queue = quantiles(observation.queue_delay_ms, "queue_delay_ms");

  if (!Array.isArray(observation.tenants) || observation.tenants.length < 2) fail("tenant_observations_insufficient");
  let tenantRequests = 0;
  const tenantRefs = new Set();
  for (const [index, tenant] of observation.tenants.entries()) {
    const item = object(tenant, `tenant_${index}`);
    const ref = string(item.tenant_ref, `tenant_${index}_ref`);
    if (tenantRefs.has(ref)) fail("tenant_observations_duplicate_ref");
    tenantRefs.add(ref);
    tenantRequests += number(item.requests, `tenant_${index}_requests`, { integer: true, min: 1 });
    number(item.errors, `tenant_${index}_errors`, { integer: true });
    if (item.errors > item.requests) fail(`tenant_${index}_errors_exceed_requests`);
    quantiles(item.latency_ms, `tenant_${index}_latency_ms`);
  }
  if (tenantRequests !== requests) fail("tenant_request_total_mismatch");

  const alerts = object(evidence.alerts, "alerts");
  string(alerts.owner, "alerts_owner", /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  utc(alerts.delivery_verified_at, "alerts_delivery_verified_at");
  if (!Array.isArray(alerts.channels) || alerts.channels.length === 0 || alerts.channels.some((channel) => typeof channel !== "string" || !channel.trim())) {
    fail("alerts_channels_invalid");
  }

  const restore = object(evidence.restore, "restore");
  string(restore.backup_id, "restore_backup_id");
  string(restore.isolated_target_id, "restore_isolated_target_id");
  if (restore.backup_id === restore.isolated_target_id) fail("restore_target_not_isolated");
  const backupAt = utc(restore.backup_completed_at, "restore_backup_completed_at");
  const restoreStartedAt = utc(restore.started_at, "restore_started_at");
  const restoreCompletedAt = utc(restore.completed_at, "restore_completed_at");
  utc(restore.destroyed_at, "restore_destroyed_at");
  if (Date.parse(restoreStartedAt) < Date.parse(backupAt) || Date.parse(restoreCompletedAt) < Date.parse(restoreStartedAt)) {
    fail("restore_timeline_invalid");
  }
  number(restore.rpo_seconds, "restore_rpo_seconds", { integer: true });
  number(restore.rto_seconds, "restore_rto_seconds", { integer: true });
  if (restore.verified !== true) fail("restore_not_verified");

  const largestTenantShare = Math.max(...observation.tenants.map((tenant) => tenant.requests / requests));
  return {
    schema_version: 1,
    release_sha: release.git_sha,
    observed_at: release.observed_at,
    error_rate: errors / requests,
    latency_ms: latency,
    queue_delay_ms: queue,
    tenant_count: observation.tenants.length,
    largest_tenant_request_share: largestTenantShare,
    restore: { rpo_seconds: restore.rpo_seconds, rto_seconds: restore.rto_seconds },
  };
}

async function main() {
  const [inputPath] = process.argv.slice(2);
  if (!inputPath || process.argv.length !== 3) {
    console.error("usage: node scripts/v4-operations-report.mjs <evidence.json>");
    process.exitCode = 64;
    return;
  }
  const absolutePath = path.resolve(inputPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("input_json_invalid");
  }
  process.stdout.write(`${JSON.stringify(validateOperationsEvidence(parsed))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "v4_operations_evidence_invalid:unknown_error");
    process.exitCode = 1;
  });
}
