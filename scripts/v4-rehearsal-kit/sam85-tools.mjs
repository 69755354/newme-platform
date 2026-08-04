import { createHmac } from "node:crypto";
import {
  V4ValidationError,
  stableDigest,
  validateSam85RehearsalBundle,
} from "./validators.mjs";

const OUTBOUND_ENV_KEYS = Object.freeze([
  "SMTP_URL",
  "SENDGRID_API_KEY",
  "RESEND_API_KEY",
  "TWILIO_AUTH_TOKEN",
  "WHATSAPP_ACCESS_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "WECOM_WEBHOOK_URL",
  "WEBHOOK_URL",
  "META_CAPI_ACCESS_TOKEN",
  "META_CAPI_WEBHOOK_SECRET",
  "HERMES_SENTRY_BRIDGE_URL",
  "HERMES_SENTRY_BRIDGE_TOKEN",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_SERVICE_HOOK_SECRET",
  "STRIPE_SECRET_KEY",
  "PAYPAL_CLIENT_SECRET",
  "PAYMENT_API_KEY",
  "PORTAL_API_KEY",
]);

const ALLOWED_TRANSFORMS = new Set(["copy", "tokenize", "hash", "redact", "drop", "constant"]);
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function fail(code) {
  throw new V4ValidationError(code);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactSet(actual, expected, code) {
  if (actual.length !== expected.length || [...actual].sort().some((value, index) => value !== [...expected].sort()[index])) fail(code);
}

function tokenKeyBytes(tokenKey) {
  const bytes = Buffer.isBuffer(tokenKey) ? tokenKey : Buffer.from(tokenKey ?? "");
  if (bytes.length < 32) fail("token_key_too_short");
  return bytes;
}

function hmac(value, tokenKey, namespace) {
  return createHmac("sha256", tokenKeyBytes(tokenKey))
    .update(namespace)
    .update("\0")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

export function tokenizeValue(value, tokenKey, namespace = "sam85") {
  if (value === null || value === undefined || value === "") fail("token_source_missing");
  return `tok_${hmac(value, tokenKey, namespace).slice(0, 32)}`;
}

export function assertOutboundKillSwitch(environment = process.env) {
  const present = OUTBOUND_ENV_KEYS.filter((key) => typeof environment[key] === "string" && environment[key].trim() !== "");
  if (present.length > 0) fail("outbound_environment_present");
  return Object.freeze({
    status: "blocked",
    channels: Object.freeze(["email", "messaging", "webhook", "portal", "payment"]),
    checkedEnvironmentKeys: Object.freeze([...OUTBOUND_ENV_KEYS]),
  });
}

function transformField(field, value, tokenKey, tableRef) {
  if (!ALLOWED_TRANSFORMS.has(field.transformation)) fail("mapping_transform_not_executable");
  switch (field.transformation) {
    case "copy":
      return value;
    case "tokenize":
      return tokenizeValue(value, tokenKey, `${tableRef}.${field.sourceField}`);
    case "hash":
      if (value === null || value === undefined || value === "") fail("hash_source_missing");
      return `hmac-sha256:${hmac(value, tokenKey, `${tableRef}.${field.sourceField}`)}`;
    case "redact":
      return "[REDACTED]";
    case "constant":
      return "[MASKED]";
    case "drop":
      return undefined;
    default:
      fail("mapping_transform_not_executable");
  }
}

function maskedRow(row, table, tokenKey) {
  if (!plainObject(row)) fail("source_record_not_plain_object");
  if (Object.keys(row).some((key) => PROTOTYPE_KEYS.has(key))) fail("source_record_prototype_key");
  const target = {};
  for (const field of table.fields) {
    if (PROTOTYPE_KEYS.has(field.sourceField) || (field.targetField !== null && PROTOTYPE_KEYS.has(field.targetField))) {
      fail("mapping_prototype_key");
    }
    const value = row[field.sourceField];
    if (field.transformation !== "drop" && (value === undefined || value === null)) fail("source_field_missing");
    const transformed = transformField(field, value, tokenKey, table.sourceTable);
    if (field.targetField !== null && transformed !== undefined) target[field.targetField] = transformed;
  }
  return target;
}

function sourceToken(row, tokenKey, tableRef) {
  return `row_${hmac(stableDigest(row), tokenKey, `${tableRef}.quarantine`).slice(0, 24)}`;
}

function sortRows(rows) {
  return [...rows].sort((left, right) => stableDigest(left).localeCompare(stableDigest(right)));
}

export function prepareMaskedRehearsal({ bundle, sourceByTable, tokenKey, environment = process.env }) {
  validateSam85RehearsalBundle(bundle, { expectedMode: "template" });
  assertOutboundKillSwitch(environment);
  if (!plainObject(sourceByTable)) fail("source_dataset_invalid");
  tokenKeyBytes(tokenKey);
  const expectedTables = bundle.mapping.tables.map((entry) => entry.sourceTable);
  exactSet(Object.keys(sourceByTable), expectedTables, "source_table_set_invalid");

  const targets = {};
  const tables = [];
  const quarantineReasons = new Map();
  const quarantineLedger = [];
  for (const table of bundle.mapping.tables) {
    const records = sourceByTable[table.sourceTable];
    if (!Array.isArray(records)) fail("source_table_records_invalid");
    const migrated = [];
    for (const row of records) {
      try {
        migrated.push(maskedRow(row, table, tokenKey));
      } catch (error) {
        if (!(error instanceof V4ValidationError)) throw error;
        quarantineReasons.set(error.code, (quarantineReasons.get(error.code) ?? 0) + 1);
        quarantineLedger.push(Object.freeze({
          sourceTable: table.sourceTable,
          sourceToken: plainObject(row) ? sourceToken(row, tokenKey, table.sourceTable) : `row_${hmac("invalid-shape", tokenKey, table.sourceTable).slice(0, 24)}`,
          reasonCode: error.code,
        }));
      }
    }
    const sorted = sortRows(migrated);
    targets[table.targetTable] = Object.freeze(sorted.map((row) => Object.freeze(row)));
    const sourceCount = records.length;
    const quarantinedCount = sourceCount - sorted.length;
    tables.push(Object.freeze({
      sourceTable: table.sourceTable,
      targetTable: table.targetTable,
      sourceCount,
      migratedCount: sorted.length,
      quarantinedCount,
      projectionBeforeDigest: stableDigest(sorted),
      projectionAfterDigest: stableDigest(targets[table.targetTable]),
    }));
  }
  const reasonCounts = [...quarantineReasons.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reasonCode, count]) => Object.freeze({ reasonCode, count }));
  const aggregateEvidence = Object.freeze({
    contract: "newme.v4.sam85-offline-masking-result.v1",
    schemaVersion: 1,
    runId: bundle.runId,
    claimsCloneExecuted: false,
    aggregateOnly: true,
    rawSourceRetained: false,
    mappingDigest: bundle.mapping.mappingDigest,
    tables: Object.freeze(tables),
    quarantine: Object.freeze({
      total: quarantineLedger.length,
      reasons: Object.freeze(reasonCounts),
      ledgerDigest: stableDigest(quarantineLedger),
    }),
  });
  return Object.freeze({
    targets: Object.freeze(targets),
    quarantineLedger: Object.freeze(quarantineLedger),
    aggregateEvidence,
  });
}

export function verifyAggregateReconciliation(result) {
  if (!plainObject(result) || !plainObject(result.aggregateEvidence) || !Array.isArray(result.aggregateEvidence.tables)) {
    fail("aggregate_evidence_invalid");
  }
  let quarantined = 0;
  for (const table of result.aggregateEvidence.tables) {
    if (table.sourceCount !== table.migratedCount + table.quarantinedCount) fail("backfill_count_mismatch");
    if (table.projectionBeforeDigest !== table.projectionAfterDigest) fail("reconciliation_hash_mismatch");
    quarantined += table.quarantinedCount;
  }
  if (quarantined !== result.aggregateEvidence.quarantine.total) fail("quarantine_count_mismatch");
  return Object.freeze({
    contract: result.aggregateEvidence.contract,
    runId: result.aggregateEvidence.runId,
    status: "reconciled",
    tableCount: result.aggregateEvidence.tables.length,
    quarantinedCount: quarantined,
  });
}
