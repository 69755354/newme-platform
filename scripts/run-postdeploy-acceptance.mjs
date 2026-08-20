#!/usr/bin/env node

import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  canonicalJsonBytes,
  receiptPublicKeySha256,
  signPostdeployArtifact,
  verifyPostdeployArtifactReceipt,
} from "./postdeploy-receipt.mjs";
import { runCanonicalBrowserUat } from "./canonical-browser-uat.mjs";

const RELEASE_SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,255}$/;
const UTC_SECOND = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const PRODUCTION_ORIGIN = "https://app.newme.ae";
const ACCEPTANCE_INPUT_FILE = "/etc/newme/postdeploy-acceptance-credentials-v1.json";
const DATABASE_URL_FILE = "/etc/newme/migration-db.url";
const RECEIPT_PRIVATE_KEY_FILE = "/etc/newme/postdeploy-acceptance-receipt.key";
const RECEIPT_PUBLIC_KEY_FILE = "/etc/newme/postdeploy-acceptance-receipt.pub";
const OUTPUT_ROOT = "/var/lib/newme/postdeploy-intake-v1";
const ALERT_INBOX_ROOT = "/var/lib/newme/postdeploy-alert-inbox-v1";
const ALERT_STATE_ROOT = "/var/lib/newme/hermes-alert-v1/postdeploy";
const JOURNAL_ROOT = "/var/lib/newme/postdeploy-acceptance-state-v1";
const POLICY_PATH = "infra/release/postdeploy-acceptance-policy-v1.json";
const SCHEMA_PATH = "infra/release/postdeploy-evidence-v1.schema.json";
const ARTIFACT_VERSION = "newme-postdeploy-artifact/v1";
const JOURNAL_VERSION = "newme-postdeploy-journal/v1";
const ALERT_RECEIPT_VERSION = "newme-alert-provider-receipt/v1";
const ALERT_SOURCE = "newme-l0-alert-drill";
const ALERT_PIPELINE_VERSION = "newme-alert-state-notifier-provider/v1";
const ALERT_RECEIPT_WAIT_MS = 10 * 60 * 1000;
const REQUIRED_ROLES = ["admin", "boss", "operator", "sales"];
const FIXTURE_ID_KEYS = [
  "leadWon",
  "leadQuotation",
  "leadTransition",
  "leadApproval",
  "leadPayment",
  "browserLead",
  "quotation",
  "transitionContract",
  "approvalContract",
  "approvalRow",
  "paymentContract",
  "installmentPlan",
  "payment",
  "browserContract",
];
const FLOW_POLICY = {
  lead_to_contract: {
    coordinator: "sales",
    participants: ["sales"],
    assertions: ["lead_marked_won", "draft_contract_created", "admin_review_pending"],
  },
  contract_status_transition: {
    coordinator: "operator",
    participants: ["operator"],
    assertions: ["transition_accepted", "persisted_status_matches"],
  },
  quotation_conversion: {
    coordinator: "sales",
    participants: ["sales"],
    assertions: ["quotation_marked_converted", "contract_linked"],
  },
  quotation_two_step_approval: {
    coordinator: "boss",
    participants: ["admin", "boss"],
    assertions: ["admin_review_recorded", "ceo_review_recorded", "contract_approved"],
  },
  payment_allocation: {
    coordinator: "boss",
    participants: ["boss"],
    assertions: ["payment_confirmed", "allocation_persisted", "derived_totals_reconciled"],
  },
  kpi_period_replace: {
    coordinator: "admin",
    participants: ["admin"],
    assertions: ["period_replaced", "no_duplicate_targets", "target_readback_matches"],
  },
};
const ASSERTION_ROLE = {
  lead_marked_won: "sales",
  draft_contract_created: "sales",
  admin_review_pending: "sales",
  transition_accepted: "operator",
  persisted_status_matches: "operator",
  quotation_marked_converted: "sales",
  contract_linked: "sales",
  admin_review_recorded: "admin",
  ceo_review_recorded: "boss",
  contract_approved: "boss",
  payment_confirmed: "boss",
  allocation_persisted: "boss",
  derived_totals_reconciled: "boss",
  period_replaced: "admin",
  no_duplicate_targets: "admin",
  target_readback_matches: "admin",
};

class ProducerError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function refuse(code) {
  throw new ProducerError(code);
}

/**
 * Render a database failure as PostgreSQL's own identifiers, for the operator
 * reading a refusal in the deploy log.
 *
 * `detail` is deliberately excluded: on a constraint violation it embeds the
 * offending row. Everything printed here either names a schema object or is
 * PostgreSQL's own message, which names those same objects.
 */
export function describeDatabaseFailure(error) {
  if (!isObject(error)) return "code=unknown";
  const parts = [];
  for (const field of ["code", "constraint", "table", "column", "routine"]) {
    const value = error[field];
    if (typeof value === "string" && value.length > 0) parts.push(`${field}=${value}`);
  }
  if (typeof error.message === "string" && error.message.length > 0) {
    parts.push(`message=${JSON.stringify(error.message.slice(0, 300))}`);
  }
  return parts.length > 0 ? parts.join(" ") : "code=unknown";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, code) {
  if (!isObject(value)) refuse(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) refuse(code);
}

function utcSecond(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) refuse("invalid_timestamp");
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestValue(value) {
  return sha256(canonicalJsonBytes(value));
}

/**
 * Every ancestor of a protected input must be a real directory, owned by root,
 * granting no write permission to group or other.
 *
 * Group *identity* is deliberately not constrained. The immutable release tree
 * is `root:<service group>` with mode 0550 by contract: `deploy-immutable.sh`
 * sets that ownership and then verifies it, and `canonical-browser-uat.mjs`
 * refuses a release root whose gid is 0, because the acceptance container is
 * given precisely that group in order to read the tree. Requiring gid 0 here
 * made `<release>/.audit/deploy-*.json` permanently unreadable, so acceptance
 * refused every real release with `deployment_evidence_ancestor_untrusted`.
 *
 * Nothing is given up by dropping it: a directory entry can only be added,
 * renamed, or removed by a writer, and the 0o022 mask below is what denies that
 * to everyone except root. Read access to a directory cannot change what it
 * contains.
 *
 * `readMetadata` is injectable because CI cannot create a root-owned directory,
 * so the accepting half of this rule can only be proven against synthetic
 * metadata.
 */
export function requireProtectedAncestors(filePath, label, readMetadata = lstatSync) {
  if (process.platform === "win32") refuse(`${label}_requires_posix`);
  let cursor = path.dirname(path.resolve(filePath));
  while (true) {
    const metadata = readMetadata(cursor);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.uid !== 0
      || (metadata.mode & 0o022) !== 0
    ) refuse(`${label}_ancestor_untrusted`);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function readProtectedFile(filePath, label, maximumBytes = 1024 * 1024) {
  const resolved = path.resolve(filePath);
  requireProtectedAncestors(resolved, label);
  let descriptor;
  try {
    descriptor = openSync(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    refuse(`${label}_open_failed`);
  }
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile()
      || before.uid !== 0
      || before.gid !== 0
      || ![0o400, 0o600].includes(before.mode & 0o777)
      || before.size <= 0
      || before.size > maximumBytes
    ) refuse(`${label}_metadata_invalid`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || bytes.length !== before.size
    ) refuse(`${label}_changed_during_read`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function ensureProtectedDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const present = lstatExists(resolved);
  requireProtectedAncestors(present ? path.join(resolved, ".boundary") : resolved, label);
  if (!present) mkdirSync(resolved, { mode: 0o700 });
  const metadata = lstatSync(resolved);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== 0
    || metadata.gid !== 0
    || (metadata.mode & 0o777) !== 0o700
  ) refuse(`${label}_directory_untrusted`);
  return resolved;
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeProtectedJson(filePath, value, { exclusive = false } = {}) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const directory = path.dirname(filePath);
  ensureProtectedDirectory(directory, "journal");
  if (existsSync(filePath) || lstatExists(filePath)) {
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 || metadata.gid !== 0 || (metadata.mode & 0o777) !== 0o600) {
      refuse("journal_file_untrusted");
    }
    if (exclusive) refuse("journal_recovery_required");
  }
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (exclusive && (existsSync(filePath) || lstatExists(filePath))) refuse("journal_recovery_required");
    renameSync(temporary, filePath);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) rmSync(temporary, { force: false });
  }
}

function lstatExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function journalPaths(releaseSha) {
  const directory = path.join(JOURNAL_ROOT, releaseSha);
  return {
    directory,
    current: path.join(directory, "current.json"),
    history: path.join(directory, "history"),
  };
}

function validateJournal(journal, releaseSha) {
  exactKeys(journal, [
    "journal_version",
    "release_sha",
    "attempt_id",
    "state",
    "started_at",
    "updated_at",
    "fixture_plan",
    "actors",
    "observed_objects",
    "steps",
    "failure",
    "cleanup",
    "payment_effect",
    "bundle_sha256",
  ], "journal_shape_invalid");
  if (
    journal.journal_version !== JOURNAL_VERSION
    || journal.release_sha !== releaseSha
    || !EVENT_ID.test(journal.attempt_id)
    || !["uat_running", "uat_failed", "recovered", "ready", "aborted"].includes(journal.state)
    || !UTC_SECOND.test(journal.started_at)
    || !UTC_SECOND.test(journal.updated_at)
    || !Array.isArray(journal.observed_objects)
    || !Array.isArray(journal.steps)
    || !(journal.bundle_sha256 === null || /^[0-9a-f]{64}$/.test(journal.bundle_sha256))
  ) refuse("journal_semantic_invalid");
  exactKeys(journal.fixture_plan, ["marker", "kpi_period", "ids"], "journal_fixture_plan_invalid");
  if (
    typeof journal.fixture_plan.marker !== "string"
    || !/^postdeploy-uat-[0-9a-f-]{36}$/.test(journal.fixture_plan.marker)
    || !/^uat-[0-9a-f-]{36}$/.test(journal.fixture_plan.kpi_period)
    || !isObject(journal.fixture_plan.ids)
  ) refuse("journal_fixture_plan_invalid");
  exactKeys(journal.fixture_plan.ids, FIXTURE_ID_KEYS, "journal_fixture_plan_invalid");
  if (FIXTURE_ID_KEYS.some((key) => !UUID.test(journal.fixture_plan.ids[key]))) refuse("journal_fixture_plan_invalid");
  if (journal.actors !== null) {
    exactKeys(journal.actors, REQUIRED_ROLES, "journal_actors_invalid");
    if (REQUIRED_ROLES.some((role) => !UUID.test(journal.actors[role]))) refuse("journal_actors_invalid");
  }
  for (const object of journal.observed_objects) {
    exactKeys(object, ["table", "id"], "journal_observed_object_invalid");
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(object.table) || !UUID.test(object.id)) refuse("journal_observed_object_invalid");
  }
  for (const step of journal.steps) {
    exactKeys(step, ["id", "completed_at", "inventory_sha256"], "journal_step_invalid");
    if (!EVENT_ID.test(step.id) || !UTC_SECOND.test(step.completed_at) || !/^[0-9a-f]{64}$/.test(step.inventory_sha256)) {
      refuse("journal_step_invalid");
    }
  }
  if (journal.payment_effect !== null) {
    exactKeys(journal.payment_effect, [
      "payment_id",
      "period",
      "credited_to",
      "amount",
      "baseline_rows",
      "baseline_sha256",
      "snapshot_at",
      "confirmed_at",
      "voided_at",
      "void_request",
      "restored_at",
      "restored_sha256",
    ], "journal_payment_effect_invalid");
    const effect = journal.payment_effect;
    if (
      !UUID.test(effect.payment_id)
      || !/^\d{4}-\d{2}$/.test(effect.period)
      || !UUID.test(effect.credited_to)
      || !/^\d+(?:\.\d+)?$/.test(effect.amount)
      || !Array.isArray(effect.baseline_rows)
      || !/^[0-9a-f]{64}$/.test(effect.baseline_sha256)
      || !UTC_SECOND.test(effect.snapshot_at)
      || !(effect.confirmed_at === null || UTC_SECOND.test(effect.confirmed_at))
      || !(effect.voided_at === null || UTC_SECOND.test(effect.voided_at))
      || !(effect.restored_at === null || UTC_SECOND.test(effect.restored_at))
      || !(effect.restored_sha256 === null || /^[0-9a-f]{64}$/.test(effect.restored_sha256))
    ) refuse("journal_payment_effect_invalid");
    for (const row of effect.baseline_rows) {
      exactKeys(row, ["id", "actual_amount"], "journal_payment_effect_invalid");
      if (!UUID.test(row.id) || !/^-?\d+(?:\.\d+)?$/.test(row.actual_amount)) refuse("journal_payment_effect_invalid");
    }
    if (effect.void_request !== null) {
      exactKeys(effect.void_request, ["id", "http_status", "completed_at", "response_sha256"], "journal_payment_effect_invalid");
      if (
        !EVENT_ID.test(effect.void_request.id)
        || effect.void_request.http_status < 200
        || effect.void_request.http_status > 299
        || !UTC_SECOND.test(effect.void_request.completed_at)
        || !/^[0-9a-f]{64}$/.test(effect.void_request.response_sha256)
      ) refuse("journal_payment_effect_invalid");
    }
  }
  return journal;
}

function readJournal(releaseSha) {
  const { current } = journalPaths(releaseSha);
  if (!lstatExists(current)) return null;
  return validateJournal(parseJson(readProtectedFile(current, "journal", 8 * 1024 * 1024), "journal_json_invalid"), releaseSha);
}

function archiveRecoveredJournal(releaseSha, journal) {
  const paths = journalPaths(releaseSha);
  if (!journal || !["recovered", "aborted"].includes(journal.state)) refuse("journal_recovery_required");
  ensureProtectedDirectory(paths.history, "journal_history");
  const destination = path.join(paths.history, `${journal.attempt_id}.json`);
  if (lstatExists(destination)) refuse("journal_history_collision");
  renameSync(paths.current, destination);
  fsyncDirectory(paths.history);
  fsyncDirectory(paths.directory);
}

function createJournal(releaseSha, fixture) {
  ensureProtectedDirectory(JOURNAL_ROOT, "journal_root");
  const paths = journalPaths(releaseSha);
  ensureProtectedDirectory(paths.directory, "journal_release");
  const existing = readJournal(releaseSha);
  if (existing) archiveRecoveredJournal(releaseSha, existing);
  const startedAt = utcSecond();
  const journal = {
    journal_version: JOURNAL_VERSION,
    release_sha: releaseSha,
    attempt_id: `uat:${releaseSha.slice(0, 12)}:${randomUUID()}`,
    state: "uat_running",
    started_at: startedAt,
    updated_at: startedAt,
    fixture_plan: {
      marker: fixture.marker,
      kpi_period: fixture.kpiPeriod,
      ids: fixture.ids,
    },
    actors: null,
    observed_objects: [],
    steps: [],
    failure: null,
    cleanup: null,
    payment_effect: null,
    bundle_sha256: null,
  };
  writeProtectedJson(paths.current, journal, { exclusive: true });
  return journal;
}

function persistJournal(journal) {
  journal.updated_at = utcSecond();
  validateJournal(journal, journal.release_sha);
  writeProtectedJson(journalPaths(journal.release_sha).current, journal);
}

function recordJournalStep(journal, id, inventory = []) {
  if (journal.steps.some((step) => step.id === id)) refuse("journal_step_duplicate");
  journal.steps.push({ id, completed_at: utcSecond(), inventory_sha256: digestValue(inventory) });
  persistJournal(journal);
}

function recordJournalFailure(journal, primaryCode, cleanupResult = null, cleanupCode = null) {
  journal.state = "uat_failed";
  journal.failure = { primary_code: primaryCode, cleanup_code: cleanupCode };
  journal.cleanup = cleanupResult;
  persistJournal(journal);
}

function parseJson(bytes, code) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    refuse(code);
  }
  if (!isObject(value)) refuse(code);
  return value;
}

function credentialsFromBytes(bytes) {
  const credentials = parseJson(bytes, "credentials_invalid");
  exactKeys(credentials, ["credentials_version", "accounts", "alert_receipt_hmac_secret_b64"], "credentials_shape_invalid");
  if (credentials.credentials_version !== "newme-postdeploy-credentials/v1") refuse("credentials_version_invalid");
  exactKeys(credentials.accounts, REQUIRED_ROLES, "credential_accounts_invalid");
  for (const role of REQUIRED_ROLES) {
    const account = credentials.accounts[role];
    exactKeys(account, ["email", "password"], `credential_${role}_shape_invalid`);
    if (
      typeof account.email !== "string"
      || account.email.length < 3
      || account.email.length > 254
      || typeof account.password !== "string"
      || account.password.length < 8
      || account.password.length > 1024
    ) refuse(`credential_${role}_invalid`);
  }
  let alertSecret;
  try {
    alertSecret = Buffer.from(credentials.alert_receipt_hmac_secret_b64, "base64");
  } catch {
    refuse("alert_receipt_secret_invalid");
  }
  if (alertSecret.length < 32 || alertSecret.length > 128) refuse("alert_receipt_secret_invalid");
  return { accounts: credentials.accounts, alertSecret };
}

function verifyProviderReceipt({
  bodyBytes,
  signatureBytes,
  secret,
  expectedType,
  releaseSha,
  expectedTriggerSha,
  expectedEventId = null,
  minimumOccurredAt = null,
}) {
  const signatureText = signatureBytes.toString("ascii").trim();
  if (!/^[0-9a-f]{64}$/.test(signatureText)) refuse(`alert_${expectedType}_signature_invalid`);
  const supplied = Buffer.from(signatureText, "hex");
  const expected = createHmac("sha256", secret).update(bodyBytes).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    refuse(`alert_${expectedType}_signature_mismatch`);
  }
  const receipt = parseJson(bodyBytes, `alert_${expectedType}_json_invalid`);
  exactKeys(receipt, [
    "receipt_version",
    "source",
    "release_sha",
    "trigger_sha256",
    "event_type",
    "event_id",
    "provider_delivery_id",
    "provider_operation_id",
    "occurred_at",
    "status",
  ], `alert_${expectedType}_shape_invalid`);
  if (
    receipt.receipt_version !== ALERT_RECEIPT_VERSION
    || receipt.source !== ALERT_SOURCE
    || receipt.release_sha !== releaseSha
    || receipt.trigger_sha256 !== expectedTriggerSha
    || receipt.event_type !== expectedType
    || !EVENT_ID.test(receipt.event_id)
    || !EVENT_ID.test(receipt.provider_delivery_id)
    || !EVENT_ID.test(receipt.provider_operation_id)
    || !UTC_SECOND.test(receipt.occurred_at)
    || receipt.status !== (expectedType === "failure" ? "firing" : "ok")
    || (expectedEventId !== null && receipt.event_id !== expectedEventId)
    || (minimumOccurredAt !== null && Date.parse(receipt.occurred_at) < Date.parse(minimumOccurredAt))
  ) refuse(`alert_${expectedType}_semantic_invalid`);
  return {
    ...receipt,
    body_sha256: sha256(bodyBytes),
    signature_sha256: sha256(signatureBytes),
  };
}

export function verifyAlertProviderPair({
  failureBody,
  failureSignature,
  recoveryBody,
  recoverySignature,
  secret,
  releaseSha,
  failureTriggerSha,
  recoveryTriggerSha,
}) {
  const failure = verifyProviderReceipt({
    bodyBytes: failureBody,
    signatureBytes: failureSignature,
    secret,
    expectedType: "failure",
    releaseSha,
    expectedTriggerSha: failureTriggerSha,
  });
  const recovery = verifyProviderReceipt({
    bodyBytes: recoveryBody,
    signatureBytes: recoverySignature,
    secret,
    expectedType: "recovery",
    releaseSha,
    expectedTriggerSha: recoveryTriggerSha,
  });
  if (
    failure.event_id === recovery.event_id
    || failure.provider_delivery_id === recovery.provider_delivery_id
    || failure.provider_operation_id === recovery.provider_operation_id
    || Date.parse(recovery.occurred_at) <= Date.parse(failure.occurred_at)
  ) refuse("alert_pair_invalid");
  return { failure, recovery };
}

export function verifyAlertProviderReadback({
  body,
  signature,
  secret,
  releaseSha,
  readbackTriggerSha,
  recoveryEventId,
  recoveryProviderDeliveryId,
  recoveryProviderOperationId,
  notBefore,
  now = new Date(),
}) {
  const receipt = verifyProviderReceipt({
    bodyBytes: body,
    signatureBytes: signature,
    secret,
    expectedType: "readback",
    releaseSha,
    expectedTriggerSha: readbackTriggerSha,
    expectedEventId: recoveryEventId,
    minimumOccurredAt: notBefore,
  });
  if (Date.parse(receipt.occurred_at) > now.getTime()) refuse("alert_readback_semantic_invalid");
  if (
    receipt.provider_delivery_id !== recoveryProviderDeliveryId
    || receipt.provider_operation_id === recoveryProviderOperationId
  ) refuse("alert_readback_semantic_invalid");
  return receipt;
}

function applySetCookies(headers, cookies) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : (headers.get("set-cookie") ? [headers.get("set-cookie")] : []);
  for (const value of values) {
    const pair = String(value).split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1);
    if (/Max-Age=0/i.test(value) || cookieValue === "") cookies.delete(name);
    else cookies.set(name, cookieValue);
  }
}

class ApiSession {
  constructor({ role, account, fetchImpl = fetch, now = () => new Date(), signal = null }) {
    this.role = role;
    this.account = account;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.signal = signal;
    this.cookies = new Map();
    this.actorId = null;
    this.checks = [];
    this.startedAt = null;
  }

  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async request(method, apiPath, body = undefined, requestId = `uat:${this.role}:${randomUUID()}`, cookieOverride = undefined) {
    const headers = {
      accept: "application/json",
      origin: PRODUCTION_ORIGIN,
      "cache-control": "no-store",
      "x-newme-acceptance-request-id": requestId,
    };
    const cookie = cookieOverride === undefined ? this.cookieHeader() : cookieOverride;
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await this.fetchImpl(`${PRODUCTION_ORIGIN}${apiPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: this.signal ? AbortSignal.any([AbortSignal.timeout(20_000), this.signal]) : AbortSignal.timeout(20_000),
      });
    } catch {
      if (this.signal?.aborted) refuse("uat_interrupted");
      refuse("uat_http_unreachable");
    }
    applySetCookies(response.headers, this.cookies);
    const responseBytes = Buffer.from(await response.arrayBuffer());
    let json = null;
    if (responseBytes.length > 0) {
      try {
        json = JSON.parse(responseBytes.toString("utf8"));
      } catch {
        refuse("uat_http_response_not_json");
      }
    }
    return {
      id: requestId,
      actor_role: this.role,
      actor_id: this.actorId,
      method,
      path: apiPath,
      http_status: response.status,
      completed_at: utcSecond(this.now()),
      response_sha256: sha256(responseBytes),
      json,
    };
  }

  recordSessionCheck(id, request) {
    this.checks.push({
      id,
      status: "pass",
      completed_at: request.completed_at,
      http_status: request.http_status,
      response_sha256: request.response_sha256,
    });
  }

  async open() {
    this.startedAt = utcSecond(this.now());
    const login = await this.request("POST", "/api/auth/login", this.account, `session:${this.role}:login:${randomUUID()}`);
    if (login.http_status !== 200 || login.json?.ok !== true || login.json?.role !== this.role || !UUID.test(login.json?.userId ?? "")) {
      refuse(`uat_${this.role}_login_failed`);
    }
    this.actorId = login.json.userId;
    this.recordSessionCheck("login", login);

    let removedAccessCookie = false;
    for (const [name, value] of [...this.cookies]) {
      try {
        const decoded = JSON.parse(decodeURIComponent(value));
        if (typeof decoded?.access_token === "string") {
          this.cookies.delete(name);
          removedAccessCookie = true;
        }
      } catch {
        // The refresh cookie is intentionally opaque and remains in the jar.
      }
    }
    if (!removedAccessCookie) refuse(`uat_${this.role}_access_cookie_missing`);
    const refresh = await this.request("GET", "/api/auth/me", undefined, `session:${this.role}:refresh:${randomUUID()}`);
    if (refresh.http_status !== 200 || refresh.json?.userId !== this.actorId || refresh.json?.role !== this.role) {
      refuse(`uat_${this.role}_refresh_failed`);
    }
    this.recordSessionCheck("refresh", refresh);
    const authorization = await this.request("GET", "/api/auth/me", undefined, `session:${this.role}:authorization:${randomUUID()}`);
    if (authorization.http_status !== 200 || authorization.json?.userId !== this.actorId || authorization.json?.role !== this.role) {
      refuse(`uat_${this.role}_authorization_failed`);
    }
    this.recordSessionCheck("authorization", authorization);
  }

  async close() {
    const originalSessionCredential = this.cookieHeader();
    if (!originalSessionCredential) refuse(`uat_${this.role}_session_credential_missing`);
    const logout = await this.request("POST", "/api/auth/logout", {}, `session:${this.role}:logout:${randomUUID()}`);
    if (logout.http_status !== 200 || logout.json?.ok !== true || logout.json?.revoked !== true) {
      refuse(`uat_${this.role}_logout_failed`);
    }
    this.recordSessionCheck("logout", logout);
    const denied = await this.request(
      "GET",
      "/api/auth/me",
      undefined,
      `session:${this.role}:post-logout-denied:${randomUUID()}`,
      originalSessionCredential,
    );
    if (![401, 403].includes(denied.http_status)) refuse(`uat_${this.role}_post_logout_credential_active`);
    this.recordSessionCheck("post_logout_denied", denied);
    return denied.completed_at;
  }
}

function ensureSuccess(request, code) {
  if (request.http_status < 200 || request.http_status > 299) refuse(code);
}

function requestEvidence(request) {
  const {
    id,
    actor_role: actorRole,
    actor_id: actorId,
    method,
    path: apiPath,
    http_status: httpStatus,
    completed_at: completedAt,
    response_sha256: responseSha256,
  } = request;
  return {
    id,
    actor_role: actorRole,
    actor_id: actorId,
    method,
    path: apiPath,
    http_status: httpStatus,
    completed_at: completedAt,
    response_sha256: responseSha256,
  };
}

async function chooseKpiPeriod(db) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const period = `uat-${randomUUID()}`;
    const result = await db.query("select count(*)::int as count from public.kpi_targets where period = $1", [period]);
    if (Number(result.rows[0]?.count) === 0) return period;
  }
  refuse("no_unique_kpi_uat_period");
}

async function planFixtures(db) {
  const ids = {
    leadWon: randomUUID(),
    leadQuotation: randomUUID(),
    leadTransition: randomUUID(),
    leadApproval: randomUUID(),
    leadPayment: randomUUID(),
    browserLead: randomUUID(),
    quotation: randomUUID(),
    transitionContract: randomUUID(),
    approvalContract: randomUUID(),
    approvalRow: randomUUID(),
    paymentContract: randomUUID(),
    installmentPlan: randomUUID(),
    payment: randomUUID(),
    browserContract: randomUUID(),
  };
  const marker = `postdeploy-uat-${randomUUID()}`;
  const kpiPeriod = await chooseKpiPeriod(db);
  return { ids, marker, kpiPeriod };
}

/**
 * The `public.leads.source` value the acceptance fixture writes.
 *
 * That column carries `leads_source_check`, a closed taxonomy owned by sales
 * (supabase/migrations/20260714000001_normalize_lead_sources.sql). The fixture
 * used to write the descriptive value `postdeploy_uat`, which the constraint has
 * never admitted, so `seedFixtures` refused on every database carrying it.
 * Fixture rows are identified by `marker` in `customer_name` and `notes`, never
 * by `source`, so any admitted value serves; `other` is the taxonomy's own
 * bucket for a lead belonging to no named channel.
 */
export const FIXTURE_LEAD_SOURCE = "other";

/**
 * The state `public.on_lead_won()` leaves behind when a Lead is marked won.
 *
 * 20260812000000_money_actor_identity_and_atomicity.sql §12 changed this
 * deliberately and says so: the trigger used to insert the contract with
 * `status = 'active'`, so a lead field update produced a fully active contract
 * that had never been through admin_review or ceo_review. It now creates a
 * `draft` contract with a pending `admin_review` row, exactly like
 * `create_contract()`. 20260817000000 carries the same body forward.
 *
 * The flow asserted `pending_admin`, which is a status this path has never
 * written -- `pending_admin` is what `set_contract_status()` moves a draft *to*
 * once someone submits it for review. Bound to the owning migration by contract
 * test so the expectation cannot drift away from the trigger again.
 */
export const LEAD_WON_CONTRACT_STATUS = "draft";
export const LEAD_WON_CONTRACT_APPROVAL_STATUS = "none";
export const LEAD_WON_APPROVAL_STEP = "admin_review";
export const LEAD_WON_APPROVAL_STATUS = "pending";

/**
 * Print a closed-taxonomy value, redact anything else.
 *
 * The rows behind these expectations also carry customer names and notes, and a
 * diagnostic is worthless if using it risks writing business data into a deploy
 * log. Every value this describes is a status/stage enum, so anything outside
 * that shape is a sign the field was not what the caller thought -- which is
 * itself the useful part of the report.
 */
export function taxonomyValue(value) {
  if (value === null || value === undefined) return "<null>";
  if (typeof value === "number") return String(value);
  if (typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value)) return value;
  return "<not-a-taxonomy-value>";
}

/**
 * The lead->contract expectations that are not met, named one by one.
 *
 * Returns an empty array when the readback matches. Kept pure so a contract
 * test can prove it fails for the pre-migration behaviour it exists to catch.
 */
export function leadWonUnmetExpectations({ leadRows, contractRows, approvalRows }) {
  const unmet = [];
  const lead = leadRows[0];
  if (leadRows.length !== 1) unmet.push(`leads rows=${leadRows.length} expected=1`);
  if (lead?.stage !== "won") unmet.push(`leads.stage=${taxonomyValue(lead?.stage)} expected=won`);
  if (lead?.final_status !== "won") {
    unmet.push(`leads.final_status=${taxonomyValue(lead?.final_status)} expected=won`);
  }
  if (contractRows.length !== 1) {
    unmet.push(`contracts rows=${contractRows.length} expected=1`);
  }
  const contract = contractRows[0];
  if (contract && contract.status !== LEAD_WON_CONTRACT_STATUS) {
    unmet.push(`contracts.status=${taxonomyValue(contract.status)} expected=${LEAD_WON_CONTRACT_STATUS}`);
  }
  if (contract && contract.approval_status !== LEAD_WON_CONTRACT_APPROVAL_STATUS) {
    unmet.push(
      `contracts.approval_status=${taxonomyValue(contract.approval_status)} ` +
        `expected=${LEAD_WON_CONTRACT_APPROVAL_STATUS}`,
    );
  }
  const pending = approvalRows.filter(
    (row) => row.step === LEAD_WON_APPROVAL_STEP && row.status === LEAD_WON_APPROVAL_STATUS,
  );
  if (pending.length !== 1) {
    unmet.push(
      `contract_approvals ${LEAD_WON_APPROVAL_STEP}/${LEAD_WON_APPROVAL_STATUS} rows=${pending.length} ` +
        `expected=1 (observed=${approvalRows
          .map((row) => `${taxonomyValue(row.step)}/${taxonomyValue(row.status)}`)
          .join(",") || "none"})`,
    );
  }
  return unmet;
}

async function seedFixtures(db, actorIds, fixture) {
  const { ids, marker } = fixture;
  await db.query("begin");
  try {
    await db.query(
      `insert into public.leads
        (id, source, customer_name, assigned_to, stage, quotation_value, next_followup_date, next_action, notes, created_by)
       values
        ($1, $9, $6, $5, 'pending_decision', 1000, current_date + 30, 'call', $6, $5),
        ($2, $9, $6, $5, 'quotation_submitted', 1000, current_date + 30, 'call', $6, $5),
        ($3, $9, $6, $5, 'pending_decision', 1000, current_date + 30, 'call', $6, $5),
        ($4, $9, $6, $5, 'pending_decision', 1000, current_date + 30, 'call', $6, $5),
        ($7, $9, $6, $5, 'pending_decision', 1000, current_date + 30, 'call', $6, $5),
        ($8, $9, $6, $5, 'pending_decision', 1000, current_date + 30, 'call', $6, $5)`,
      [ids.leadWon, ids.leadQuotation, ids.leadTransition, ids.leadApproval, actorIds.sales, marker, ids.leadPayment, ids.browserLead, FIXTURE_LEAD_SOURCE],
    );
    await db.query(
      `insert into public.quotations
        (id, lead_id, created_by, quote_no, subtotal, total_amount, valid_until, status, notes)
       values ($1, $2, $3, $4, 1000, 1000, current_date + 30, 'accepted', $5)`,
      [ids.quotation, ids.leadQuotation, actorIds.sales, `UAT-Q-${ids.quotation.slice(0, 8)}`, marker],
    );
    await db.query(
      `insert into public.contracts
        (id, lead_id, sales_id, created_by, contract_no, contract_amount, party_a_name, status, notes)
       values
        ($1, $4, $7, $7, $9, 1000, $8, 'approved', $8),
        ($2, $5, $7, $7, $10, 1000, $8, 'pending_admin', $8),
        ($3, $6, $7, $7, $11, 1000, $8, 'active', $8),
        ($12, $13, $7, $7, $14, 1000, $8, 'active', $8)`,
      [
        ids.transitionContract,
        ids.approvalContract,
        ids.paymentContract,
        ids.leadTransition,
        ids.leadApproval,
        ids.leadPayment,
        actorIds.sales,
        marker,
        `UAT-C-${ids.transitionContract.slice(0, 8)}`,
        `UAT-C-${ids.approvalContract.slice(0, 8)}`,
        `UAT-C-${ids.paymentContract.slice(0, 8)}`,
        ids.browserContract,
        ids.browserLead,
        `UAT-C-${ids.browserContract.slice(0, 8)}`,
      ],
    );
    await db.query(
      "insert into public.contract_approvals (id, contract_id, step, status, notes) values ($1, $2, 'admin_review', 'pending', jsonb_build_object('source','postdeploy_uat'))",
      [ids.approvalRow, ids.approvalContract],
    );
    await db.query(
      "insert into public.installment_plans (id, contract_id, seq, amount, due_date, description) values ($1, $2, 1, 1000, current_date + 30, $3)",
      [ids.installmentPlan, ids.paymentContract, marker],
    );
    await db.query(
      `insert into public.payments
        (id, contract_id, installment_plan_id, created_by, amount, payment_date, payment_method, reference_no, notes, request_key)
       values ($1, $2, $3, $4, 1000, current_date, 'bank_transfer', $5, $5, $6)`,
      [ids.payment, ids.paymentContract, ids.installmentPlan, actorIds.boss, marker, randomUUID()],
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback").catch(() => {});
    // The bare `catch` this replaces made a seed defect undiagnosable: acceptance
    // refused with nothing but `fixture_seed_failed`, and the real cause -- the
    // Lead source taxonomy rejecting the fixture's value -- had to be recovered
    // by replaying these statements by hand against production.
    console.error(`postdeploy producer: fixture seed failed ${describeDatabaseFailure(error)}`);
    refuse("fixture_seed_failed");
  }
  return fixture;
}

function normalizedKpiActualRows(rows) {
  return rows.map((row) => ({ id: row.id, actual_amount: String(row.actual_amount) }));
}

export function assertExactPaymentKpiRestoration(effect, restoredRows) {
  if (!effect || !Array.isArray(effect.baseline_rows)) refuse("payment_kpi_baseline_missing");
  const normalized = normalizedKpiActualRows(restoredRows);
  const restoredSha256 = digestValue(normalized);
  if (restoredSha256 !== effect.baseline_sha256) refuse("fixture_payment_kpi_not_restored");
  return { rows: normalized, sha256: restoredSha256 };
}

async function capturePaymentKpiBaseline(db, fixture, journal) {
  await db.query("begin");
  try {
    const payment = await db.query(
      `select p.id, p.amount::text as amount, to_char(p.payment_date, 'YYYY-MM') as period,
              c.sales_id as credited_to
         from public.payments p
         join public.contracts c on c.id = p.contract_id
        where p.id = $1
        for share of p, c`,
      [fixture.ids.payment],
    );
    const row = payment.rows[0];
    if (
      payment.rows.length !== 1
      || !UUID.test(row?.id ?? "")
      || !/^\d+(?:\.\d+)?$/.test(String(row?.amount ?? ""))
      || !/^\d{4}-\d{2}$/.test(row?.period ?? "")
      || row?.credited_to !== fixture.actorIds?.sales
    ) refuse("payment_kpi_baseline_subject_invalid");
    await db.query(
      "select pg_advisory_xact_lock(hashtextextended('public.kpi_targets:' || $1, 0))",
      [row.period],
    );
    const targets = await db.query(
      `select id, actual_amount::text as actual_amount
         from public.kpi_targets
        where period = $1 and target_type = 'collection' and assigned_to = $2
        order by id
        for update`,
      [row.period, row.credited_to],
    );
    const baselineRows = normalizedKpiActualRows(targets.rows);
    const effect = {
      payment_id: row.id,
      period: row.period,
      credited_to: row.credited_to,
      amount: String(row.amount),
      baseline_rows: baselineRows,
      baseline_sha256: digestValue(baselineRows),
      snapshot_at: utcSecond(),
      confirmed_at: null,
      voided_at: null,
      void_request: null,
      restored_at: null,
      restored_sha256: null,
    };
    await db.query("commit");
    journal.payment_effect = effect;
    fixture.paymentEffect = effect;
    persistJournal(journal);
    return effect;
  } catch (error) {
    await db.query("rollback").catch(() => {});
    if (error instanceof ProducerError) throw error;
    refuse("payment_kpi_baseline_failed");
  }
}

async function paymentState(db, paymentId) {
  const result = await db.query(
    `select id, confirmed, confirmed_at, voided_at, voided_by, credited_to,
            amount::text as amount, to_char(payment_date, 'YYYY-MM') as period
       from public.payments where id = $1`,
    [paymentId],
  );
  if (result.rows.length > 1) refuse("payment_fixture_duplicate");
  return result.rows[0] ?? null;
}

async function readPaymentKpiActuals(db, effect) {
  const result = await db.query(
    `select id, actual_amount::text as actual_amount
       from public.kpi_targets
      where period = $1 and target_type = 'collection' and assigned_to = $2
      order by id`,
    [effect.period, effect.credited_to],
  );
  return normalizedKpiActualRows(result.rows);
}

async function reverseFixturePayment({ db, fixture, journal, bossAccount, preferredSession = null }) {
  const effect = journal?.payment_effect ?? fixture.paymentEffect ?? null;
  const stateBefore = await paymentState(db, fixture.ids.payment);
  if (stateBefore === null) {
    if (effect?.restored_at && effect.restored_sha256 === effect.baseline_sha256) return effect;
    return null;
  }
  if (stateBefore.voided_at !== null || stateBefore.confirmed === true) {
    if (!effect || effect.payment_id !== fixture.ids.payment) refuse("payment_kpi_baseline_missing");
  }
  if (stateBefore.confirmed === true && stateBefore.voided_at !== null) refuse("payment_fixture_state_contradictory");
  if (stateBefore.confirmed === true) {
    let session = preferredSession;
    let ownedSession = false;
    if (!session?.actorId || session.role !== "boss" || session.signal?.aborted) {
      session = new ApiSession({ role: "boss", account: bossAccount });
      await session.open();
      ownedSession = true;
    }
    try {
      const request = await session.request(
        "POST",
        `/api/payments/${fixture.ids.payment}/void`,
        { reason: `${fixture.marker}: canonical postdeploy cleanup` },
        `cleanup:payment:void:${randomUUID()}`,
      );
      ensureSuccess(request, "fixture_payment_void_http_failed");
      effect.confirmed_at ??= stateBefore.confirmed_at ? utcSecond(stateBefore.confirmed_at) : request.completed_at;
      effect.void_request = {
        id: request.id,
        http_status: request.http_status,
        completed_at: request.completed_at,
        response_sha256: request.response_sha256,
      };
      persistJournal(journal);
    } finally {
      if (ownedSession) await session.close();
    }
  }
  const stateAfter = await paymentState(db, fixture.ids.payment);
  if (
    stateAfter === null
    || (effect && stateAfter.period !== effect.period)
    || (effect && stateAfter.amount !== effect.amount)
  ) refuse("fixture_payment_reversal_readback_failed");
  if (stateAfter.voided_at !== null) {
    if (stateAfter.confirmed !== false || !UUID.test(stateAfter.voided_by ?? "")) refuse("fixture_payment_reversal_readback_failed");
    effect.confirmed_at ??= stateAfter.confirmed_at ? utcSecond(stateAfter.confirmed_at) : effect.snapshot_at;
    effect.voided_at = utcSecond(stateAfter.voided_at);
  } else if (stateAfter.confirmed !== false) {
    refuse("fixture_payment_reversal_readback_failed");
  }
  if (effect) {
    const restoredRows = await readPaymentKpiActuals(db, effect);
    const { sha256: restoredSha256 } = assertExactPaymentKpiRestoration(effect, restoredRows);
    effect.restored_at = utcSecond();
    effect.restored_sha256 = restoredSha256;
    fixture.paymentEffect = effect;
    journal.payment_effect = effect;
    persistJournal(journal);
  }
  return effect;
}

async function runBusinessFlows({ db, sessions, fixture }) {
  const { ids, kpiPeriod } = fixture;
  const actorIds = Object.fromEntries(REQUIRED_ROLES.map((role) => [role, sessions[role].actorId]));
  const flow = async (id, fixtureId, operations) => {
    const startedAt = utcSecond();
    const {
      requests,
      readbacks,
      fixtureId: observedFixtureId = fixtureId,
      assertionRequestIds = {},
    } = await operations();
    const completedAt = utcSecond();
    const policy = FLOW_POLICY[id];
    const requestsById = new Map(requests.map((request) => [request.id, request]));
    const requestsByRole = new Map();
    for (const request of requests) {
      const roleRequests = requestsByRole.get(request.actor_role) ?? [];
      roleRequests.push(request);
      requestsByRole.set(request.actor_role, roleRequests);
    }
    if (!UUID.test(observedFixtureId)) refuse(`flow_${id}_fixture_invalid`);
    return {
      id,
      status: "pass",
      started_at: startedAt,
      completed_at: completedAt,
      participants: policy.participants.map((role) => ({ role, actor_id: actorIds[role] })),
      requests: requests.map(requestEvidence),
      fixture_ids: [observedFixtureId],
      assertions: policy.assertions.map((assertionId) => {
        const role = ASSERTION_ROLE[assertionId];
        const explicitRequestId = assertionRequestIds[assertionId];
        const candidates = requestsByRole.get(role) ?? [];
        const request = explicitRequestId ? requestsById.get(explicitRequestId) : (candidates.length === 1 ? candidates[0] : null);
        const readback = readbacks[assertionId];
        if (!request || readback === undefined) refuse(`flow_${id}_evidence_incomplete`);
        return {
          id: assertionId,
          status: "pass",
          completed_at: completedAt,
          request_id: request.id,
          fixture_id: observedFixtureId,
          http_status: request.http_status,
          actor_role: role,
          actor_id: actorIds[role],
          readback_sha256: digestValue(readback),
        };
      }),
    };
  };

  const results = [];
  results.push(await flow("lead_to_contract", ids.leadWon, async () => {
    const request = await sessions.sales.request("PATCH", `/api/leads/${ids.leadWon}/stage`, {
      stage: "won",
      note: "postdeploy acceptance fixture",
      idempotencyKey: randomUUID(),
    });
    ensureSuccess(request, "flow_lead_to_contract_http_failed");
    const lead = await db.query("select id, stage, final_status from public.leads where id = $1", [ids.leadWon]);
    const contract = await db.query(
      "select id, lead_id, status, approval_status from public.contracts where lead_id = $1 order by created_at, id",
      [ids.leadWon],
    );
    const approval = await db.query(
      `select step, status from public.contract_approvals
        where contract_id = any($1::uuid[]) order by created_at, id`,
      [contract.rows.map((row) => row.id)],
    );
    const unmet = leadWonUnmetExpectations({
      leadRows: lead.rows,
      contractRows: contract.rows,
      approvalRows: approval.rows,
    });
    if (unmet.length > 0) {
      console.error(`postdeploy producer: lead_to_contract readback unmet ${unmet.join("; ")}`);
      refuse("flow_lead_to_contract_readback_failed");
    }
    return {
      requests: [request],
      readbacks: {
        lead_marked_won: lead.rows,
        draft_contract_created: contract.rows,
        admin_review_pending: approval.rows,
      },
    };
  }));

  results.push(await flow("contract_status_transition", ids.transitionContract, async () => {
    const request = await sessions.operator.request("PATCH", `/api/contracts/${ids.transitionContract}`, { status: "active" });
    ensureSuccess(request, "flow_contract_transition_http_failed");
    const readback = await db.query("select id, status from public.contracts where id = $1", [ids.transitionContract]);
    if (readback.rows[0]?.status !== "active") refuse("flow_contract_transition_readback_failed");
    return {
      requests: [request],
      readbacks: { transition_accepted: request.json, persisted_status_matches: readback.rows },
    };
  }));

  results.push(await flow("quotation_conversion", ids.quotation, async () => {
    const request = await sessions.sales.request("POST", `/api/quotations/${ids.quotation}/convert`, {
      first_payment_due_date: "2099-12-31",
      installments: [{ seq: 1, amount: 1000, due_date: "2099-12-31", description: "postdeploy acceptance fixture" }],
    });
    ensureSuccess(request, "flow_quotation_conversion_http_failed");
    const readback = await db.query(
      `select q.id, q.status, q.contract_id, c.lead_id
         from public.quotations q
         join public.contracts c on c.id = q.contract_id
        where q.id = $1`,
      [ids.quotation],
    );
    if (readback.rows[0]?.status !== "contract_created" || readback.rows[0]?.lead_id !== ids.leadQuotation) {
      refuse("flow_quotation_conversion_readback_failed");
    }
    return {
      requests: [request],
      readbacks: { quotation_marked_converted: readback.rows, contract_linked: readback.rows },
    };
  }));

  results.push(await flow("quotation_two_step_approval", ids.approvalContract, async () => {
    const adminRequest = await sessions.admin.request("POST", `/api/contracts/${ids.approvalContract}/approve`, {
      action: "approve",
      notes: "postdeploy acceptance fixture",
    });
    ensureSuccess(adminRequest, "flow_admin_approval_http_failed");
    const adminReadback = await db.query(
      "select step, status, approver_id from public.contract_approvals where contract_id = $1 order by step",
      [ids.approvalContract],
    );
    if (!adminReadback.rows.some((row) => row.step === "admin_review" && row.status === "approved" && row.approver_id === actorIds.admin)) {
      refuse("flow_admin_approval_readback_failed");
    }
    const bossRequest = await sessions.boss.request("POST", `/api/contracts/${ids.approvalContract}/approve`, {
      action: "approve",
      notes: "postdeploy acceptance fixture",
    });
    ensureSuccess(bossRequest, "flow_boss_approval_http_failed");
    const finalReadback = await db.query(
      `select c.id, c.status, a.step, a.status as approval_status, a.approver_id
         from public.contracts c
         join public.contract_approvals a on a.contract_id = c.id
        where c.id = $1 order by a.step`,
      [ids.approvalContract],
    );
    if (
      !finalReadback.rows.every((row) => row.status === "approved")
      || !finalReadback.rows.some((row) => row.step === "ceo_review" && row.approval_status === "approved" && row.approver_id === actorIds.boss)
    ) refuse("flow_boss_approval_readback_failed");
    return {
      requests: [adminRequest, bossRequest],
      readbacks: {
        admin_review_recorded: adminReadback.rows,
        ceo_review_recorded: finalReadback.rows,
        contract_approved: finalReadback.rows,
      },
    };
  }));

  results.push(await flow("payment_allocation", ids.payment, async () => {
    const confirm = await sessions.boss.request("POST", `/api/payments/${ids.payment}/confirm`, {});
    ensureSuccess(confirm, "flow_payment_confirm_http_failed");
    const allocate = await sessions.boss.request("POST", `/api/payments/${ids.payment}/allocate`, {
      allocations: [{ plan_id: ids.installmentPlan, amount: 1000 }],
    });
    ensureSuccess(allocate, "flow_payment_allocate_http_failed");
    const readback = await db.query(
      `select p.id, p.confirmed, pa.plan_id, pa.amount_allocated, ip.allocated_amount, ip.paid_amount
         from public.payments p
         join public.payment_allocations pa on pa.payment_id = p.id
         join public.installment_plans ip on ip.id = pa.plan_id
        where p.id = $1`,
      [ids.payment],
    );
    const row = readback.rows[0];
    if (row?.confirmed !== true || Number(row.amount_allocated) !== 1000 || Number(row.allocated_amount) !== 1000) {
      refuse("flow_payment_readback_failed");
    }
    return {
      requests: [confirm, allocate],
      assertionRequestIds: {
        payment_confirmed: confirm.id,
        allocation_persisted: allocate.id,
        derived_totals_reconciled: allocate.id,
      },
      readbacks: {
        payment_confirmed: readback.rows,
        allocation_persisted: readback.rows,
        derived_totals_reconciled: readback.rows,
      },
    };
  }));

  results.push(await flow("kpi_period_replace", ids.leadApproval, async () => {
    const request = await sessions.admin.request("POST", "/api/kpi/targets", {
      period: kpiPeriod,
      targets: [{ target_type: "revenue", target_amount: 1000, assigned_to: actorIds.sales, notes: "postdeploy acceptance fixture" }],
    });
    ensureSuccess(request, "flow_kpi_replace_http_failed");
    const readback = await db.query(
      `select id, period, target_type, target_amount, assigned_to, notes, set_by,
              count(*) over (partition by period, target_type, assigned_to)::int as duplicate_count
         from public.kpi_targets where period = $1`,
      [kpiPeriod],
    );
    if (
      readback.rows.length !== 1
      || readback.rows[0].target_type !== "revenue"
      || Number(readback.rows[0].target_amount) !== 1000
      || readback.rows[0].assigned_to !== actorIds.sales
      || readback.rows[0].notes !== fixture.marker
      || readback.rows[0].set_by !== actorIds.admin
      || Number(readback.rows[0].duplicate_count) !== 1
    ) refuse("flow_kpi_replace_readback_failed");
    fixture.kpiTargetId = readback.rows[0].id;
    return {
      requests: [request],
      fixtureId: fixture.kpiTargetId,
      readbacks: {
        period_replaced: readback.rows,
        no_duplicate_targets: readback.rows,
        target_readback_matches: readback.rows,
      },
    };
  }));
  return results;
}

async function fixtureObjects(db, fixture) {
  const leadIds = [
    fixture.ids.leadWon,
    fixture.ids.leadQuotation,
    fixture.ids.leadTransition,
    fixture.ids.leadApproval,
    fixture.ids.leadPayment,
    fixture.ids.browserLead,
  ];
  const result = await db.query(
    `with fixture_leads as (select unnest($1::uuid[]) as id),
          fixture_contracts as (select id from public.contracts where lead_id in (select id from fixture_leads)),
          fixture_quotes as (select id from public.quotations where lead_id in (select id from fixture_leads)),
          fixture_payments as (select id from public.payments where contract_id in (select id from fixture_contracts)),
          related_ids as (
            select id from fixture_leads
            union select id from fixture_contracts
            union select id from fixture_quotes
            union select id from fixture_payments
          )
     select 'leads'::text as table_name, id from public.leads where id in (select id from fixture_leads)
     union all select 'contracts', id from fixture_contracts
     union all select 'quotations', id from fixture_quotes
     union all select 'installment_plans', id from public.installment_plans where contract_id in (select id from fixture_contracts)
     union all select 'payments', id from fixture_payments
     union all select 'payment_allocations', id from public.payment_allocations where payment_id in (select id from fixture_payments)
     union all select 'contract_approvals', id from public.contract_approvals where contract_id in (select id from fixture_contracts)
     union all select 'customers', id from public.customers where lead_id in (select id from fixture_leads)
     union all select 'projects', id from public.projects where lead_id in (select id from fixture_leads)
     union all select 'activities', id from public.activities where lead_id in (select id from fixture_leads)
     union all select 'business_events', id from public.business_events where lead_id in (select id from fixture_leads)
     union all select 'chat_messages', id from public.chat_messages where lead_id in (select id from fixture_leads)
     union all select 'follow_up_logs', id from public.follow_up_logs where lead_id in (select id from fixture_leads)
     union all select 'knx_designs', id from public.knx_designs where lead_id in (select id from fixture_leads)
     union all select 'lead_documents', id from public.lead_documents where lead_id in (select id from fixture_leads)
     union all select 'lead_files', id from public.lead_files where lead_id in (select id from fixture_leads)
     union all select 'lead_milestones', id from public.lead_milestones where lead_id in (select id from fixture_leads)
     union all select 'lead_mutation_requests', id from public.lead_mutation_requests where lead_id in (select id from fixture_leads)
     union all select 'lead_workflow_stages', id from public.lead_workflow_stages where lead_id in (select id from fixture_leads)
     union all select 'quotes', id from public.quotes where lead_id in (select id from fixture_leads)
     union all select 'tasks', id from public.tasks where lead_id in (select id from fixture_leads)
     union all select 'transfer_history', id from public.transfer_history where lead_id in (select id from fixture_leads)
     union all select 'notifications', id from public.notifications where related_id in (select id::text from related_ids)
     union all select 'audit_logs', id from public.audit_logs where target_id in (select id from related_ids)
     union all select 'kpi_targets', id from public.kpi_targets
       where period = $2 and notes = $3 and ($4::uuid is null or set_by = $4::uuid)
     order by table_name, id`,
    [leadIds, fixture.kpiPeriod, fixture.marker, fixture.actorIds?.admin ?? null],
  );
  return result.rows.map((row) => ({ table: row.table_name, id: row.id }));
}

async function assertFixturePaymentSafeToDelete(db, fixture) {
  const state = await paymentState(db, fixture.ids.payment);
  if (state === null) return;
  if (state.confirmed === true || (state.confirmed !== false && state.confirmed !== null)) {
    refuse("fixture_payment_not_reversed");
  }
  if (state.voided_at !== null) {
    const effect = fixture.paymentEffect;
    if (
      !effect
      || effect.payment_id !== fixture.ids.payment
      || effect.voided_at === null
      || effect.restored_at === null
      || effect.restored_sha256 !== effect.baseline_sha256
    ) refuse("fixture_payment_reversal_proof_missing");
  } else if (fixture.paymentEffect?.confirmed_at !== null && fixture.paymentEffect?.confirmed_at !== undefined) {
    refuse("fixture_payment_reversal_proof_missing");
  }
}

export function compareFixtureInventory(expectedObjects, currentObjects, { allowAlreadyMissing = false } = {}) {
  const objectKey = (entry) => `${entry.table}:${entry.id}`;
  const currentKeys = new Set(currentObjects.map(objectKey));
  const expectedKeys = new Set(expectedObjects.map(objectKey));
  if (currentKeys.size !== currentObjects.length || expectedKeys.size !== expectedObjects.length) {
    refuse("fixture_inventory_duplicate_object");
  }
  const unexpectedObjects = currentObjects.filter((entry) => !expectedKeys.has(objectKey(entry)));
  const alreadyMissing = expectedObjects.filter((entry) => !currentKeys.has(objectKey(entry)));
  if (unexpectedObjects.length > 0 || (!allowAlreadyMissing && alreadyMissing.length > 0)) {
    refuse("fixture_inventory_changed_before_cleanup");
  }
  return { alreadyMissing };
}

async function cleanupFixtures(db, fixture, { expectedObjects = null, allowAlreadyClean = false } = {}) {
  await assertFixturePaymentSafeToDelete(db, fixture);
  const inventoryBeforeCleanup = await fixtureObjects(db, fixture);
  const createdObjects = expectedObjects ?? inventoryBeforeCleanup;
  const { alreadyMissing } = compareFixtureInventory(createdObjects, inventoryBeforeCleanup, { allowAlreadyMissing: allowAlreadyClean });
  if (createdObjects.length === 0 && !allowAlreadyClean) refuse("fixture_inventory_empty");
  if (inventoryBeforeCleanup.length === 0 && allowAlreadyClean) {
    return {
      createdObjects,
      cleanedObjects: [],
      residualObjects: [],
      alreadyMissing,
      verifiedAt: utcSecond(),
      paymentReversal: fixture.paymentEffect ?? null,
    };
  }
  const leadIds = [
    fixture.ids.leadWon,
    fixture.ids.leadQuotation,
    fixture.ids.leadTransition,
    fixture.ids.leadApproval,
    fixture.ids.leadPayment,
    fixture.ids.browserLead,
  ];
  let foreignKpiRowPresent = false;
  await db.query("begin");
  try {
    await db.query(
      "select pg_advisory_xact_lock(hashtextextended('public.kpi_targets:' || $1, 0))",
      [fixture.kpiPeriod],
    );
    const kpiRows = await db.query(
      "select id, notes, set_by from public.kpi_targets where period = $1 order by id for update",
      [fixture.kpiPeriod],
    );
    const expectedKpiIds = new Set(createdObjects.filter((entry) => entry.table === "kpi_targets").map((entry) => entry.id));
    const expectedActor = fixture.actorIds?.admin ?? null;
    const matchingRows = kpiRows.rows.filter((row) => (
      expectedKpiIds.has(row.id)
      && row.notes === fixture.marker
      && expectedActor !== null
      && row.set_by === expectedActor
    ));
    const mismatchedExpected = kpiRows.rows.some((row) => expectedKpiIds.has(row.id) && !matchingRows.some((match) => match.id === row.id));
    if (mismatchedExpected || (!allowAlreadyClean && matchingRows.length !== expectedKpiIds.size)) {
      refuse("fixture_kpi_identity_mismatch");
    }
    foreignKpiRowPresent = kpiRows.rows.some((row) => !expectedKpiIds.has(row.id));
    if (matchingRows.length > 0) {
      const removed = await db.query(
        "delete from public.kpi_targets where id = any($1::uuid[]) and period = $2 and notes = $3 and set_by = $4 returning id",
        [[...expectedKpiIds], fixture.kpiPeriod, fixture.marker, expectedActor],
      );
      if (removed.rows.length !== matchingRows.length) refuse("fixture_kpi_delete_mismatch");
    }
    await db.query(
      `delete from public.notifications
        where related_id in (
          select id::text from public.contracts where lead_id = any($1::uuid[])
          union select id::text from public.payments where contract_id in (select id from public.contracts where lead_id = any($1::uuid[]))
          union select id::text from public.quotations where lead_id = any($1::uuid[])
          union select id::text from public.leads where id = any($1::uuid[])
        )`,
      [leadIds],
    );
    await db.query(
      `delete from public.audit_logs
        where target_id in (
          select id from public.contracts where lead_id = any($1::uuid[])
          union select id from public.payments where contract_id in (select id from public.contracts where lead_id = any($1::uuid[]))
          union select id from public.quotations where lead_id = any($1::uuid[])
          union select id from public.leads where id = any($1::uuid[])
        )`,
      [leadIds],
    );
    for (const table of [
      "activities",
      "business_events",
      "chat_messages",
      "follow_up_logs",
      "knx_designs",
      "lead_documents",
      "lead_files",
      "lead_milestones",
      "lead_mutation_requests",
      "lead_workflow_stages",
      "quotes",
      "tasks",
      "transfer_history",
    ]) {
      await db.query(`delete from public.${table} where lead_id = any($1::uuid[])`, [leadIds]);
    }
    await db.query(
      "update public.quotations set contract_id = null where lead_id = any($1::uuid[])",
      [leadIds],
    );
    await db.query(
      "update public.contracts set quotation_id = null where lead_id = any($1::uuid[])",
      [leadIds],
    );
    await db.query(
      "delete from public.payment_allocations where payment_id in (select id from public.payments where contract_id in (select id from public.contracts where lead_id = any($1::uuid[])))",
      [leadIds],
    );
    await db.query(
      "delete from public.payments where contract_id in (select id from public.contracts where lead_id = any($1::uuid[]))",
      [leadIds],
    );
    await db.query(
      "delete from public.installment_plans where contract_id in (select id from public.contracts where lead_id = any($1::uuid[]))",
      [leadIds],
    );
    await db.query(
      "delete from public.contract_approvals where contract_id in (select id from public.contracts where lead_id = any($1::uuid[]))",
      [leadIds],
    );
    await db.query("delete from public.projects where lead_id = any($1::uuid[])", [leadIds]);
    await db.query("delete from public.contracts where lead_id = any($1::uuid[])", [leadIds]);
    await db.query("delete from public.quotations where lead_id = any($1::uuid[])", [leadIds]);
    await db.query("delete from public.customers where lead_id = any($1::uuid[])", [leadIds]);
    await db.query("delete from public.leads where id = any($1::uuid[])", [leadIds]);
    await db.query("commit");
  } catch {
    await db.query("rollback").catch(() => {});
    refuse("fixture_cleanup_failed");
  }
  const residualObjects = await fixtureObjects(db, fixture);
  if (residualObjects.length !== 0) refuse("fixture_cleanup_residuals");
  if (foreignKpiRowPresent && !allowAlreadyClean) refuse("fixture_kpi_foreign_row_present");
  const createdIds = createdObjects.map((entry) => entry.id);
  if (new Set(createdIds).size !== createdIds.length) refuse("fixture_inventory_duplicate_uuid");
  return {
    createdObjects,
    cleanedObjects: inventoryBeforeCleanup,
    residualObjects,
    alreadyMissing,
    verifiedAt: utcSecond(),
    paymentReversal: fixture.paymentEffect ?? null,
  };
}

async function measurePerformance(releaseSha, fetchImpl = fetch, sampleCount = 20, signal = null) {
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const started = performance.now();
    let response;
    try {
      response = await fetchImpl(`${PRODUCTION_ORIGIN}/api/health`, {
        headers: { accept: "application/json", "cache-control": "no-store" },
        redirect: "error",
        signal: signal ? AbortSignal.any([AbortSignal.timeout(10_000), signal]) : AbortSignal.timeout(10_000),
      });
    } catch {
      if (signal?.aborted) refuse("uat_interrupted");
      refuse("performance_probe_unreachable");
    }
    const elapsed = Math.max(0, Math.round(performance.now() - started));
    if (response.status !== 200) refuse("performance_probe_http_failed");
    let health;
    try {
      health = await response.json();
    } catch {
      refuse("performance_probe_response_invalid");
    }
    if (![health?.release, health?.version].includes(releaseSha)) refuse("performance_probe_release_mismatch");
    samples.push(elapsed);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value) => sorted[Math.ceil(value * sorted.length) - 1];
  return { samples, p75: percentile(0.75), p95: percentile(0.95), measuredAt: utcSecond() };
}

function systemdValue(property) {
  try {
    return execFileSync("/usr/bin/systemctl", ["show", "newme-platform.service", "-p", property, "--value"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    refuse(`systemd_${property.toLowerCase()}_read_failed`);
  }
}

function currentSystemdRuntime() {
  const runtime = {
    nrestarts: Number(systemdValue("NRestarts")),
    main_pid: Number(systemdValue("MainPID")),
    invocation_id: systemdValue("InvocationID"),
    exec_main_start_monotonic: Number(systemdValue("ExecMainStartTimestampMonotonic")),
  };
  if (
    systemdValue("ActiveState") !== "active"
    || !Number.isSafeInteger(runtime.nrestarts)
    || runtime.nrestarts < 0
    || !Number.isSafeInteger(runtime.main_pid)
    || runtime.main_pid <= 0
    || !/^[0-9a-f]{32}$/.test(runtime.invocation_id)
    || !Number.isSafeInteger(runtime.exec_main_start_monotonic)
    || runtime.exec_main_start_monotonic <= 0
  ) refuse("service_runtime_invalid");
  return runtime;
}

export function assertNoServiceRestartSinceDeploy(expected, current) {
  for (const key of ["nrestarts", "main_pid", "invocation_id", "exec_main_start_monotonic"]) {
    if (current[key] !== expected[key]) refuse("service_restarted_since_deploy");
  }
}

async function delayedReadback({
  releaseRoot,
  releaseSha,
  deployedAt,
  alertSecret,
  recoveryEventId,
  recoveryProviderDeliveryId,
  recoveryProviderOperationId,
  serviceRuntimeBaseline,
  signal,
  fetchImpl = fetch,
  sleep = (milliseconds) => sleepWithSignal(milliseconds, signal),
}) {
  const notBeforeMs = Date.parse(deployedAt) + 900_000;
  const waitMs = notBeforeMs - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  const notBefore = utcSecond(new Date(notBeforeMs));
  const checkTimes = {};
  let health;
  try {
    const response = await fetchImpl(`${PRODUCTION_ORIGIN}/api/health`, {
      headers: { accept: "application/json", "cache-control": "no-store" },
      redirect: "error",
      signal: signal ? AbortSignal.any([AbortSignal.timeout(10_000), signal]) : AbortSignal.timeout(10_000),
    });
    health = await response.json();
    if (response.status !== 200 || ![health?.release, health?.version].includes(releaseSha)) refuse("delayed_service_release_mismatch");
  } catch (error) {
    if (error instanceof ProducerError) throw error;
    if (signal?.aborted) refuse("uat_interrupted");
    refuse("delayed_service_probe_failed");
  }
  checkTimes.service = utcSecond();

  let criticalLogs;
  try {
    criticalLogs = execFileSync(
      "/usr/bin/journalctl",
      ["-u", "newme-platform.service", "--since", deployedAt, "-p", "0..3", "--no-pager", "--output=json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 },
    ).split(/\r?\n/).filter(Boolean);
  } catch {
    refuse("delayed_logs_read_failed");
  }
  if (criticalLogs.length !== 0) refuse("delayed_critical_logs_present");
  checkTimes.logs = utcSecond();
  const providerResult = await readDelayedAlertProviderState({
    releaseRoot,
    releaseSha,
    secret: alertSecret,
    recoveryEventId,
    recoveryProviderDeliveryId,
    recoveryProviderOperationId,
    notBefore,
    signal,
  });
  const providerReadback = providerResult.receipt;
  if (providerReadback.status !== "ok" || Date.parse(providerReadback.occurred_at) > Date.now()) refuse("delayed_alert_state_invalid");
  checkTimes.alerts = providerReadback.occurred_at;
  assertNoServiceRestartSinceDeploy(serviceRuntimeBaseline, currentSystemdRuntime());
  checkTimes.restarts = utcSecond();
  const completedAt = utcSecond();
  return {
    notBefore,
    completedAt,
    checks: ["service", "logs", "alerts", "restarts"].map((id) => ({ id, status: "pass", completed_at: checkTimes[id] })),
    providerReadback,
    providerReadbackTrigger: providerResult.trigger,
  };
}

function artifactDocument({ kind, release, observedAt, payload, privateKeyBytes, signedAt }) {
  return signPostdeployArtifact({
    artifact: {
      artifact_version: ARTIFACT_VERSION,
      kind,
      release: {
        git_sha: release.git_sha,
        build_id: release.build_id,
        deploy_run_id: release.deploy_run_id,
      },
      observed_at: observedAt,
      payload,
    },
    producer: payload.runner,
    signedAt,
    privateKeyBytes,
  });
}

export function assemblePostdeployBundle({
  release,
  policyBytes,
  schemaBytes,
  receiptPublicKeyBytes,
  receiptPrivateKeyBytes,
  sessions,
  browserResult,
  flowResults,
  cleanup,
  alertPair,
  performanceResult,
  delayedResult,
  generatedAt,
}) {
  const receiptKeySha256 = receiptPublicKeySha256(receiptPublicKeyBytes);
  const signedAt = generatedAt;
  const artifacts = [];
  const documents = new Map();
  const add = (id, kind, observedAt, payload) => {
    const document = artifactDocument({ kind, release, observedAt, payload, privateKeyBytes: receiptPrivateKeyBytes, signedAt });
    try {
      verifyPostdeployArtifactReceipt({
        document,
        publicKeyBytes: receiptPublicKeyBytes,
        expectedProducer: payload.runner,
      });
    } catch {
      refuse("receipt_key_pair_mismatch");
    }
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    const file = `${id}.json`;
    artifacts.push({ id, kind, path: file, sha256: sha256(bytes), media_type: "application/json" });
    documents.set(file, bytes);
  };
  const flowByCoordinator = new Map(REQUIRED_ROLES.map((role) => [role, []]));
  for (const flow of flowResults) flowByCoordinator.get(FLOW_POLICY[flow.id].coordinator).push(flow);
  const roles = [];
  for (const role of REQUIRED_ROLES) {
    const session = sessions[role];
    const roleFlows = flowByCoordinator.get(role);
    const completedAt = session.checks.find((check) => check.id === "post_logout_denied")?.completed_at;
    const artifactId = `role_${role}`;
    roles.push({
      role,
      actor_id: session.actorId,
      status: "pass",
      completed_at: completedAt,
      flow_ids: roleFlows.map((flow) => flow.id),
      artifact_id: artifactId,
    });
    add(artifactId, "role_uat", completedAt, {
      runner: "newme-postdeploy-uat/v1",
      runner_run_id: `uat:role:${role}:${release.deploy_run_id}`,
      role,
      actor_id: session.actorId,
      status: "pass",
      started_at: session.startedAt,
      completed_at: completedAt,
      session_checks: session.checks,
      flows: roleFlows,
    });
  }
  if (
    !isObject(browserResult)
    || !Array.isArray(browserResult.sessions)
    || browserResult.sessions.length !== 8
    || !Array.isArray(browserResult.artifacts)
    || browserResult.artifacts.length !== 8
    || !(browserResult.documents instanceof Map)
  ) refuse("browser_evidence_missing");
  for (const artifact of browserResult.artifacts) artifacts.push(structuredClone(artifact));
  for (const [file, bytes] of browserResult.documents) {
    if (documents.has(file)) refuse("browser_evidence_path_collision");
    documents.set(file, bytes);
  }
  const bundleFlows = flowResults.map((flow) => ({
    id: flow.id,
    role: FLOW_POLICY[flow.id].coordinator,
    status: flow.status,
    started_at: flow.started_at,
    completed_at: flow.completed_at,
    artifact_id: `role_${FLOW_POLICY[flow.id].coordinator}`,
  }));
  const createdIds = cleanup.createdObjects.map((entry) => entry.id);
  const cleanedIds = cleanup.cleanedObjects.map((entry) => entry.id);
  const reversal = cleanup.paymentReversal;
  if (
    !reversal
    || !UUID.test(reversal.payment_id ?? "")
    || reversal.voided_at === null
    || reversal.void_request === null
    || reversal.restored_at === null
    || reversal.restored_sha256 !== reversal.baseline_sha256
  ) refuse("fixture_payment_reversal_proof_missing");
  const paymentReversalClaim = {
    payment_id: reversal.payment_id,
    payment_status: "voided",
    payment_void_request_id: reversal.void_request.id,
    payment_void_receipt_sha256: reversal.void_request.response_sha256,
    payment_voided_at: reversal.voided_at,
    kpi_baseline_sha256: reversal.baseline_sha256,
    kpi_restored_sha256: reversal.restored_sha256,
  };
  add("fixture_cleanup", "fixture_cleanup", cleanup.verifiedAt, {
    runner: "newme-postdeploy-fixture-audit/v1",
    query_run_id: `fixture:audit:${release.deploy_run_id}`,
    created_ids: createdIds,
    cleaned_ids: cleanedIds,
    residual_count: cleanup.residualObjects.length,
    verified_at: cleanup.verifiedAt,
    ...paymentReversalClaim,
  });
  add("alert_drill", "alert_drill", alertPair.recovery.occurred_at, {
    runner: "newme-postdeploy-alert-drill/v1",
    drill_run_id: `alert:drill:${release.deploy_run_id}`,
    failure_event_id: alertPair.failure.event_id,
    recovery_event_id: alertPair.recovery.event_id,
    failure_provider_delivery_id: alertPair.failure.provider_delivery_id,
    recovery_provider_delivery_id: alertPair.recovery.provider_delivery_id,
    failure_provider_operation_id: alertPair.failure.provider_operation_id,
    recovery_provider_operation_id: alertPair.recovery.provider_operation_id,
    failure_trigger_sha256: alertPair.failureTrigger.trigger_sha256,
    recovery_trigger_sha256: alertPair.recoveryTrigger.trigger_sha256,
    failure_receipt_sha256: alertPair.failure.body_sha256,
    recovery_receipt_sha256: alertPair.recovery.body_sha256,
    failed_at: alertPair.failure.occurred_at,
    recovered_at: alertPair.recovery.occurred_at,
    final_status: "ok",
  });
  add("performance", "performance", performanceResult.measuredAt, {
    runner: "newme-postdeploy-performance/v1",
    measurement_run_id: `performance:run:${release.deploy_run_id}`,
    samples_ms: performanceResult.samples,
    p75_ms: performanceResult.p75,
    p95_ms: performanceResult.p95,
    measured_at: performanceResult.measuredAt,
  });
  add("delayed_verify", "delayed_verification", delayedResult.completedAt, {
    runner: "newme-postdeploy-delayed-verification/v1",
    verification_run_id: `delayed:run:${release.deploy_run_id}`,
    not_before: delayedResult.notBefore,
    completed_at: delayedResult.completedAt,
    status: "pass",
    checks: delayedResult.checks,
    provider_trigger_sha256: delayedResult.providerReadbackTrigger.trigger_sha256,
    provider_event_id: delayedResult.providerReadback.event_id,
    provider_delivery_id: delayedResult.providerReadback.provider_delivery_id,
    provider_query_id: delayedResult.providerReadback.provider_operation_id,
    provider_receipt_sha256: delayedResult.providerReadback.body_sha256,
    provider_observed_at: delayedResult.providerReadback.occurred_at,
  });
  const bundle = {
    schema_version: "newme-postdeploy-evidence/v1",
    policy: { path: POLICY_PATH, sha256: sha256(policyBytes) },
    schema: { path: SCHEMA_PATH, sha256: sha256(schemaBytes) },
    receipt_key_sha256: receiptKeySha256,
    release,
    roles,
    browser_uat: structuredClone(browserResult.sessions),
    flows: bundleFlows,
    fixtures: {
      created_ids: createdIds,
      cleaned_ids: cleanedIds,
      residual_count: cleanup.residualObjects.length,
      verified_at: cleanup.verifiedAt,
      ...paymentReversalClaim,
      artifact_id: "fixture_cleanup",
    },
    alert_drill: {
      failure_event_id: alertPair.failure.event_id,
      recovery_event_id: alertPair.recovery.event_id,
      failure_provider_delivery_id: alertPair.failure.provider_delivery_id,
      recovery_provider_delivery_id: alertPair.recovery.provider_delivery_id,
      failure_provider_operation_id: alertPair.failure.provider_operation_id,
      recovery_provider_operation_id: alertPair.recovery.provider_operation_id,
      failure_trigger_sha256: alertPair.failureTrigger.trigger_sha256,
      recovery_trigger_sha256: alertPair.recoveryTrigger.trigger_sha256,
      failure_receipt_sha256: alertPair.failure.body_sha256,
      recovery_receipt_sha256: alertPair.recovery.body_sha256,
      failed_at: alertPair.failure.occurred_at,
      recovered_at: alertPair.recovery.occurred_at,
      final_status: "ok",
      artifact_id: "alert_drill",
    },
    performance: {
      samples_ms: performanceResult.samples,
      p75_ms: performanceResult.p75,
      p95_ms: performanceResult.p95,
      measured_at: performanceResult.measuredAt,
      artifact_id: "performance",
    },
    delayed_verification: {
      not_before: delayedResult.notBefore,
      completed_at: delayedResult.completedAt,
      status: "pass",
      provider_trigger_sha256: delayedResult.providerReadbackTrigger.trigger_sha256,
      provider_event_id: delayedResult.providerReadback.event_id,
      provider_delivery_id: delayedResult.providerReadback.provider_delivery_id,
      provider_query_id: delayedResult.providerReadback.provider_operation_id,
      provider_receipt_sha256: delayedResult.providerReadback.body_sha256,
      provider_observed_at: delayedResult.providerReadback.occurred_at,
      artifact_id: "delayed_verify",
    },
    artifacts,
    generated_at: generatedAt,
  };
  documents.set("bundle.json", Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8"));
  return { bundle, documents };
}

function writeDurableExclusive(filePath, bytes) {
  const descriptor = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function canonicalBundleDocumentPath(file) {
  if (
    typeof file !== "string"
    || file.length < 3
    || file.length > 1024
    || file.includes("\\")
    || file.startsWith("/")
    || path.posix.normalize(file) !== file
    || file.split("/").some((part) => part === "" || part === "." || part === "..")
  ) refuse("bundle_document_path_invalid");
  return file;
}

function publishBundle(releaseSha, documents) {
  if (!existsSync(OUTPUT_ROOT)) mkdirSync(OUTPUT_ROOT, { mode: 0o700 });
  chmodSync(OUTPUT_ROOT, 0o700);
  const rootMetadata = lstatSync(OUTPUT_ROOT);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || rootMetadata.uid !== 0 || rootMetadata.gid !== 0 || (rootMetadata.mode & 0o077) !== 0) {
    refuse("output_root_untrusted");
  }
  const finalDirectory = path.join(OUTPUT_ROOT, releaseSha);
  if (existsSync(finalDirectory)) refuse("output_already_exists");
  const staging = path.join(OUTPUT_ROOT, `.${releaseSha}.${process.pid}.${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const directories = new Set([staging]);
    for (const [file, bytes] of documents) {
      const relative = canonicalBundleDocumentPath(file);
      const parent = path.join(staging, ...relative.split("/").slice(0, -1));
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      let cursor = parent;
      while (cursor.startsWith(`${staging}${path.sep}`)) {
        chmodSync(cursor, 0o700);
        const metadata = lstatSync(cursor);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || metadata.gid !== 0) {
          refuse("bundle_document_directory_untrusted");
        }
        directories.add(cursor);
        cursor = path.dirname(cursor);
      }
      writeDurableExclusive(path.join(staging, ...relative.split("/")), bytes);
    }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) fsyncDirectory(directory);
    renameSync(staging, finalDirectory);
    fsyncDirectory(OUTPUT_ROOT);
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: false });
  }
  return path.join(finalDirectory, "bundle.json");
}

function releaseEvidence(releaseSha) {
  const releaseRoot = `/opt/newme/releases/${releaseSha}`;
  const current = realpathSync("/opt/newme/current");
  if (current !== releaseRoot) refuse("release_is_not_current");
  const audit = path.join(releaseRoot, ".audit");
  const candidates = readdirSync(audit).filter((name) => /^deploy-[A-Za-z0-9._-]+\.json$/.test(name));
  if (candidates.length !== 1) refuse("deployment_evidence_count_invalid");
  const evidence = parseJson(readProtectedFile(path.join(audit, candidates[0]), "deployment_evidence"), "deployment_evidence_invalid");
  const serviceRuntime = evidence.service_runtime;
  if (isObject(serviceRuntime)) {
    exactKeys(serviceRuntime, ["nrestarts", "main_pid", "invocation_id", "exec_main_start_monotonic", "observed_at"], "deployment_service_runtime_invalid");
  }
  if (
    evidence.git_sha !== releaseSha
    || evidence.release_status !== "awaiting_uat"
    || evidence.ci?.conclusion !== "success"
    || evidence.ci?.head_sha !== releaseSha
    || !/^[1-9][0-9]*$/.test(String(evidence.ci?.run_id ?? ""))
    || typeof evidence.build_id !== "string"
    || !UTC_SECOND.test(evidence.created_at ?? "")
    || !isObject(serviceRuntime)
    || !Number.isSafeInteger(serviceRuntime.nrestarts)
    || serviceRuntime.nrestarts < 0
    || !Number.isSafeInteger(serviceRuntime.main_pid)
    || serviceRuntime.main_pid <= 0
    || !/^[0-9a-f]{32}$/.test(serviceRuntime.invocation_id ?? "")
    || !Number.isSafeInteger(serviceRuntime.exec_main_start_monotonic)
    || serviceRuntime.exec_main_start_monotonic <= 0
    || !UTC_SECOND.test(serviceRuntime.observed_at ?? "")
    || Date.parse(serviceRuntime.observed_at) > Date.parse(evidence.created_at)
  ) refuse("deployment_evidence_semantic_invalid");
  return {
    releaseRoot,
    release: {
      git_sha: releaseSha,
      build_id: evidence.build_id,
      deploy_run_id: String(evidence.ci.run_id),
      deploy_run_url: `https://github.com/69755354/newme-platform/actions/runs/${evidence.ci.run_id}`,
      deployed_at: evidence.created_at,
    },
    serviceRuntime: {
      nrestarts: serviceRuntime.nrestarts,
      main_pid: serviceRuntime.main_pid,
      invocation_id: serviceRuntime.invocation_id,
      exec_main_start_monotonic: serviceRuntime.exec_main_start_monotonic,
    },
  };
}

async function loadPgClient(connectionString) {
  let pgModule;
  try {
    pgModule = await import("pg");
  } catch {
    refuse("pg_client_unavailable");
  }
  const Client = pgModule.Client ?? pgModule.default?.Client;
  if (typeof Client !== "function") refuse("pg_client_unavailable");
  const client = new Client({ connectionString, application_name: "newme-postdeploy-acceptance-v1" });
  try {
    await client.connect();
  } catch {
    refuse("database_connect_failed");
  }
  return client;
}

function sleepWithSignal(milliseconds, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  if (signal.aborted) return Promise.reject(new ProducerError("uat_interrupted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProducerError("uat_interrupted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function alertDirectory(releaseSha) {
  ensureProtectedDirectory(ALERT_INBOX_ROOT, "alert_inbox_root");
  return ensureProtectedDirectory(path.join(ALERT_INBOX_ROOT, releaseSha), "alert_inbox_release");
}

function alertStateDirectory(releaseSha) {
  ensureProtectedDirectory(ALERT_STATE_ROOT, "alert_state_root");
  return ensureProtectedDirectory(path.join(ALERT_STATE_ROOT, releaseSha), "alert_state_release");
}

function alertStatePaths(releaseSha) {
  const directory = path.join(ALERT_STATE_ROOT, releaseSha);
  const key = `postdeploy-acceptance-${releaseSha}`;
  return {
    directory,
    key,
    state: path.join(directory, `${key}.state`),
    lock: path.join(directory, `${key}.state.lock`),
  };
}

function validateAlertStateLock(paths) {
  const lock = lstatSync(paths.lock);
  if (
    !lock.isFile()
    || lock.isSymbolicLink()
    || lock.uid !== 0
    || lock.gid !== 0
    || (lock.mode & 0o777) !== 0o600
    || lock.size !== 0
  ) refuse("alert_state_lock_untrusted");
}

function readCanonicalAlertStatus(releaseSha) {
  const paths = alertStatePaths(releaseSha);
  if (!lstatExists(paths.directory)) return null;
  ensureProtectedDirectory(paths.directory, "alert_state_release");
  const allowed = new Set([path.basename(paths.state), path.basename(paths.lock)]);
  if (readdirSync(paths.directory).some((name) => !allowed.has(name))) refuse("alert_state_directory_untrusted");
  if (!lstatExists(paths.state)) {
    if (lstatExists(paths.lock)) validateAlertStateLock(paths);
    return null;
  }
  if (!lstatExists(paths.lock)) refuse("alert_state_lock_missing");
  validateAlertStateLock(paths);
  const body = readProtectedFile(paths.state, "alert_state", 4096).toString("utf8");
  const match = /^status=(ok|firing|pending_failure|pending_recovery)\nfailure_count=([0-9]+)\n$/.exec(body);
  if (!match) refuse("alert_state_transition_invalid");
  return { status: match[1], failureCount: Number(match[2]), paths };
}

function stageUncertainFailureState(releaseSha) {
  const paths = alertStatePaths(releaseSha);
  ensureProtectedDirectory(paths.directory, "alert_state_release");
  if (lstatExists(paths.state)) return;
  if (lstatExists(paths.lock)) {
    validateAlertStateLock(paths);
  } else {
    const lockDescriptor = openSync(paths.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    fsyncSync(lockDescriptor);
    closeSync(lockDescriptor);
  }
  const descriptor = openSync(paths.state, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(descriptor, "status=pending_failure\nfailure_count=1\n");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(paths.directory);
}

function assertCanonicalAlertState(releaseSha, expected) {
  const paths = alertStatePaths(releaseSha);
  const body = readProtectedFile(paths.state, "alert_state", 4096).toString("utf8");
  if (body !== expected) refuse("alert_state_transition_invalid");
  validateAlertStateLock(paths);
  return paths;
}

function removeRecoveredAlertState(releaseSha) {
  const paths = assertCanonicalAlertState(releaseSha, "status=ok\nfailure_count=0\n");
  rmSync(paths.state, { force: false });
  rmSync(paths.lock, { force: false });
  fsyncDirectory(paths.directory);
  if (readdirSync(paths.directory).length !== 0) refuse("alert_state_cleanup_incomplete");
  rmdirSync(paths.directory);
  fsyncDirectory(ALERT_STATE_ROOT);
}

function installedObservabilityAsset(releaseRoot, name) {
  const releaseAsset = path.join(releaseRoot, "infra/observability", name);
  const installedAsset = path.join("/opt/hermes-scripts/observability", name);
  const metadata = lstatSync(installedAsset);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== 0
    || metadata.gid !== 0
    || (metadata.mode & 0o022) !== 0
    || (metadata.mode & 0o111) === 0
  ) refuse("alert_provider_asset_untrusted");
  if (sha256(readFileSync(installedAsset)) !== sha256(readFileSync(releaseAsset))) refuse("alert_provider_asset_release_mismatch");
  return installedAsset;
}

function invokeProviderWriter({ releaseRoot, releaseSha, mode, triggerSha256 }) {
  const provider = installedObservabilityAsset(releaseRoot, "newme-alert-provider-v1.mjs");
  let output;
  try {
    output = execFileSync(provider, [mode, releaseSha], {
      encoding: "utf8",
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
  } catch {
    refuse(`alert_${mode}_provider_receipt_failed`);
  }
  const fields = output.trim().split(" ");
  if (
    fields.length !== 6
    || fields[0] !== "newme-alert-provider-v1"
    || fields[1] !== "receipt"
    || fields[2] !== mode
    || fields[3] !== releaseSha
    || fields[4] !== triggerSha256
    || !/^telegram:message:[1-9][0-9]*$/.test(fields[5])
  ) refuse(`alert_${mode}_provider_ack_invalid`);
}

function invokeAlertStateTransition({
  stateMachine,
  notifier,
  stateDirectory,
  releaseSha,
  eventType,
  triggerSha256,
}) {
  const key = `postdeploy-acceptance-${releaseSha}`;
  let output;
  try {
    output = execFileSync(stateMachine, [
      key,
      eventType,
      `canonical postdeploy ${eventType}; receipt_challenge=${triggerSha256}`,
    ], {
      encoding: "utf8",
      env: {
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/root",
        HERMES_ALERT_STATE_DIR: stateDirectory,
        HERMES_ALERT_NOTIFIER: notifier,
        NEWME_ALERT_DRILL_MODE: eventType,
        NEWME_ALERT_DRILL_RELEASE_SHA: releaseSha,
        NEWME_ALERT_DRILL_TRIGGER_SHA256: triggerSha256,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
  } catch {
    refuse(`alert_${eventType}_state_transition_failed`);
  }
  const expected = eventType === "failure"
    ? `hermes-alert-state-v1 transition=alert key=${key} failure_count=1 capture=1`
    : `hermes-alert-state-v1 transition=recovery key=${key}`;
  if (!output.split(/\r?\n/).includes(expected)) refuse(`alert_${eventType}_state_transition_invalid`);
  assertCanonicalAlertState(
    releaseSha,
    eventType === "failure" ? "status=firing\nfailure_count=1\n" : "status=ok\nfailure_count=0\n",
  );
}

function readExistingCanonicalAlertTrigger(releaseSha, eventType) {
  const triggerPath = path.join(alertDirectory(releaseSha), `${eventType}-trigger.json`);
  if (!lstatExists(triggerPath)) return null;
  const triggerBytes = readProtectedFile(triggerPath, `alert_${eventType}_trigger`);
  const trigger = parseJson(triggerBytes, `alert_${eventType}_trigger_invalid`);
  exactKeys(trigger, [
    "trigger_version",
    "pipeline_version",
    "alert_key",
    "release_sha",
    "event_type",
    "trigger_id",
    "triggered_at",
  ], `alert_${eventType}_trigger_shape_invalid`);
  if (
    trigger.trigger_version !== "newme-alert-trigger/v1"
    || trigger.pipeline_version !== ALERT_PIPELINE_VERSION
    || trigger.alert_key !== `postdeploy-acceptance-${releaseSha}`
    || trigger.release_sha !== releaseSha
    || trigger.event_type !== eventType
    || !EVENT_ID.test(trigger.trigger_id)
    || !UTC_SECOND.test(trigger.triggered_at)
  ) refuse(`alert_${eventType}_trigger_semantic_invalid`);
  return { ...trigger, trigger_sha256: sha256(triggerBytes) };
}

function triggerCanonicalAlert({ releaseRoot, releaseSha, eventType, reuseExisting = false }) {
  if (!["failure", "recovery"].includes(eventType)) refuse("alert_trigger_type_invalid");
  const stateDirectory = alertStateDirectory(releaseSha);
  if (eventType === "failure" && readdirSync(stateDirectory).length !== 0) refuse("alert_state_recovery_required");
  const alertKey = `postdeploy-acceptance-${releaseSha}`;
  const directory = alertDirectory(releaseSha);
  const triggerPath = path.join(directory, `${eventType}-trigger.json`);
  let trigger = readExistingCanonicalAlertTrigger(releaseSha, eventType);
  if (trigger && !reuseExisting) refuse(`alert_${eventType}_trigger_recovery_required`);
  if (!trigger) {
    trigger = {
      trigger_version: "newme-alert-trigger/v1",
      pipeline_version: ALERT_PIPELINE_VERSION,
      alert_key: alertKey,
      release_sha: releaseSha,
      event_type: eventType,
      trigger_id: `alert:${eventType}:${releaseSha.slice(0, 12)}:${randomUUID()}`,
      triggered_at: utcSecond(),
    };
    writeProtectedJson(triggerPath, trigger, { exclusive: true });
    trigger = readExistingCanonicalAlertTrigger(releaseSha, eventType);
  }
  const stateMachine = installedObservabilityAsset(releaseRoot, "hermes-alert-state-v1.sh");
  const notifier = installedObservabilityAsset(releaseRoot, "hermes-alert-notifier-v1.sh");
  invokeAlertStateTransition({
    stateMachine,
    notifier,
    stateDirectory,
    releaseSha,
    eventType,
    triggerSha256: trigger.trigger_sha256,
  });
  if (eventType === "recovery") removeRecoveredAlertState(releaseSha);
  return trigger;
}

function recoverCanonicalAlertState({ releaseRoot, releaseSha }) {
  const failureTrigger = readExistingCanonicalAlertTrigger(releaseSha, "failure");
  let current = readCanonicalAlertStatus(releaseSha);
  if (!current && !failureTrigger) return "not_triggered";
  if (!current) {
    stageUncertainFailureState(releaseSha);
    current = readCanonicalAlertStatus(releaseSha);
  }
  if (current.status === "ok") {
    removeRecoveredAlertState(releaseSha);
    return "already_recovered";
  }
  triggerCanonicalAlert({ releaseRoot, releaseSha, eventType: "recovery", reuseExisting: true });
  return "recovery_confirmed";
}

function triggerCanonicalProviderReadback({ releaseRoot, releaseSha, recoveryEventId }) {
  const trigger = {
    trigger_version: "newme-alert-readback-trigger/v1",
    release_sha: releaseSha,
    event_type: "readback",
    trigger_id: `alert:readback:${releaseSha.slice(0, 12)}:${randomUUID()}`,
    triggered_at: utcSecond(),
    recovery_event_id: recoveryEventId,
  };
  const triggerPath = path.join(alertDirectory(releaseSha), "readback-trigger.json");
  writeProtectedJson(triggerPath, trigger, { exclusive: true });
  const triggerSha256 = sha256(readProtectedFile(triggerPath, "alert_readback_trigger"));
  invokeProviderWriter({ releaseRoot, releaseSha, mode: "readback", triggerSha256 });
  return { ...trigger, trigger_sha256: triggerSha256 };
}

async function waitForAlertReceipt({ releaseSha, name, signal, maximumWaitMs = ALERT_RECEIPT_WAIT_MS }) {
  const directory = alertDirectory(releaseSha);
  const bodyPath = path.join(directory, `${name}.json`);
  const signaturePath = path.join(directory, `${name}.hmac`);
  const deadline = Date.now() + maximumWaitMs;
  while (Date.now() <= deadline) {
    if (lstatExists(bodyPath) && lstatExists(signaturePath)) {
      return {
        body: readProtectedFile(bodyPath, `alert_${name}_body`),
        signature: readProtectedFile(signaturePath, `alert_${name}_signature`, 4096),
      };
    }
    await sleepWithSignal(Math.min(1000, Math.max(1, deadline - Date.now())), signal);
  }
  refuse(`alert_${name}_receipt_timeout`);
}

async function runCanonicalAlertDrill({ releaseRoot, releaseSha, secret, journal, signal }) {
  const failureTrigger = triggerCanonicalAlert({ releaseRoot, releaseSha, eventType: "failure" });
  recordJournalStep(journal, "alert_failure_triggered", [failureTrigger]);
  const failureInput = await waitForAlertReceipt({ releaseSha, name: "failure", signal });
  const verifiedFailure = verifyProviderReceipt({
    bodyBytes: failureInput.body,
    signatureBytes: failureInput.signature,
    secret,
    expectedType: "failure",
    releaseSha,
    expectedTriggerSha: failureTrigger.trigger_sha256,
  });
  const recoveryDelayMs = Math.max(0, Date.parse(verifiedFailure.occurred_at) + 1050 - Date.now());
  if (recoveryDelayMs > 0) await sleepWithSignal(recoveryDelayMs, signal);
  const recoveryTrigger = triggerCanonicalAlert({ releaseRoot, releaseSha, eventType: "recovery" });
  recordJournalStep(journal, "alert_recovery_triggered", [recoveryTrigger]);
  const recoveryInput = await waitForAlertReceipt({ releaseSha, name: "recovery", signal });
  const pair = verifyAlertProviderPair({
    failureBody: failureInput.body,
    failureSignature: failureInput.signature,
    recoveryBody: recoveryInput.body,
    recoverySignature: recoveryInput.signature,
    secret,
    releaseSha,
    failureTriggerSha: failureTrigger.trigger_sha256,
    recoveryTriggerSha: recoveryTrigger.trigger_sha256,
  });
  return { ...pair, failureTrigger, recoveryTrigger };
}

async function readDelayedAlertProviderState({
  releaseRoot,
  releaseSha,
  secret,
  recoveryEventId,
  recoveryProviderDeliveryId,
  recoveryProviderOperationId,
  notBefore,
  signal,
}) {
  const trigger = triggerCanonicalProviderReadback({ releaseRoot, releaseSha, recoveryEventId });
  const input = await waitForAlertReceipt({ releaseSha, name: "readback", signal });
  const receipt = verifyAlertProviderReadback({
    body: input.body,
    signature: input.signature,
    secret,
    releaseSha,
    readbackTriggerSha: trigger.trigger_sha256,
    recoveryEventId,
    recoveryProviderDeliveryId,
    recoveryProviderOperationId,
    notBefore,
  });
  return { receipt, trigger };
}

function errorCode(error) {
  return error instanceof ProducerError ? error.code : "unexpected_failure";
}

function fixtureFromJournal(journal) {
  return {
    ids: { ...journal.fixture_plan.ids },
    marker: journal.fixture_plan.marker,
    kpiPeriod: journal.fixture_plan.kpi_period,
    actorIds: journal.actors,
    paymentEffect: journal.payment_effect,
  };
}

function archiveAttemptDirectory(source, destination, label) {
  if (!lstatExists(source)) return;
  const metadata = lstatSync(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || metadata.gid !== 0 || (metadata.mode & 0o777) !== 0o700) {
    refuse(`${label}_untrusted`);
  }
  if (lstatExists(destination)) refuse(`${label}_archive_exists`);
  renameSync(source, destination);
  fsyncDirectory(path.dirname(source));
  fsyncDirectory(path.dirname(destination));
}

export async function recoverCanonicalPostdeployAcceptance(releaseSha) {
  if (process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() !== 0) refuse("producer_requires_posix_root");
  if (!RELEASE_SHA.test(releaseSha)) refuse("release_sha_invalid");
  const { releaseRoot } = releaseEvidence(releaseSha);
  const journal = readJournal(releaseSha);
  if (!journal || !["uat_running", "uat_failed"].includes(journal.state)) refuse("uat_recovery_not_required");
  const sealedDirectory = path.join(releaseRoot, ".audit/postdeploy-acceptance-v1");
  if (lstatExists(sealedDirectory)) refuse("uat_recovery_after_attestation_forbidden");
  const databaseUrl = readProtectedFile(DATABASE_URL_FILE, "database_url", 64 * 1024).toString("utf8").trim();
  if (!databaseUrl || /[\r\n]/.test(databaseUrl)) refuse("database_url_invalid");
  const credentials = credentialsFromBytes(readProtectedFile(ACCEPTANCE_INPUT_FILE, "credentials"));
  const db = await loadPgClient(databaseUrl);
  let cleanup;
  try {
    await db.query("select pg_advisory_lock(hashtextextended('newme-postdeploy-acceptance-v1', 0))");
    const fixture = fixtureFromJournal(journal);
    if (journal.observed_objects.length === 0) {
      journal.observed_objects = await fixtureObjects(db, fixture);
      persistJournal(journal);
      recordJournalStep(journal, "recovery_inventory_measured", journal.observed_objects);
    }
    const expectedObjects = journal.observed_objects;
    await reverseFixturePayment({ db, fixture, journal, bossAccount: credentials.accounts.boss });
    cleanup = await cleanupFixtures(db, fixture, { expectedObjects, allowAlreadyClean: true });
  } catch (error) {
    recordJournalFailure(journal, journal.failure?.primary_code ?? "recovery_requested", null, errorCode(error));
    throw error;
  } finally {
    await db.query("select pg_advisory_unlock(hashtextextended('newme-postdeploy-acceptance-v1', 0))").catch(() => {});
    await db.end().catch(() => {});
  }
  let alertRecovery;
  try {
    alertRecovery = recoverCanonicalAlertState({ releaseRoot, releaseSha });
    recordJournalStep(journal, `alert_${alertRecovery}`, []);
  } catch (error) {
    recordJournalFailure(journal, journal.failure?.primary_code ?? "recovery_requested", cleanup, errorCode(error));
    throw error;
  }
  const safeAttempt = journal.attempt_id.replace(/[^A-Za-z0-9._-]/g, "_");
  const journalDirectory = journalPaths(releaseSha).directory;
  archiveAttemptDirectory(
    path.join(OUTPUT_ROOT, releaseSha),
    path.join(journalDirectory, `intake-${safeAttempt}.aborted`),
    "uat_intake",
  );
  archiveAttemptDirectory(
    path.join(ALERT_INBOX_ROOT, releaseSha),
    path.join(journalDirectory, `alert-${safeAttempt}.archive`),
    "uat_alert_inbox",
  );
  archiveAttemptDirectory(
    path.join(ALERT_STATE_ROOT, releaseSha),
    path.join(journalDirectory, `alert-state-${safeAttempt}.archive`),
    "uat_alert_state",
  );
  journal.state = "recovered";
  journal.cleanup = cleanup;
  journal.failure = null;
  recordJournalStep(journal, "recovery_zero_residual", cleanup.residualObjects);
  return { releaseSha, state: journal.state };
}

export function abortRecoveredPostdeployAcceptance(releaseSha) {
  if (process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() !== 0) refuse("producer_requires_posix_root");
  if (!RELEASE_SHA.test(releaseSha)) refuse("release_sha_invalid");
  const journal = readJournal(releaseSha);
  if (!journal || journal.state !== "recovered" || journal.cleanup?.residualObjects?.length !== 0) {
    refuse("uat_abort_requires_recovered_zero_residual");
  }
  journal.state = "aborted";
  recordJournalStep(journal, "operator_abort_recorded", []);
  return { releaseSha, state: journal.state };
}

export function assertReadyPostdeployAcceptance(releaseSha) {
  if (!RELEASE_SHA.test(releaseSha)) refuse("release_sha_invalid");
  const journal = readJournal(releaseSha);
  if (!journal || journal.state !== "ready" || !/^[0-9a-f]{64}$/.test(journal.bundle_sha256 ?? "")) {
    refuse("uat_ready_journal_required");
  }
  const bundlePath = path.join(OUTPUT_ROOT, releaseSha, "bundle.json");
  const bundleBytes = readProtectedFile(bundlePath, "ready_bundle", 8 * 1024 * 1024);
  if (sha256(bundleBytes) !== journal.bundle_sha256) refuse("uat_ready_bundle_digest_mismatch");
  return { releaseSha, state: journal.state, bundlePath, bundleSha256: journal.bundle_sha256 };
}

export function assertPostdeployOperationsClear() {
  if (!lstatExists(JOURNAL_ROOT)) return { state: "clear" };
  ensureProtectedDirectory(JOURNAL_ROOT, "journal_root");
  const blocked = [];
  for (const entry of readdirSync(JOURNAL_ROOT).sort()) {
    if (!RELEASE_SHA.test(entry)) refuse("journal_root_entry_invalid");
    const journal = readJournal(entry);
    if (journal && ["uat_running", "uat_failed"].includes(journal.state)) blocked.push({ release_sha: entry, state: journal.state });
  }
  if (blocked.length > 0) refuse("uat_recovery_required");
  return { state: "clear" };
}

export async function runCanonicalPostdeployAcceptance(releaseSha, { signal = null } = {}) {
  if (process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() !== 0) refuse("producer_requires_posix_root");
  if (!RELEASE_SHA.test(releaseSha)) refuse("release_sha_invalid");
  const { releaseRoot, release, serviceRuntime } = releaseEvidence(releaseSha);
  const credentials = credentialsFromBytes(readProtectedFile(ACCEPTANCE_INPUT_FILE, "credentials"));
  const databaseUrl = readProtectedFile(DATABASE_URL_FILE, "database_url", 64 * 1024).toString("utf8").trim();
  if (!databaseUrl || /[\r\n]/.test(databaseUrl)) refuse("database_url_invalid");
  const receiptPrivateKeyBytes = readProtectedFile(RECEIPT_PRIVATE_KEY_FILE, "receipt_private_key", 64 * 1024);
  const receiptPublicKeyBytes = readProtectedFile(RECEIPT_PUBLIC_KEY_FILE, "receipt_public_key", 64 * 1024);
  const policyBytes = readFileSync(path.join(releaseRoot, POLICY_PATH));
  const schemaBytes = readFileSync(path.join(releaseRoot, SCHEMA_PATH));
  assertNoServiceRestartSinceDeploy(serviceRuntime, currentSystemdRuntime());
  const db = await loadPgClient(databaseUrl);
  let fixture = null;
  let cleanup = null;
  let journal = null;
  let actorIds = null;
  const sessions = {};
  let flowResults;
  let browserResult = null;
  try {
    await db.query("select pg_advisory_lock(hashtextextended('newme-postdeploy-acceptance-v1', 0))");
    fixture = await planFixtures(db);
    journal = createJournal(releaseSha, fixture);
    for (const role of REQUIRED_ROLES) {
      sessions[role] = new ApiSession({ role, account: credentials.accounts[role], signal });
      await sessions[role].open();
    }
    recordJournalStep(journal, "role_sessions_opened", REQUIRED_ROLES.map((role) => ({ role, actor_id: sessions[role].actorId })));
    actorIds = Object.fromEntries(REQUIRED_ROLES.map((role) => [role, sessions[role].actorId]));
    const roleRows = await db.query("select id, role, is_active from public.profiles where id = any($1::uuid[])", [Object.values(actorIds)]);
    if (
      roleRows.rows.length !== 4
      || REQUIRED_ROLES.some((role) => !roleRows.rows.some((row) => row.id === actorIds[role] && row.role === role && row.is_active === true))
    ) refuse("uat_profile_role_readback_failed");
    journal.actors = actorIds;
    fixture.actorIds = actorIds;
    persistJournal(journal);
    fixture = await seedFixtures(db, actorIds, fixture);
    recordJournalStep(journal, "fixtures_seeded", await fixtureObjects(db, fixture));
    const paymentEffect = await capturePaymentKpiBaseline(db, fixture, journal);
    recordJournalStep(journal, "payment_kpi_baseline_captured", paymentEffect.baseline_rows);
    flowResults = await runBusinessFlows({ db, sessions, fixture });
    journal.observed_objects = await fixtureObjects(db, fixture);
    recordJournalStep(journal, "business_flows_completed", journal.observed_objects);
    await reverseFixturePayment({
      db,
      fixture,
      journal,
      bossAccount: credentials.accounts.boss,
      preferredSession: sessions.boss,
    });
    recordJournalStep(journal, "payment_voided_kpi_restored", [
      journal.payment_effect.void_request,
      journal.payment_effect.restored_sha256,
    ]);
    for (const role of [...REQUIRED_ROLES].reverse()) await sessions[role].close();
    recordJournalStep(journal, "role_sessions_revoked", REQUIRED_ROLES.map((role) => sessions[role].checks.at(-1)));
    journal.observed_objects = await fixtureObjects(db, fixture);
    persistJournal(journal);
    browserResult = await runCanonicalBrowserUat({
      releaseRoot,
      release,
      accounts: credentials.accounts,
      actorIds,
      fixture: {
        marker: fixture.marker,
        lead_id: fixture.ids.browserLead,
        contract_id: fixture.ids.browserContract,
        contract_no: `UAT-C-${fixture.ids.browserContract.slice(0, 8)}`,
      },
      receiptPrivateKeyBytes,
      receiptPublicKeyBytes,
      signal,
    });
    recordJournalStep(journal, "browser_uat_completed", browserResult.artifacts);
    const postBrowserObjects = await fixtureObjects(db, fixture);
    compareFixtureInventory(journal.observed_objects, postBrowserObjects);
    recordJournalStep(journal, "browser_uat_fixture_inventory_verified", postBrowserObjects);
    cleanup = await cleanupFixtures(db, fixture, { expectedObjects: journal.observed_objects });
    recordJournalStep(journal, "fixtures_cleaned_zero_residual", cleanup.residualObjects);
  } catch (error) {
    let cleanupError = null;
    if (fixture) {
      try {
        await reverseFixturePayment({
          db,
          fixture,
          journal,
          bossAccount: credentials.accounts.boss,
          preferredSession: sessions.boss,
        });
        const inventory = await fixtureObjects(db, fixture);
        if (journal && journal.observed_objects.length === 0) {
          journal.observed_objects = inventory;
          persistJournal(journal);
        }
        cleanup = await cleanupFixtures(db, fixture, {
          expectedObjects: journal?.observed_objects ?? inventory,
          allowAlreadyClean: true,
        });
      } catch (fixtureCleanupError) {
        cleanupError = fixtureCleanupError;
        const residualObjects = await fixtureObjects(db, fixture).catch(() => journal?.observed_objects ?? []);
        cleanup = {
          createdObjects: journal?.observed_objects ?? residualObjects,
          cleanedObjects: [],
          residualObjects,
          alreadyMissing: [],
          verifiedAt: utcSecond(),
          paymentReversal: journal?.payment_effect ?? null,
        };
      }
    }
    for (const role of [...REQUIRED_ROLES].reverse()) {
      if (!sessions[role] || sessions[role].checks.some((check) => check.id === "post_logout_denied")) continue;
      try {
        await sessions[role].close();
      } catch (sessionError) {
        cleanupError ??= sessionError;
      }
    }
    if (journal) recordJournalFailure(journal, errorCode(error), cleanup, cleanupError ? errorCode(cleanupError) : null);
    if (cleanupError) refuse("uat_cleanup_incomplete");
    throw error;
  } finally {
    await db.query("select pg_advisory_unlock(hashtextextended('newme-postdeploy-acceptance-v1', 0))").catch(() => {});
    await db.end().catch(() => {});
  }
  try {
    if (!browserResult) refuse("browser_uat_result_missing");
    const performanceResult = await measurePerformance(releaseSha, fetch, 20, signal);
    if (performanceResult.p75 > 2000 || performanceResult.p95 > 5000) refuse("performance_threshold_exceeded");
    recordJournalStep(journal, "performance_measured", performanceResult.samples);
    const alertPair = await runCanonicalAlertDrill({
      releaseRoot,
      releaseSha,
      secret: credentials.alertSecret,
      journal,
      signal,
    });
    if (Date.parse(alertPair.failure.occurred_at) < Date.parse(release.deployed_at)) refuse("alert_drill_predates_deploy");
    recordJournalStep(journal, "alert_provider_pair_verified", [alertPair.failure.body_sha256, alertPair.recovery.body_sha256]);
    const delayedResult = await delayedReadback({
      releaseRoot,
      releaseSha,
      deployedAt: release.deployed_at,
      alertSecret: credentials.alertSecret,
      recoveryEventId: alertPair.recovery.event_id,
      recoveryProviderDeliveryId: alertPair.recovery.provider_delivery_id,
      recoveryProviderOperationId: alertPair.recovery.provider_operation_id,
      serviceRuntimeBaseline: serviceRuntime,
      signal,
    });
    recordJournalStep(journal, "delayed_provider_readback_verified", [delayedResult.providerReadback.body_sha256]);
    const generatedAt = utcSecond();
    const assembled = assemblePostdeployBundle({
      release,
      policyBytes,
      schemaBytes,
      receiptPublicKeyBytes,
      receiptPrivateKeyBytes,
      sessions,
      browserResult,
      flowResults,
      cleanup,
      alertPair,
      performanceResult,
      delayedResult,
      generatedAt,
    });
    const bundlePath = publishBundle(releaseSha, assembled.documents);
    journal.state = "ready";
    journal.failure = null;
    journal.cleanup = cleanup;
    journal.bundle_sha256 = sha256(assembled.documents.get("bundle.json"));
    recordJournalStep(journal, "bundle_published", [{ path: "bundle.json", sha256: sha256(assembled.documents.get("bundle.json")) }]);
    return { releaseSha, bundlePath };
  } catch (error) {
    recordJournalFailure(journal, errorCode(error), cleanup, null);
    throw error;
  }
}

function parseArgs(argv) {
  if (argv.length === 2 && argv[0] === "--release-sha" && RELEASE_SHA.test(argv[1])) return { mode: "produce", releaseSha: argv[1] };
  if (argv.length === 1 && argv[0] === "--assert-operations-clear") return { mode: "assert-clear", releaseSha: null };
  if (argv.length === 3 && ["--recover", "--abort", "--assert-ready"].includes(argv[0]) && argv[1] === "--release-sha" && RELEASE_SHA.test(argv[2])) {
    return { mode: argv[0].slice(2), releaseSha: argv[2] };
  }
  refuse("usage_invalid");
}

export async function main(argv = process.argv.slice(2)) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const { mode, releaseSha } = parseArgs(argv);
    const result = mode === "produce"
      ? await runCanonicalPostdeployAcceptance(releaseSha, { signal: controller.signal })
      : mode === "recover"
        ? await recoverCanonicalPostdeployAcceptance(releaseSha)
        : mode === "abort"
          ? abortRecoveredPostdeployAcceptance(releaseSha)
          : mode === "assert-ready"
            ? assertReadyPostdeployAcceptance(releaseSha)
            : assertPostdeployOperationsClear();
    process.stdout.write(`postdeploy producer: ${mode === "produce" ? "ready" : result.state}${result.releaseSha ? ` release=${result.releaseSha}` : ""}${result.bundlePath ? ` bundle=${result.bundlePath}` : ""}\n`);
    return 0;
  } catch (error) {
    const code = errorCode(error);
    console.error(`postdeploy producer: refused code=${code}`);
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
