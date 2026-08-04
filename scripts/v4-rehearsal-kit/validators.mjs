import { createHash } from "node:crypto";
import { evidenceSchemas, schemaNames } from "./schemas.mjs";

const SHA1 = /^[0-9a-f]{40}$/;
const ISO_UTC_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const ISO_UTC = new RegExp(ISO_UTC_PATTERN);
const SENSITIVE_FIELDS = new Set([
  "identifier", "name", "email", "phone", "address", "document", "free_text",
]);
const MASKING_TRANSFORMS = new Set(["tokenize", "hash", "redact", "drop"]);
const REQUIRED_CHANNELS = ["email", "messaging", "webhook", "portal", "payment"];
const REQUIRED_DESTRUCTION = ["database", "storage", "credentials", "logs", "exports", "access"];
const SAFE_SENSITIVE_METADATA_KEYS = new Set([
  "credentialrefs", "payloadredacted", "productioncredentialsdenied", "secretsincluded",
]);
const FORBIDDEN_STRING_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?(?:PRIVATE KEY|CERTIFICATE)-----/i,
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\//i,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|sbp_[A-Za-z0-9]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|SK[0-9a-f]{32})\b/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /(?:^|[?&;,\s{])(?:api[_-]?key|private[_-]?key|access[_-]?key|service(?:[_-]?role)?[_-]?key|password|passphrase|credential|bearer|secret|token|cert(?:ificate)?)\s*[:=]\s*["']?[^\s"'&,;}]{6,}/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];
const PLACEHOLDER_REFERENCE = /(?:^|[-_.:/])(?:placeholder|todo|tbd|dummy|example|sample|fake)(?:$|[-_.:/])/i;
const HOMOGENEOUS_HEX = /^(?:([0-9a-f])\1{39}|([0-9a-f])\2{63})$/i;

export class V4ValidationError extends Error {
  constructor(code, path = "$") {
    super(`${code}:${path}`);
    this.name = "V4ValidationError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, path = "$") {
  throw new V4ValidationError(code, path);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function stableDigest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function typeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return plainObject(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateSchema(value, schema, path = "$") {
  const acceptedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!acceptedTypes.some((type) => typeMatches(value, type))) fail("schema_type_invalid", path);
  if (value === null) return;
  if (Object.hasOwn(schema, "const") && value !== schema.const) fail("schema_const_invalid", path);
  if (schema.enum && !schema.enum.includes(value)) fail("schema_enum_invalid", path);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail("schema_string_too_short", path);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail("schema_pattern_invalid", path);
    if (schema.pattern === ISO_UTC_PATTERN && !strictUtcTimestamp(value)) fail("schema_timestamp_invalid", path);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail("schema_minimum_invalid", path);
    if (schema.maximum !== undefined && value > schema.maximum) fail("schema_maximum_invalid", path);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail("schema_min_items_invalid", path);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail("schema_max_items_invalid", path);
    if (schema.uniqueItems) {
      const keys = value.map((item) => JSON.stringify(stable(item)));
      if (new Set(keys).size !== keys.length) fail("schema_unique_items_invalid", path);
    }
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
  }
  if (plainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail("schema_required_missing", `${path}.${key}`);
    }
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      fail("schema_min_properties_invalid", path);
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) {
        validateSchema(child, schema.properties[key], `${path}.${key}`);
      } else if (plainObject(schema.additionalProperties)) {
        validateSchema(child, schema.additionalProperties, `${path}.${key}`);
      } else if (schema.additionalProperties === false) {
        fail("schema_unknown_property", `${path}.${key}`);
      }
    }
  }
}

function forbiddenSensitiveKey(key) {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (normalized.endsWith("ref") || normalized.endsWith("refs") || SAFE_SENSITIVE_METADATA_KEYS.has(normalized)) return false;
  return /^(?:secret|secrets|secretkey|clientsecret|webhooksecret|password|passwd|pwd|passphrase|token|accessToken|refreshToken|idToken|sessionToken|authToken|bearer|bearerToken|authorization|cookie|setCookie|apiKey|privateKey|accessKey|accessKeyId|serviceKey|serviceRoleKey|connectionString|databaseUrl|credential|credentials|certificate|cert|tlsCert|sslCert|clientCert|clientCertificate|rootCert|rootCertificate|certPem|rawValue|rawRecord|rawRows|payload|body|content)$/i.test(normalized);
}

function scanSensitiveMaterial(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitiveMaterial(item, `${path}[${index}]`));
    return;
  }
  if (plainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenSensitiveKey(key)) fail("forbidden_sensitive_key", `${path}.${key}`);
      for (const pattern of FORBIDDEN_STRING_PATTERNS) {
        if (pattern.test(key)) fail("forbidden_sensitive_value", `${path}.${key}`);
      }
      scanSensitiveMaterial(child, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    for (const pattern of FORBIDDEN_STRING_PATTERNS) {
      if (pattern.test(value)) fail("forbidden_sensitive_value", path);
    }
  }
}

function strictUtcTimestamp(value) {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  return new Date(parsed).toISOString() === canonical;
}

function scanEvidenceAuthenticity(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanEvidenceAuthenticity(item, `${path}[${index}]`));
    return;
  }
  if (plainObject(value)) {
    for (const [key, child] of Object.entries(value)) scanEvidenceAuthenticity(child, `${path}.${key}`);
    return;
  }
  if (typeof value !== "string") return;
  if (HOMOGENEOUS_HEX.test(value)) fail("evidence_placeholder_digest", path);
  if (PLACEHOLDER_REFERENCE.test(value)) fail("evidence_placeholder_reference", path);
}

function exactSet(values, expected, code, path) {
  const actual = [...values].sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(code, path);
}

function unique(values, code, path) {
  if (new Set(values).size !== values.length) fail(code, path);
}

function timestamp(value, code, path) {
  if (!strictUtcTimestamp(value)) fail(code, path);
  const parsed = Date.parse(value);
  return parsed;
}

function closeEnough(actual, expected, tolerance = 0.01) {
  return Math.abs(actual - expected) <= tolerance;
}

function requireExecutionStatus(document, executed, path) {
  const expected = executed ? "executed" : "not_executed";
  if (document.executionStatus !== expected) fail("execution_status_mismatch", `${path}.executionStatus`);
}

function validateClone(clone, executed) {
  const expiresAt = timestamp(clone.approval.expiresAt, "clone_expiry_invalid", "$.clone.approval.expiresAt");
  const destroyBy = timestamp(clone.retention.destroyBy, "clone_destroy_by_invalid", "$.clone.retention.destroyBy");
  if (expiresAt !== destroyBy) fail("clone_retention_mismatch", "$.clone.retention.destroyBy");
  if (!executed) {
    if (clone.approval.status !== "pending" || clone.approval.approvedAt !== null) fail("template_clone_approval_invalid", "$.clone.approval");
    if (Object.values(clone.execution).some((value) => value !== null)) fail("template_clone_timestamps_present", "$.clone.execution");
    return;
  }
  if (clone.approval.status !== "approved") fail("clone_not_approved", "$.clone.approval.status");
  const approvedAt = timestamp(clone.approval.approvedAt, "clone_approved_at_invalid", "$.clone.approval.approvedAt");
  const createdAt = timestamp(clone.execution.createdAt, "clone_created_at_invalid", "$.clone.execution.createdAt");
  const maskedAt = timestamp(clone.execution.maskedAt, "clone_masked_at_invalid", "$.clone.execution.maskedAt");
  const accessAt = timestamp(clone.execution.applicationAccessEnabledAt, "clone_access_at_invalid", "$.clone.execution.applicationAccessEnabledAt");
  if (!(approvedAt <= createdAt && createdAt <= maskedAt && maskedAt < accessAt && accessAt < expiresAt)) {
    fail("clone_timeline_invalid", "$.clone");
  }
}

function validateMapping(mapping) {
  const tableRefs = [];
  const targetRefs = [];
  for (const [tableIndex, table] of mapping.tables.entries()) {
    tableRefs.push(`${table.sourceTable}->${table.targetTable}`);
    const sourceFields = [];
    for (const [fieldIndex, field] of table.fields.entries()) {
      const path = `$.mapping.tables[${tableIndex}].fields[${fieldIndex}]`;
      sourceFields.push(field.sourceField);
      if (field.transformation === "drop") {
        if (field.targetField !== null) fail("dropped_field_has_target", `${path}.targetField`);
      } else if (field.targetField === null) fail("mapped_field_target_missing", `${path}.targetField`);
      if (SENSITIVE_FIELDS.has(field.sensitivity) && !MASKING_TRANSFORMS.has(field.transformation)) {
        fail("sensitive_field_not_masked", path);
      }
      if (field.sensitivity === "identifier" && field.preserveJoinKey && !["tokenize", "hash"].includes(field.transformation)) {
        fail("join_identifier_not_stably_masked", path);
      }
      if (["financial", "audit"].includes(field.sensitivity)) {
        if (!field.preserveSemantic || ["drop", "redact", "constant"].includes(field.transformation)) {
          fail("immutable_fact_not_preserved", path);
        }
      }
      if (field.targetField !== null) targetRefs.push(`${table.targetTable}.${field.targetField}`);
    }
    unique(sourceFields, "duplicate_source_field", `$.mapping.tables[${tableIndex}].fields`);
  }
  unique(tableRefs, "duplicate_table_mapping", "$.mapping.tables");
  unique(targetRefs, "duplicate_target_field", "$.mapping.tables");
  const expectedDigest = stableDigest({
    aggregateOnly: mapping.aggregateOnly,
    rawSamplesIncluded: mapping.rawSamplesIncluded,
    tables: mapping.tables,
  });
  if (mapping.mappingDigest !== expectedDigest) fail("mapping_manifest_digest_mismatch", "$.mapping.mappingDigest");
}

function validateOutbound(outbound, executed) {
  exactSet(outbound.channels.map((entry) => entry.channel), REQUIRED_CHANNELS, "outbound_channel_set_invalid", "$.outboundDisable.channels");
  for (const [index, entry] of outbound.channels.entries()) {
    const path = `$.outboundDisable.channels[${index}]`;
    exactSet(entry.controls, ["configuration-deny", "network-deny", "runtime-deny"], "outbound_controls_incomplete", `${path}.controls`);
    if (!executed) {
      if (entry.verification.status !== "not_executed" || entry.verification.checkedAt !== null || entry.verification.evidenceDigest !== null) {
        fail("template_outbound_verification_invalid", `${path}.verification`);
      }
    } else if (entry.verification.status !== "blocked" || entry.verification.checkedAt === null || entry.verification.evidenceDigest === null) {
      fail("outbound_not_proven_blocked", `${path}.verification`);
    }
  }
}

function validateMigration(migration, mapping, executed) {
  if (mapping && migration.mappingDigest !== mapping.mappingDigest) fail("mapping_digest_mismatch", "$.migration.mappingDigest");
  unique(migration.migrations.map((entry) => entry.migrationId), "duplicate_migration", "$.migration.migrations");
  const count = migration.migrations.length;
  exactSet(migration.migrations.map((entry) => entry.applyOrder), Array.from({ length: count }, (_, i) => i + 1), "migration_apply_order_invalid", "$.migration.migrations");
  exactSet(migration.migrations.map((entry) => entry.rollbackOrder), Array.from({ length: count }, (_, i) => i + 1), "migration_rollback_order_invalid", "$.migration.migrations");
  for (const [index, entry] of migration.migrations.entries()) {
    if (entry.rollbackOrder !== count - entry.applyOrder + 1) fail("migration_rollback_not_reverse_order", `$.migration.migrations[${index}]`);
    const expected = executed ? "passed" : "not_executed";
    if (entry.applyStatus !== expected || entry.rollbackStatus !== expected) fail("migration_status_invalid", `$.migration.migrations[${index}]`);
  }
  let quarantined = 0;
  for (const [index, job] of migration.backfills.entries()) {
    if (job.sourceCount !== job.migratedCount + job.quarantinedCount) fail("backfill_count_mismatch", `$.migration.backfills[${index}]`);
    if (job.status !== (executed ? "passed" : "not_executed")) fail("backfill_status_invalid", `$.migration.backfills[${index}].status`);
    quarantined += job.quarantinedCount;
  }
  const reasonTotal = migration.quarantine.reasons.reduce((sum, reason) => sum + reason.count, 0);
  if (quarantined !== migration.quarantine.total || reasonTotal !== migration.quarantine.total) fail("quarantine_count_mismatch", "$.migration.quarantine");
  unique(migration.quarantine.reasons.map((entry) => entry.reasonCode), "duplicate_quarantine_reason", "$.migration.quarantine.reasons");
  unique(migration.reconciliation.map((entry) => entry.entity), "duplicate_reconciliation_entity", "$.migration.reconciliation");
  for (const [index, entity] of migration.reconciliation.entries()) {
    if (entity.sourceCount !== entity.targetCount + entity.quarantinedCount) fail("reconciliation_count_mismatch", `$.migration.reconciliation[${index}]`);
    if (entity.beforeDigest !== entity.afterDigest) fail("reconciliation_hash_mismatch", `$.migration.reconciliation[${index}]`);
    if (entity.status !== (executed ? "passed" : "not_executed")) fail("reconciliation_status_invalid", `$.migration.reconciliation[${index}].status`);
  }
}

function validateDestruction(destruction, executed) {
  exactSet(destruction.resources.map((entry) => entry.kind), REQUIRED_DESTRUCTION, "destruction_resource_set_invalid", "$.destruction.resources");
  unique(destruction.resources.map((entry) => entry.resourceRef), "duplicate_destruction_resource", "$.destruction.resources");
  for (const [index, resource] of destruction.resources.entries()) {
    const path = `$.destruction.resources[${index}]`;
    if (!executed) {
      if (resource.status !== "pending" || resource.completedAt !== null || resource.evidenceDigest !== null) fail("template_destruction_invalid", path);
      continue;
    }
    const expected = ["credentials", "access"].includes(resource.kind) ? "revoked" : "destroyed";
    if (resource.status !== expected || resource.completedAt === null || resource.evidenceDigest === null) fail("destruction_proof_incomplete", path);
  }
  if (executed && (destruction.verifiedByRef === null || destruction.verifiedAt === null)) fail("destruction_verifier_missing", "$.destruction");
  if (!executed && (destruction.verifiedByRef !== null || destruction.verifiedAt !== null)) fail("template_destruction_verifier_present", "$.destruction");
}

function validateProvenance(provenance, executed) {
  const { source, artifact, manifest, runtime } = provenance;
  if (manifest.gitSha !== source.gitSha || runtime.releaseSha !== source.gitSha || runtime.buildId !== source.gitSha) fail("provenance_git_chain_mismatch", "$.provenance");
  if (manifest.treeSha !== source.treeSha) fail("provenance_tree_chain_mismatch", "$.provenance.manifest.treeSha");
  if (manifest.artifactSha256 !== artifact.sha256 || runtime.artifactSha256 !== artifact.sha256) fail("provenance_artifact_chain_mismatch", "$.provenance");
  if (runtime.manifestSha256 !== manifest.sha256) fail("provenance_manifest_chain_mismatch", "$.provenance.runtime.manifestSha256");
  if (executed && (provenance.chainStatus !== "verified" || runtime.observedAt === null)) fail("provenance_not_verified", "$.provenance");
  if (!executed && (provenance.chainStatus !== "planned" || runtime.observedAt !== null)) fail("template_provenance_invalid", "$.provenance");
}

function validateServiceLevel(serviceLevel, executed) {
  const startedAt = timestamp(serviceLevel.window.startedAt, "slo_window_start_invalid", "$.serviceLevel.window.startedAt");
  const endedAt = timestamp(serviceLevel.window.endedAt, "slo_window_end_invalid", "$.serviceLevel.window.endedAt");
  if (endedAt <= startedAt || !closeEnough((endedAt - startedAt) / 60_000, serviceLevel.window.totalMinutes)) fail("slo_window_duration_mismatch", "$.serviceLevel.window");
  const { availability, errorBudget, latency } = serviceLevel;
  if (availability.goodMinutes > serviceLevel.window.totalMinutes) fail("slo_good_minutes_invalid", "$.serviceLevel.availability.goodMinutes");
  if (!closeEnough(availability.measuredPercent, availability.goodMinutes / serviceLevel.window.totalMinutes * 100)) fail("slo_availability_math_invalid", "$.serviceLevel.availability");
  const expectedBudget = serviceLevel.window.totalMinutes * (100 - availability.objectivePercent) / 100;
  if (!closeEnough(errorBudget.totalMinutes, expectedBudget) || !closeEnough(errorBudget.totalMinutes, errorBudget.consumedMinutes + errorBudget.remainingMinutes)) fail("error_budget_math_invalid", "$.serviceLevel.errorBudget");
  const breached = errorBudget.remainingMinutes <= 0 && errorBudget.consumedMinutes >= errorBudget.totalMinutes;
  if (errorBudget.breached !== breached) fail("error_budget_breach_mismatch", "$.serviceLevel.errorBudget.breached");
  const passes = availability.measuredPercent >= availability.objectivePercent && latency.measuredMs <= latency.objectiveMs && !breached;
  if (!executed && serviceLevel.decision !== "undetermined") fail("template_slo_decision_invalid", "$.serviceLevel.decision");
  if (executed && serviceLevel.decision !== (passes ? "pass" : "fail")) fail("slo_decision_mismatch", "$.serviceLevel.decision");
}

function validateRestore(restore, serviceLevel, executed) {
  if (serviceLevel && (restore.targets.rpoSeconds !== serviceLevel.recoveryTargets.rpoSeconds || restore.targets.rtoSeconds !== serviceLevel.recoveryTargets.rtoSeconds)) fail("restore_targets_mismatch", "$.restore.targets");
  if (!executed) {
    if (Object.values(restore.timeline).some((value) => value !== null) || restore.status !== "not_executed") fail("template_restore_invalid", "$.restore");
    return;
  }
  const recovery = timestamp(restore.timeline.recoveryPointAt, "restore_recovery_point_invalid", "$.restore.timeline.recoveryPointAt");
  const failure = timestamp(restore.timeline.failurePointAt, "restore_failure_point_invalid", "$.restore.timeline.failurePointAt");
  const started = timestamp(restore.timeline.restoreStartedAt, "restore_start_invalid", "$.restore.timeline.restoreStartedAt");
  const completed = timestamp(restore.timeline.restoreCompletedAt, "restore_end_invalid", "$.restore.timeline.restoreCompletedAt");
  if (!(recovery <= failure && failure <= started && started <= completed)) fail("restore_timeline_invalid", "$.restore.timeline");
  if (restore.measured.rpoSeconds !== Math.round((failure - recovery) / 1000) || restore.measured.rtoSeconds !== Math.round((completed - started) / 1000)) fail("restore_measurement_mismatch", "$.restore.measured");
  if (restore.validation.beforeDigest !== restore.validation.afterDigest) fail("restore_hash_mismatch", "$.restore.validation");
  const passes = restore.measured.rpoSeconds <= restore.targets.rpoSeconds && restore.measured.rtoSeconds <= restore.targets.rtoSeconds;
  if (restore.status !== (passes ? "passed" : "failed")) fail("restore_status_mismatch", "$.restore.status");
}

function validateLoad(load, executed) {
  const { p50, p95, p99, max } = load.latencyMs;
  if (!(p50 <= p95 && p95 <= p99 && p99 <= max)) fail("load_percentile_order_invalid", "$.load.latencyMs");
  if (load.errors.count > load.profile.requests || !closeEnough(load.errors.ratePercent, load.errors.count / load.profile.requests * 100)) fail("load_error_math_invalid", "$.load.errors");
  if (!closeEnough(load.throughputPerSecond, load.profile.requests / load.profile.durationSeconds)) fail("load_throughput_math_invalid", "$.load.throughputPerSecond");
  if (!executed && load.status !== "not_executed") fail("template_load_status_invalid", "$.load.status");
  if (executed) {
    const passes = load.latencyMs.p95 <= load.thresholds.maxP95Ms && load.errors.ratePercent <= load.thresholds.maxErrorRatePercent;
    if (load.status !== (passes ? "passed" : "failed")) fail("load_status_mismatch", "$.load.status");
  }
}

function validateNoisyNeighbor(noisy, executed) {
  exactSet(noisy.observations.map((entry) => entry.tenantRef), noisy.collateralTenantRefs, "noisy_neighbor_observation_set_invalid", "$.noisyNeighbor.observations");
  if (noisy.collateralTenantRefs.includes(noisy.stressedTenantRef)) fail("noisy_neighbor_tenant_overlap", "$.noisyNeighbor");
  let maxImpact = Number.NEGATIVE_INFINITY;
  let maxErrorRateDelta = Number.NEGATIVE_INFINITY;
  for (const [index, observation] of noisy.observations.entries()) {
    if (observation.baselineP95Ms <= 0) fail("noisy_neighbor_baseline_invalid", `$.noisyNeighbor.observations[${index}].baselineP95Ms`);
    const expected = (observation.concurrentP95Ms - observation.baselineP95Ms) / observation.baselineP95Ms * 100;
    if (!closeEnough(observation.impactPercent, expected)) fail("noisy_neighbor_impact_math_invalid", `$.noisyNeighbor.observations[${index}].impactPercent`);
    maxImpact = Math.max(maxImpact, observation.impactPercent);
    maxErrorRateDelta = Math.max(maxErrorRateDelta, observation.errorRateDeltaPercent);
  }
  if (!executed && noisy.capacityDecision.decision !== "undetermined") fail("template_capacity_decision_invalid", "$.noisyNeighbor.capacityDecision.decision");
  if (executed) {
    if (noisy.capacityDecision.maxSafeConcurrency <= 0) fail("capacity_safe_concurrency_invalid", "$.noisyNeighbor.capacityDecision.maxSafeConcurrency");
    const withinLimits = maxImpact <= noisy.maxAllowedP95ImpactPercent &&
      maxErrorRateDelta <= noisy.maxAllowedErrorRateDeltaPercent;
    const expected = noisy.crossTenantLeakageCount > 0 ? "reject" : withinLimits ? "accept" : null;
    if (expected && noisy.capacityDecision.decision !== expected) fail("capacity_decision_mismatch", "$.noisyNeighbor.capacityDecision.decision");
    if (!expected && !["limit", "reject"].includes(noisy.capacityDecision.decision)) fail("capacity_decision_mismatch", "$.noisyNeighbor.capacityDecision.decision");
  }
}

function validateAlert(alert, executed) {
  if (!executed) {
    if (Object.values(alert.timeline).some((value) => value !== null) || alert.status !== "not_executed") fail("template_alert_invalid", "$.alert");
    return;
  }
  const triggered = timestamp(alert.timeline.triggeredAt, "alert_triggered_at_invalid", "$.alert.timeline.triggeredAt");
  const delivered = timestamp(alert.timeline.deliveredAt, "alert_delivered_at_invalid", "$.alert.timeline.deliveredAt");
  const acknowledged = timestamp(alert.timeline.acknowledgedAt, "alert_acknowledged_at_invalid", "$.alert.timeline.acknowledgedAt");
  if (!(triggered <= delivered && delivered <= acknowledged)) fail("alert_timeline_invalid", "$.alert.timeline");
  if (alert.deliveryLatencyMs !== delivered - triggered) fail("alert_latency_mismatch", "$.alert.deliveryLatencyMs");
  const passes = alert.deliveryLatencyMs <= alert.maxDeliveryLatencyMs;
  if (alert.status !== (passes ? "passed" : "failed")) fail("alert_status_mismatch", "$.alert.status");
}

export function validateEvidenceDocument(schemaName, value) {
  if (!schemaNames.includes(schemaName) || schemaName === "bundle") fail("unknown_schema", `$.${schemaName}`);
  scanSensitiveMaterial(value);
  validateSchema(value, evidenceSchemas[schemaName]);
  const executed = value.executionStatus === "executed";
  if (executed) scanEvidenceAuthenticity(value);
  if (schemaName === "ephemeralClone") validateClone(value, executed);
  if (schemaName === "mapping") validateMapping(value);
  if (schemaName === "outboundDisable") validateOutbound(value, executed);
  if (schemaName === "migration") validateMigration(value, null, executed);
  if (schemaName === "destruction") validateDestruction(value, executed);
  if (schemaName === "provenance") validateProvenance(value, executed);
  if (schemaName === "serviceLevel") validateServiceLevel(value, executed);
  if (schemaName === "restore") validateRestore(value, null, executed);
  if (schemaName === "load") validateLoad(value, executed);
  if (schemaName === "noisyNeighbor") validateNoisyNeighbor(value, executed);
  if (schemaName === "alert") validateAlert(value, executed);
  return Object.freeze({ schemaVersion: 1, schemaName, status: "valid" });
}

export function validatePreparationBundle(bundle, options = {}) {
  scanSensitiveMaterial(bundle);
  validateSchema(bundle, evidenceSchemas.bundle);
  const expectedMode = options.expectedMode;
  if (expectedMode && bundle.mode !== expectedMode) fail("bundle_mode_mismatch", "$.mode");
  const executed = bundle.mode === "evidence";
  if (executed) scanEvidenceAuthenticity(bundle);
  if (bundle.claimsExecuted !== executed) fail("claims_execution_mismatch", "$.claimsExecuted");
  if (!executed) {
    if (bundle.evidenceState !== "target" || bundle.environmentClass !== "synthetic-local") fail("template_evidence_state_invalid", "$");
  } else {
    if (!["verified-current", "validated-staging", "validated-production"].includes(bundle.evidenceState)) fail("executed_evidence_state_invalid", "$.evidenceState");
    if (bundle.environmentClass === "synthetic-local" && options.allowSyntheticEvidence !== true) fail("synthetic_execution_not_evidence", "$.environmentClass");
    const expectedState = bundle.environmentClass === "staging"
      ? "validated-staging"
      : bundle.environmentClass === "production"
        ? "validated-production"
        : "verified-current";
    if (bundle.evidenceState !== expectedState) fail("environment_evidence_state_mismatch", "$.evidenceState");
  }
  exactSet(bundle.linearIds, ["SAM-85", "SAM-86"], "linear_id_set_invalid", "$.linearIds");
  const documents = ["clone", "mapping", "outboundDisable", "migration", "destruction", "provenance", "serviceLevel", "restore", "load", "noisyNeighbor", "alert"];
  for (const name of documents) {
    if (bundle[name].runId !== bundle.runId) fail("run_id_mismatch", `$.${name}.runId`);
    requireExecutionStatus(bundle[name], executed, `$.${name}`);
  }
  validateClone(bundle.clone, executed);
  validateMapping(bundle.mapping);
  validateOutbound(bundle.outboundDisable, executed);
  validateMigration(bundle.migration, bundle.mapping, executed);
  validateDestruction(bundle.destruction, executed);
  validateProvenance(bundle.provenance, executed);
  validateServiceLevel(bundle.serviceLevel, executed);
  validateRestore(bundle.restore, bundle.serviceLevel, executed);
  validateLoad(bundle.load, executed);
  validateNoisyNeighbor(bundle.noisyNeighbor, executed);
  validateAlert(bundle.alert, executed);
  const releaseSha = bundle.provenance.source.gitSha;
  for (const [name, value] of [["migration", bundle.migration], ["load", bundle.load], ["noisyNeighbor", bundle.noisyNeighbor], ["alert", bundle.alert]]) {
    if (!SHA1.test(value.releaseSha) || value.releaseSha !== releaseSha) fail("release_sha_cross_contract_mismatch", `$.${name}.releaseSha`);
  }
  if (executed) {
    const cloneCreatedAt = timestamp(bundle.clone.execution.createdAt, "clone_created_at_invalid", "$.clone.execution.createdAt");
    const accessAt = timestamp(bundle.clone.execution.applicationAccessEnabledAt, "clone_access_at_invalid", "$.clone.execution.applicationAccessEnabledAt");
    const destroyBy = timestamp(bundle.clone.retention.destroyBy, "clone_destroy_by_invalid", "$.clone.retention.destroyBy");
    for (const [index, entry] of bundle.outboundDisable.channels.entries()) {
      const checkedAt = timestamp(entry.verification.checkedAt, "outbound_checked_at_invalid", `$.outboundDisable.channels[${index}].verification.checkedAt`);
      if (checkedAt < cloneCreatedAt) fail("outbound_verified_before_clone_created", `$.outboundDisable.channels[${index}]`);
      if (checkedAt >= accessAt) fail("outbound_verified_after_access", `$.outboundDisable.channels[${index}]`);
    }
    const destroyedAt = Math.max(...bundle.destruction.resources.map((entry, index) => {
      const completedAt = timestamp(entry.completedAt, "destruction_completed_at_invalid", `$.destruction.resources[${index}].completedAt`);
      if (completedAt < accessAt) fail("destruction_before_application_access", `$.destruction.resources[${index}]`);
      if (completedAt > destroyBy) fail("destruction_after_deadline", `$.destruction.resources[${index}]`);
      return completedAt;
    }));
    if (timestamp(bundle.destruction.verifiedAt, "destruction_verified_at_invalid", "$.destruction.verifiedAt") < destroyedAt) fail("destruction_verified_too_early", "$.destruction.verifiedAt");
    const finalEvidenceAt = Math.max(
      timestamp(bundle.destruction.verifiedAt, "destruction_verified_at_invalid", "$.destruction.verifiedAt"),
      timestamp(bundle.provenance.runtime.observedAt, "runtime_observed_at_invalid", "$.provenance.runtime.observedAt"),
      timestamp(bundle.serviceLevel.window.endedAt, "slo_window_end_invalid", "$.serviceLevel.window.endedAt"),
      timestamp(bundle.restore.timeline.restoreCompletedAt, "restore_end_invalid", "$.restore.timeline.restoreCompletedAt"),
      timestamp(bundle.alert.timeline.acknowledgedAt, "alert_acknowledged_at_invalid", "$.alert.timeline.acknowledgedAt"),
    );
    if (timestamp(bundle.generatedAt, "bundle_generated_at_invalid", "$.generatedAt") < finalEvidenceAt) fail("bundle_generated_before_evidence_complete", "$.generatedAt");
  }
  const acceptanceFailed = executed && (
    bundle.serviceLevel.decision === "fail" || bundle.restore.status === "failed" ||
    bundle.load.status === "failed" || ["limit", "reject"].includes(bundle.noisyNeighbor.capacityDecision.decision) ||
    bundle.alert.status === "failed"
  );
  return Object.freeze({
    contract: bundle.contract,
    schemaVersion: 1,
    mode: bundle.mode,
    status: executed ? "valid-evidence" : "valid-template",
    acceptanceStatus: executed ? (acceptanceFailed ? "failed" : "passed") : "not_executed",
    claimsExecuted: bundle.claimsExecuted,
    environmentClass: bundle.environmentClass,
    runId: bundle.runId,
    linearIds: Object.freeze([...bundle.linearIds]),
  });
}
