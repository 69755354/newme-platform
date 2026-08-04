const ISO_UTC_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const SHA1_PATTERN = "^[0-9a-f]{40}$";
const SHA256_PATTERN = "^[0-9a-f]{64}$";
const SAFE_REF_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$";

const string = (extra = {}) => ({ type: "string", ...extra });
const nullableString = (extra = {}) => ({ type: ["string", "null"], ...extra });
const integer = (extra = {}) => ({ type: "integer", ...extra });
const number = (extra = {}) => ({ type: "number", ...extra });
const boolean = (extra = {}) => ({ type: "boolean", ...extra });
const array = (items, extra = {}) => ({ type: "array", items, ...extra });
const object = (properties, options = {}) => ({
  type: "object",
  properties,
  required: options.required ?? Object.keys(properties),
  additionalProperties: options.additionalProperties ?? false,
  ...(options.minProperties === undefined ? {} : { minProperties: options.minProperties }),
});
const contractHeader = (contract) => ({
  contract: string({ const: contract }),
  schemaVersion: integer({ const: 1 }),
  runId: string({ pattern: SAFE_REF_PATTERN }),
  executionStatus: string({ enum: ["not_executed", "executed"] }),
});
const isoUtc = () => string({ pattern: ISO_UTC_PATTERN });
const nullableIsoUtc = () => nullableString({ pattern: ISO_UTC_PATTERN });
const sha1 = () => string({ pattern: SHA1_PATTERN });
const sha256 = () => string({ pattern: SHA256_PATTERN });
const nullableSha256 = () => nullableString({ pattern: SHA256_PATTERN });
const safeRef = () => string({ pattern: SAFE_REF_PATTERN });
const nonNegativeInteger = () => integer({ minimum: 0 });
const positiveInteger = () => integer({ minimum: 1 });
const nonNegativeNumber = () => number({ minimum: 0 });
const percent = () => number({ minimum: 0, maximum: 100 });
const countMap = () => object({}, {
  required: [],
  additionalProperties: nonNegativeInteger(),
  minProperties: 1,
});

const ephemeralClone = object({
  ...contractHeader("newme.v4.ephemeral-clone-manifest.v1"),
  cloneRef: safeRef(),
  environmentClass: string({ const: "isolated-ephemeral-clone" }),
  sourceSnapshot: object({ snapshotRef: safeRef(), sha256: sha256(), encrypted: boolean({ const: true }) }),
  approval: object({
    status: string({ enum: ["pending", "approved"] }),
    purposeCode: safeRef(),
    scopeRef: safeRef(),
    ownerRef: safeRef(),
    accessRefs: array(safeRef(), { minItems: 1, uniqueItems: true }),
    approvedAt: nullableIsoUtc(),
    expiresAt: isoUtc(),
  }),
  networkBoundary: object({
    isolated: boolean({ const: true }),
    sharedStaging: boolean({ const: false }),
    productionWriteRoute: boolean({ const: false }),
  }),
  maskingBeforeApplicationAccess: boolean({ const: true }),
  credentialPolicy: object({
    cloneOnly: boolean({ const: true }),
    productionCredentialsDenied: boolean({ const: true }),
    credentialRefs: array(safeRef(), { minItems: 1, uniqueItems: true }),
  }),
  retention: object({ destroyBy: isoUtc() }),
  execution: object({
    createdAt: nullableIsoUtc(),
    maskedAt: nullableIsoUtc(),
    applicationAccessEnabledAt: nullableIsoUtc(),
  }),
});

const mappingField = object({
  sourceField: safeRef(),
  targetField: nullableString({ pattern: SAFE_REF_PATTERN }),
  sensitivity: string({
    enum: [
      "none", "identifier", "name", "email", "phone", "address",
      "document", "free_text", "financial", "audit",
    ],
  }),
  transformation: string({
    enum: ["copy", "tokenize", "hash", "redact", "drop", "constant", "derive"],
  }),
  preserveJoinKey: boolean(),
  preserveSemantic: boolean(),
});

const mapping = object({
  ...contractHeader("newme.v4.mapping-and-masking.v1"),
  mappingDigest: sha256(),
  aggregateOnly: boolean({ const: true }),
  rawSamplesIncluded: boolean({ const: false }),
  tables: array(object({
    sourceTable: safeRef(),
    targetTable: safeRef(),
    fields: array(mappingField, { minItems: 1 }),
  }), { minItems: 1 }),
});

const outboundDisable = object({
  ...contractHeader("newme.v4.outbound-disable.v1"),
  productionEndpointsPresent: boolean({ const: false }),
  productionCredentialsPresent: boolean({ const: false }),
  channels: array(object({
    channel: string({ enum: ["email", "messaging", "webhook", "portal", "payment"] }),
    enabled: boolean({ const: false }),
    controls: array(string({
      enum: ["configuration-deny", "network-deny", "runtime-deny"],
    }), { minItems: 2, uniqueItems: true }),
    verification: object({
      status: string({ enum: ["not_executed", "blocked", "failed"] }),
      checkedAt: nullableIsoUtc(),
      evidenceDigest: nullableSha256(),
    }),
  }), { minItems: 5, maxItems: 5 }),
});

const migration = object({
  ...contractHeader("newme.v4.migration-rehearsal-evidence.v1"),
  releaseSha: sha1(),
  mappingDigest: sha256(),
  migrations: array(object({
    migrationId: safeRef(),
    forwardSha256: sha256(),
    rollbackSha256: sha256(),
    applyOrder: positiveInteger(),
    rollbackOrder: positiveInteger(),
    applyStatus: string({ enum: ["not_executed", "passed", "failed"] }),
    rollbackStatus: string({ enum: ["not_executed", "passed", "failed"] }),
  }), { minItems: 1 }),
  backfills: array(object({
    jobRef: safeRef(),
    sourceCount: nonNegativeInteger(),
    migratedCount: nonNegativeInteger(),
    quarantinedCount: nonNegativeInteger(),
    batchCount: positiveInteger(),
    checkpointCount: positiveInteger(),
    status: string({ enum: ["not_executed", "passed", "failed"] }),
  }), { minItems: 1 }),
  quarantine: object({
    aggregateOnly: boolean({ const: true }),
    rawRecordsRetained: boolean({ const: false }),
    total: nonNegativeInteger(),
    aggregateDigest: sha256(),
    reasons: array(object({ reasonCode: safeRef(), count: positiveInteger() })),
  }),
  reconciliation: array(object({
    entity: safeRef(),
    sourceCount: nonNegativeInteger(),
    targetCount: nonNegativeInteger(),
    quarantinedCount: nonNegativeInteger(),
    projection: safeRef(),
    beforeDigest: sha256(),
    afterDigest: sha256(),
    status: string({ enum: ["not_executed", "passed", "failed"] }),
  }), { minItems: 1 }),
});

const destruction = object({
  ...contractHeader("newme.v4.destruction-proof.v1"),
  retainAggregateEvidenceOnly: boolean({ const: true }),
  rawDataRetained: boolean({ const: false }),
  resources: array(object({
    kind: string({ enum: ["database", "storage", "credentials", "logs", "exports", "access"] }),
    resourceRef: safeRef(),
    status: string({ enum: ["pending", "destroyed", "revoked", "failed"] }),
    completedAt: nullableIsoUtc(),
    evidenceDigest: nullableSha256(),
  }), { minItems: 6, maxItems: 6 }),
  verifiedByRef: nullableString({ pattern: SAFE_REF_PATTERN }),
  verifiedAt: nullableIsoUtc(),
});

const provenance = object({
  ...contractHeader("newme.v4.release-provenance.v1"),
  source: object({ repositoryRef: safeRef(), gitSha: sha1(), treeSha: sha1() }),
  artifact: object({ artifactRef: safeRef(), sha256: sha256(), immutable: boolean({ const: true }) }),
  manifest: object({
    sha256: sha256(),
    gitSha: sha1(),
    treeSha: sha1(),
    artifactSha256: sha256(),
  }),
  runtime: object({
    environmentRef: safeRef(),
    releaseSha: sha1(),
    buildId: sha1(),
    artifactSha256: sha256(),
    manifestSha256: sha256(),
    observedAt: nullableIsoUtc(),
  }),
  chainStatus: string({ enum: ["planned", "verified", "failed"] }),
});

const serviceLevel = object({
  ...contractHeader("newme.v4.service-level-evidence.v1"),
  serviceRef: safeRef(),
  tenantScopeRef: safeRef(),
  window: object({ startedAt: isoUtc(), endedAt: isoUtc(), totalMinutes: positiveInteger() }),
  availability: object({
    objectivePercent: percent(),
    measuredPercent: percent(),
    goodMinutes: nonNegativeInteger(),
  }),
  latency: object({
    statistic: string({ const: "p95" }),
    objectiveMs: positiveInteger(),
    measuredMs: nonNegativeNumber(),
  }),
  errorBudget: object({
    totalMinutes: nonNegativeNumber(),
    consumedMinutes: nonNegativeNumber(),
    remainingMinutes: nonNegativeNumber(),
    breached: boolean(),
  }),
  recoveryTargets: object({ rpoSeconds: nonNegativeInteger(), rtoSeconds: positiveInteger() }),
  decision: string({ enum: ["undetermined", "pass", "fail"] }),
});

const restore = object({
  ...contractHeader("newme.v4.restore-evidence.v1"),
  isolated: boolean({ const: true }),
  productionWriteRoute: boolean({ const: false }),
  environmentRef: safeRef(),
  backupRef: safeRef(),
  backupMetadataDigest: sha256(),
  pitrMetadataDigest: sha256(),
  timeline: object({
    recoveryPointAt: nullableIsoUtc(),
    failurePointAt: nullableIsoUtc(),
    restoreStartedAt: nullableIsoUtc(),
    restoreCompletedAt: nullableIsoUtc(),
  }),
  measured: object({ rpoSeconds: nonNegativeInteger(), rtoSeconds: nonNegativeInteger() }),
  targets: object({ rpoSeconds: nonNegativeInteger(), rtoSeconds: positiveInteger() }),
  validation: object({ counts: countMap(), beforeDigest: sha256(), afterDigest: sha256() }),
  status: string({ enum: ["not_executed", "passed", "failed"] }),
});

const load = object({
  ...contractHeader("newme.v4.load-evidence.v1"),
  releaseSha: sha1(),
  aggregateOnly: boolean({ const: true }),
  rawSamplesIncluded: boolean({ const: false }),
  dataset: object({ shapeDigest: sha256(), tenants: positiveInteger(), recordsByEntity: countMap() }),
  profile: object({ durationSeconds: positiveInteger(), concurrency: positiveInteger(), requests: positiveInteger() }),
  thresholds: object({ maxP95Ms: positiveInteger(), maxErrorRatePercent: percent() }),
  latencyMs: object({ p50: nonNegativeNumber(), p95: nonNegativeNumber(), p99: nonNegativeNumber(), max: nonNegativeNumber() }),
  throughputPerSecond: nonNegativeNumber(),
  errors: object({ count: nonNegativeInteger(), ratePercent: percent() }),
  status: string({ enum: ["not_executed", "passed", "failed"] }),
});

const noisyNeighbor = object({
  ...contractHeader("newme.v4.noisy-neighbor-evidence.v1"),
  releaseSha: sha1(),
  stressedTenantRef: safeRef(),
  collateralTenantRefs: array(safeRef(), { minItems: 1, uniqueItems: true }),
  maxAllowedP95ImpactPercent: nonNegativeNumber(),
  maxAllowedErrorRateDeltaPercent: nonNegativeNumber(),
  observations: array(object({
    tenantRef: safeRef(),
    baselineP95Ms: nonNegativeNumber(),
    concurrentP95Ms: nonNegativeNumber(),
    impactPercent: number(),
    errorRateDeltaPercent: number(),
  }), { minItems: 1 }),
  crossTenantLeakageCount: nonNegativeInteger(),
  capacityDecision: object({
    decision: string({ enum: ["undetermined", "accept", "limit", "reject"] }),
    maxSafeConcurrency: nonNegativeInteger(),
    rationaleCode: safeRef(),
  }),
});

const alert = object({
  ...contractHeader("newme.v4.alert-evidence.v1"),
  releaseSha: sha1(),
  alertRuleRef: safeRef(),
  tenantScopeRef: safeRef(),
  ownerRef: safeRef(),
  routeRef: safeRef(),
  stimulusRef: safeRef(),
  severity: string({ enum: ["critical", "high", "medium", "low"] }),
  timeline: object({ triggeredAt: nullableIsoUtc(), deliveredAt: nullableIsoUtc(), acknowledgedAt: nullableIsoUtc() }),
  deliveryLatencyMs: nonNegativeInteger(),
  maxDeliveryLatencyMs: positiveInteger(),
  payloadRedacted: boolean({ const: true }),
  secretsIncluded: boolean({ const: false }),
  piiIncluded: boolean({ const: false }),
  tenantSafe: boolean({ const: true }),
  status: string({ enum: ["not_executed", "passed", "failed"] }),
});

const bundle = object({
  contract: string({ const: "newme.v4.rehearsal-preparation-bundle.v1" }),
  schemaVersion: integer({ const: 1 }),
  mode: string({ enum: ["template", "evidence"] }),
  evidenceState: string({
    enum: ["verified-current", "source-claim", "target", "validated-staging", "validated-production", "deferred", "rejected"],
  }),
  environmentClass: string({ enum: ["synthetic-local", "isolated-ephemeral-clone", "isolated-restore", "staging", "production"] }),
  runId: safeRef(),
  generatedAt: isoUtc(),
  linearIds: array(string({ enum: ["SAM-85", "SAM-86"] }), { minItems: 2, maxItems: 2, uniqueItems: true }),
  claimsExecuted: boolean(),
  clone: ephemeralClone,
  mapping,
  outboundDisable,
  migration,
  destruction,
  provenance,
  serviceLevel,
  restore,
  load,
  noisyNeighbor,
  alert,
});

const sam85Bundle = object({
  contract: string({ const: "newme.v4.sam85-migration-rehearsal.v1" }),
  schemaVersion: integer({ const: 1 }),
  mode: string({ enum: ["template", "evidence"] }),
  evidenceState: string({ enum: ["target", "verified-current"] }),
  environmentClass: string({ enum: ["synthetic-local", "isolated-ephemeral-clone"] }),
  runId: safeRef(),
  generatedAt: isoUtc(),
  linearIds: array(string({ const: "SAM-85" }), { minItems: 1, maxItems: 1, uniqueItems: true }),
  claimsExecuted: boolean(),
  clone: ephemeralClone,
  mapping,
  outboundDisable,
  migration,
  destruction,
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const rawSchemas = {
  ephemeralClone,
  mapping,
  outboundDisable,
  migration,
  destruction,
  provenance,
  serviceLevel,
  restore,
  load,
  noisyNeighbor,
  alert,
  bundle,
  sam85Bundle,
};

for (const [name, schema] of Object.entries(rawSchemas)) {
  schema.$schema = "https://json-schema.org/draft/2020-12/schema";
  schema.$id = `urn:newme:v4:schema:${name}:1`;
}

export const evidenceSchemas = deepFreeze(rawSchemas);

export const schemaNames = Object.freeze(Object.keys(evidenceSchemas));
