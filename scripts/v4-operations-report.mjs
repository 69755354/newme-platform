import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const HOMOGENEOUS_HEX = /^(?:([0-9a-f])\1{39}|([0-9a-f])\2{63})$/i;

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

function reference(value, name) {
  const result = string(value, name, /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i);
  if (/(?:placeholder|todo|tbd|dummy|example|sample|fake)/i.test(result)) fail(`${name}_placeholder`);
  return result;
}

function digest(value, name, { sha = false } = {}) {
  const pattern = sha ? SHA : SHA256;
  const result = string(value, name, pattern);
  if (HOMOGENEOUS_HEX.test(result)) fail(`${name}_placeholder`);
  return result;
}

function number(value, name, { integer = false, min = 0 } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    fail(`${name}_invalid`);
  }
  return value;
}

function utc(value, name) {
  string(value, name, ISO_UTC);
  const parsed = Date.parse(value);
  const canonical = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== canonical) fail(`${name}_invalid`);
  return parsed;
}

function quantiles(value, name) {
  const metrics = object(value, name);
  const p50 = number(metrics.p50, `${name}_p50`);
  const p95 = number(metrics.p95, `${name}_p95`);
  const p99 = number(metrics.p99, `${name}_p99`);
  if (p50 > p95 || p95 > p99) fail(`${name}_quantiles_out_of_order`);
  return { p50, p95, p99 };
}

function exactNumber(actual, expected, name) {
  if (Math.abs(actual - expected) > 0.000001) fail(`${name}_mismatch`);
}

/**
 * Validate an aggregate-only SAM-86 release evidence report. It does not
 * create backups, targets, traffic, alerts, or telemetry; it only refuses to
 * summarize evidence unless every runtime, restore and load claim is bound to
 * one exact immutable release.
 */
export function validateOperationsEvidence(input) {
  const evidence = object(input, "evidence");
  if (evidence.schema_version !== 2) fail("schema_version_unsupported");

  const release = object(evidence.release, "release");
  const gitSha = digest(release.git_sha, "release_git_sha", { sha: true });
  const treeSha = digest(release.tree_sha, "release_tree_sha", { sha: true });
  const artifactSha = digest(release.artifact_sha256, "release_artifact_sha256");
  const manifestSha = digest(release.manifest_sha256, "release_manifest_sha256");
  for (const field of ["manifest_git_sha", "runtime_git_sha", "active_release_sha", "rollback_release_sha"]) {
    digest(release[field], `release_${field}`, { sha: true });
  }
  const observedAt = utc(release.observed_at, "release_observed_at");
  if (gitSha !== release.manifest_git_sha || gitSha !== release.runtime_git_sha || gitSha !== release.active_release_sha) {
    fail("release_provenance_mismatch");
  }
  if (release.rollback_release_sha === release.active_release_sha) fail("release_rollback_not_distinct");

  const health = object(evidence.health, "health");
  if (health.http_status !== 200 || health.status !== "ok") fail("health_not_ok");
  if (digest(health.release_sha, "health_release_sha", { sha: true }) !== gitSha) fail("health_release_provenance_mismatch");
  const healthAt = utc(health.observed_at, "health_observed_at");

  const readiness = object(evidence.readiness, "readiness");
  if (readiness.http_status !== 200 || readiness.status !== "ready") fail("readiness_not_ready");
  if (digest(readiness.release_sha, "readiness_release_sha", { sha: true }) !== gitSha) fail("readiness_release_provenance_mismatch");
  number(readiness.latency_ms, "readiness_latency_ms");
  const readinessAt = utc(readiness.observed_at, "readiness_observed_at");
  if (healthAt > readinessAt || readinessAt > observedAt) fail("runtime_observation_timeline_invalid");

  const observation = object(evidence.observation, "observation");
  const startedAt = utc(observation.started_at, "observation_started_at");
  const endedAt = utc(observation.ended_at, "observation_ended_at");
  if (endedAt <= startedAt || endedAt < readinessAt) fail("observation_window_invalid");
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
    const ref = reference(item.tenant_ref, `tenant_${index}_ref`);
    if (tenantRefs.has(ref)) fail("tenant_observations_duplicate_ref");
    tenantRefs.add(ref);
    tenantRequests += number(item.requests, `tenant_${index}_requests`, { integer: true, min: 1 });
    number(item.errors, `tenant_${index}_errors`, { integer: true });
    if (item.errors > item.requests) fail(`tenant_${index}_errors_exceed_requests`);
    quantiles(item.latency_ms, `tenant_${index}_latency_ms`);
  }
  if (tenantRequests !== requests) fail("tenant_request_total_mismatch");

  const load = object(evidence.load, "load");
  reference(load.run_id, "load_run_id");
  if (digest(load.release_sha, "load_release_sha", { sha: true }) !== gitSha) fail("load_release_provenance_mismatch");
  digest(load.dataset_shape_sha256, "load_dataset_shape_sha256");
  if (number(load.tenants, "load_tenants", { integer: true, min: 2 }) !== observation.tenants.length) fail("load_tenant_count_mismatch");
  const duration = number(load.duration_seconds, "load_duration_seconds", { integer: true, min: 1 });
  number(load.concurrency, "load_concurrency", { integer: true, min: 1 });
  if (number(load.requests, "load_requests", { integer: true, min: 1 }) !== requests) fail("load_request_count_mismatch");
  if (number(load.errors, "load_errors", { integer: true }) !== errors) fail("load_error_count_mismatch");
  const loadLatency = quantiles(load.latency_ms, "load_latency_ms");
  if (JSON.stringify(loadLatency) !== JSON.stringify(latency)) fail("load_latency_summary_mismatch");
  exactNumber(number(load.throughput_per_second, "load_throughput_per_second"), requests / duration, "load_throughput");
  exactNumber(number(load.error_rate, "load_error_rate"), errors / requests, "load_error_rate");

  const noisyNeighbor = object(evidence.noisy_neighbor, "noisy_neighbor");
  const stressed = reference(noisyNeighbor.stressed_tenant_ref, "noisy_neighbor_stressed_tenant_ref");
  if (!Array.isArray(noisyNeighbor.collateral_tenant_refs) || noisyNeighbor.collateral_tenant_refs.length < 1) fail("noisy_neighbor_collateral_invalid");
  const collateral = new Set(noisyNeighbor.collateral_tenant_refs.map((ref, index) => reference(ref, `noisy_neighbor_collateral_${index}`)));
  if (collateral.size !== noisyNeighbor.collateral_tenant_refs.length || collateral.has(stressed)) fail("noisy_neighbor_tenant_set_invalid");
  if (number(noisyNeighbor.cross_tenant_leakage_count, "noisy_neighbor_cross_tenant_leakage_count", { integer: true }) !== 0) fail("noisy_neighbor_cross_tenant_leakage");
  if (noisyNeighbor.decision !== "accept") fail("noisy_neighbor_decision_not_safe");
  number(noisyNeighbor.max_safe_concurrency, "noisy_neighbor_max_safe_concurrency", { integer: true, min: 1 });

  const alerts = object(evidence.alerts, "alerts");
  string(alerts.owner, "alerts_owner", /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  reference(alerts.rule_ref, "alerts_rule_ref");
  reference(alerts.route_ref, "alerts_route_ref");
  reference(alerts.stimulus_ref, "alerts_stimulus_ref");
  const triggeredAt = utc(alerts.triggered_at, "alerts_triggered_at");
  const deliveredAt = utc(alerts.delivered_at, "alerts_delivered_at");
  const acknowledgedAt = utc(alerts.acknowledged_at, "alerts_acknowledged_at");
  if (triggeredAt < readinessAt || triggeredAt > deliveredAt || deliveredAt > acknowledgedAt) fail("alerts_timeline_invalid");
  if (number(alerts.delivery_latency_ms, "alerts_delivery_latency_ms", { integer: true }) !== deliveredAt - triggeredAt) fail("alerts_delivery_latency_mismatch");
  if (!Array.isArray(alerts.channels) || alerts.channels.length === 0 || alerts.channels.some((channel) => typeof channel !== "string" || !channel.trim())) {
    fail("alerts_channels_invalid");
  }

  const restore = object(evidence.restore, "restore");
  reference(restore.backup_id, "restore_backup_id");
  reference(restore.isolated_target_id, "restore_isolated_target_id");
  if (restore.backup_id === restore.isolated_target_id) fail("restore_target_not_isolated");
  digest(restore.backup_metadata_sha256, "restore_backup_metadata_sha256");
  digest(restore.pitr_metadata_sha256, "restore_pitr_metadata_sha256");
  const recoveryPointAt = utc(restore.recovery_point_at, "restore_recovery_point_at");
  const failureAt = utc(restore.failure_at, "restore_failure_at");
  const backupAt = utc(restore.backup_completed_at, "restore_backup_completed_at");
  const restoreStartedAt = utc(restore.started_at, "restore_started_at");
  const restoreCompletedAt = utc(restore.completed_at, "restore_completed_at");
  const destroyedAt = utc(restore.destroyed_at, "restore_destroyed_at");
  if (!(recoveryPointAt <= failureAt && failureAt <= backupAt && backupAt <= restoreStartedAt && restoreStartedAt <= restoreCompletedAt && restoreCompletedAt <= destroyedAt)) {
    fail("restore_timeline_invalid");
  }
  const rpo = number(restore.rpo_seconds, "restore_rpo_seconds", { integer: true });
  const rto = number(restore.rto_seconds, "restore_rto_seconds", { integer: true });
  if (rpo !== Math.round((failureAt - recoveryPointAt) / 1000) || rto !== Math.round((restoreCompletedAt - restoreStartedAt) / 1000)) fail("restore_measurement_mismatch");
  const before = digest(restore.before_aggregate_sha256, "restore_before_aggregate_sha256");
  const after = digest(restore.after_aggregate_sha256, "restore_after_aggregate_sha256");
  if (before !== after) fail("restore_aggregate_hash_mismatch");
  if (restore.verified !== true) fail("restore_not_verified");

  const largestTenantShare = Math.max(...observation.tenants.map((tenant) => tenant.requests / requests));
  return {
    schema_version: 2,
    release_sha: gitSha,
    tree_sha: treeSha,
    artifact_sha256: artifactSha,
    manifest_sha256: manifestSha,
    observed_at: release.observed_at,
    error_rate: errors / requests,
    latency_ms: latency,
    queue_delay_ms: queue,
    tenant_count: observation.tenants.length,
    largest_tenant_request_share: largestTenantShare,
    load: { run_id: load.run_id, throughput_per_second: load.throughput_per_second, error_rate: load.error_rate },
    restore: { rpo_seconds: rpo, rto_seconds: rto },
    alerts: { owner: alerts.owner, delivery_latency_ms: alerts.delivery_latency_ms },
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
  const stat = await fs.lstat(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 1024 * 1024) fail("input_file_invalid");
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
