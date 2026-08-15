#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
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
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECEIPT_ALGORITHM,
  RECEIPT_VERSION,
  receiptPublicKeySha256,
  verifyPostdeployArtifactReceipt,
} from "./postdeploy-receipt.mjs";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BUILD_ID = /^[^\s]{1,128}$/;
const RUN_ID = /^[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,79}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,255}$/;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const ARTIFACT_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const POLICY_PATH = "infra/release/postdeploy-acceptance-policy-v1.json";
const SCHEMA_PATH = "infra/release/postdeploy-evidence-v1.schema.json";
const POLICY_VERSION = "newme-postdeploy-acceptance-policy/v1";
const SCHEMA_VERSION = "newme-postdeploy-evidence/v1";
const ATTESTATION_VERSION = "newme-postdeploy-attestation/v1";
const ARTIFACT_VERSION = "newme-postdeploy-artifact/v1";
const UAT_RUNNER = "newme-postdeploy-uat/v1";
const BROWSER_UAT_RUNNER = "newme-postdeploy-browser-uat/v1";
const BROWSER_UAT_SOURCE_PATH = "scripts/run-postdeploy-browser-uat.mjs";
const BROWSER_TRACE_VERSION = "newme-postdeploy-browser-trace/v1";
const BROWSER_REDACTION_VERSION = "newme-postdeploy-browser-redaction/v2";
const PLAYWRIGHT_IMAGE = "mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948";
const BROWSER_NAME = "chromium";
const BROWSER_VERSION = "148.0.7778.96";
const FIXTURE_RUNNER = "newme-postdeploy-fixture-audit/v1";
const ALERT_RUNNER = "newme-postdeploy-alert-drill/v1";
const PERFORMANCE_RUNNER = "newme-postdeploy-performance/v1";
const DELAYED_RUNNER = "newme-postdeploy-delayed-verification/v1";
const RECEIPT_PUBLIC_KEY_PATH = "/etc/newme/postdeploy-acceptance-receipt.pub";
const REQUIRED_SESSION_CHECKS = ["login", "refresh", "authorization", "logout", "post_logout_denied"];
const REQUIRED_BROWSER_LOCALES = ["en", "zh"];
const REQUIRED_BROWSER_STEPS = [
  "login_page_visible",
  "login_submitted",
  "landing_visible",
  "navigation_visible",
  "collection_card_visible",
  "bulk_action_verified",
  "detail_visible",
  "contract_list_visible",
  "settings_contract_verified",
  "locale_switched",
  "locale_content_verified",
  "locale_restored",
  "logout",
  "post_logout_denied",
];
const REQUIRED_BROWSER_SCREENSHOT_STEPS = [
  "login_page_visible",
  "collection_card_visible",
  "bulk_action_verified",
  "detail_visible",
  "contract_list_visible",
  "settings_contract_verified",
  "locale_content_verified",
];
const BROWSER_UI_COPY = Object.freeze({
  en: Object.freeze({
    leads: "Leads", contracts: "Contracts", settings: "Admin Panel", create: "Create", signIn: "Sign In", logout: "Logout",
    managementLeadsNav: "Leads", salesLeadsNav: "My Leads", managementContractsNav: "Contracts & Payments", salesContractsNav: "My Contracts",
    transferAction: "Transfer →", cancel: "Cancel", quickCreate: "Quick Create Lead",
  }),
  zh: Object.freeze({
    leads: "线索", contracts: "合同管理", settings: "系统管理", create: "新建", signIn: "登录", logout: "退出",
    managementLeadsNav: "线索", salesLeadsNav: "我的线索", managementContractsNav: "合同&回款", salesContractsNav: "我的合同",
    transferAction: "转移 →", cancel: "取消", quickCreate: "快速创建线索",
  }),
});
const REQUIRED_BROWSER_HTTP_CHECKS = ["login", "identity", "logout", "post_logout_denied"];
const REQUIRED_BROWSER_QUALITY_CHECKS = [
  "console_error_count",
  "page_error_count",
  "critical_http_failure_count",
  "overflow_violation_count",
  "overlap_violation_count",
  "raw_i18n_key_count",
];
const REQUIRED_DELAYED_CHECKS = ["service", "logs", "alerts", "restarts"];
const REQUIRED_FLOW_ASSERTIONS = new Map([
  ["lead_to_contract", ["lead_marked_won", "draft_contract_created", "admin_review_pending"]],
  ["contract_status_transition", ["transition_accepted", "persisted_status_matches"]],
  ["quotation_conversion", ["quotation_marked_converted", "contract_linked"]],
  ["quotation_two_step_approval", ["admin_review_recorded", "ceo_review_recorded", "contract_approved"]],
  ["payment_allocation", ["payment_confirmed", "allocation_persisted", "derived_totals_reconciled"]],
  ["kpi_period_replace", ["period_replaced", "no_duplicate_targets", "target_readback_matches"]],
]);
const REQUIRED_FLOW_ROLES = new Map([
  ["lead_to_contract", "sales"],
  ["contract_status_transition", "operator"],
  ["quotation_conversion", "sales"],
  ["quotation_two_step_approval", "boss"],
  ["payment_allocation", "boss"],
  ["kpi_period_replace", "admin"],
]);
const REQUIRED_FLOW_PARTICIPANTS = new Map([
  ["lead_to_contract", ["sales"]],
  ["contract_status_transition", ["operator"]],
  ["quotation_conversion", ["sales"]],
  ["quotation_two_step_approval", ["admin", "boss"]],
  ["payment_allocation", ["boss"]],
  ["kpi_period_replace", ["admin"]],
]);
const REQUIRED_ASSERTION_ROLES = new Map([
  ["lead_marked_won", "sales"],
  ["draft_contract_created", "sales"],
  ["admin_review_pending", "sales"],
  ["transition_accepted", "operator"],
  ["persisted_status_matches", "operator"],
  ["quotation_marked_converted", "sales"],
  ["contract_linked", "sales"],
  ["admin_review_recorded", "admin"],
  ["ceo_review_recorded", "boss"],
  ["contract_approved", "boss"],
  ["payment_confirmed", "boss"],
  ["allocation_persisted", "boss"],
  ["derived_totals_reconciled", "boss"],
  ["period_replaced", "admin"],
  ["no_duplicate_targets", "admin"],
  ["target_readback_matches", "admin"],
]);
const ALLOWED_MEDIA_TYPES = new Set(["application/json"]);
const ARTIFACT_KINDS = new Set([
  "role_uat",
  "browser_uat",
  "fixture_cleanup",
  "alert_drill",
  "performance",
  "delayed_verification",
]);

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  const expected = new Set(required);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${label} contains unknown property ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  }
}

function nonEmptyArray(value, label, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${label} must contain between ${minimum} and ${maximum} item(s)`);
  }
  return value;
}

function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function stringMatching(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} has an invalid format`);
  return value;
}

function timestamp(value, label) {
  stringMatching(value, TIMESTAMP, label);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value.replace(/Z$/, ".000Z")) {
    fail(`${label} is not a real UTC second timestamp`);
  }
  return milliseconds;
}

function uniqueStrings(values, label, pattern = null) {
  if (!Array.isArray(values)) fail(`${label} must be an array`);
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "string" || (pattern && !pattern.test(value))) {
      fail(`${label}[${index}] has an invalid format`);
    }
    if (seen.has(value)) fail(`${label} contains duplicate ${JSON.stringify(value)}`);
    seen.add(value);
  }
  return seen;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  if (!isObject(value)) fail(`${label} root must be an object`);
  return value;
}

function verifySchemaIsClosed(schema) {
  const visit = (value, pointer) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${pointer}/${index}`));
      return;
    }
    if (!isObject(value)) return;
    if (value.type === "object" && value.additionalProperties !== false) {
      fail(`schema object ${pointer} must set additionalProperties=false`);
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${pointer}/${key}`);
  };
  visit(schema, "#");
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    fail("schema must use JSON Schema draft 2020-12");
  }
  if (schema.properties?.schema_version?.const !== SCHEMA_VERSION) {
    fail("schema does not pin the expected schema_version");
  }
}

function verifyPolicy(policy) {
  exactKeys(policy, [
    "policy_version",
    "schema_version",
    "schema_path",
    "receipts",
    "uat",
    "browser_uat",
    "required_roles",
    "required_flows",
    "fixture_cleanup",
    "alert_drill",
    "performance",
    "delayed_verification",
    "artifacts",
  ], "policy");
  if (policy.policy_version !== POLICY_VERSION) fail("policy_version is not supported");
  if (policy.schema_version !== SCHEMA_VERSION) fail("policy schema_version is not supported");
  if (policy.schema_path !== SCHEMA_PATH) fail("policy schema_path is not canonical");
  exactKeys(policy.receipts, ["receipt_version", "algorithm", "public_key_path"], "policy.receipts");
  if (
    policy.receipts.receipt_version !== RECEIPT_VERSION
    || policy.receipts.algorithm !== RECEIPT_ALGORITHM
    || policy.receipts.public_key_path !== RECEIPT_PUBLIC_KEY_PATH
  ) {
    fail("policy receipt verification contract is not canonical");
  }
  exactKeys(policy.uat, ["artifact_version", "runner", "required_session_checks"], "policy.uat");
  if (policy.uat.artifact_version !== ARTIFACT_VERSION || policy.uat.runner !== UAT_RUNNER) {
    fail("policy UAT artifact producer contract is not canonical");
  }
  const sessionChecks = uniqueStrings(policy.uat.required_session_checks, "policy.uat.required_session_checks", IDENTIFIER);
  if (sessionChecks.size !== REQUIRED_SESSION_CHECKS.length || REQUIRED_SESSION_CHECKS.some((id) => !sessionChecks.has(id))) {
    fail("policy does not require the complete authenticated session check set");
  }

  exactKeys(policy.browser_uat, [
    "artifact_version",
    "runner",
    "runner_source_path",
    "trace_version",
    "redaction_version",
    "playwright_image",
    "browser_name",
    "browser_version",
    "required_locales",
    "viewport",
    "required_steps",
    "required_screenshot_steps",
    "required_http_checks",
    "required_quality_checks",
    "require_no_conditional_skips",
    "require_storage_state_absent",
  ], "policy.browser_uat");
  if (
    policy.browser_uat.artifact_version !== ARTIFACT_VERSION
    || policy.browser_uat.runner !== BROWSER_UAT_RUNNER
    || policy.browser_uat.runner_source_path !== BROWSER_UAT_SOURCE_PATH
    || policy.browser_uat.trace_version !== BROWSER_TRACE_VERSION
    || policy.browser_uat.redaction_version !== BROWSER_REDACTION_VERSION
    || policy.browser_uat.playwright_image !== PLAYWRIGHT_IMAGE
    || policy.browser_uat.browser_name !== BROWSER_NAME
    || policy.browser_uat.browser_version !== BROWSER_VERSION
    || policy.browser_uat.require_no_conditional_skips !== true
    || policy.browser_uat.require_storage_state_absent !== true
  ) fail("policy browser UAT producer, runtime, redaction, and no-skip contract is not canonical");
  exactKeys(policy.browser_uat.viewport, ["width", "height"], "policy.browser_uat.viewport");
  if (policy.browser_uat.viewport.width !== 1440 || policy.browser_uat.viewport.height !== 900) {
    fail("policy browser UAT viewport is not canonical desktop");
  }
  for (const [values, expected, label] of [
    [policy.browser_uat.required_locales, REQUIRED_BROWSER_LOCALES, "locales"],
    [policy.browser_uat.required_steps, REQUIRED_BROWSER_STEPS, "steps"],
    [policy.browser_uat.required_screenshot_steps, REQUIRED_BROWSER_SCREENSHOT_STEPS, "screenshot steps"],
    [policy.browser_uat.required_http_checks, REQUIRED_BROWSER_HTTP_CHECKS, "HTTP checks"],
    [policy.browser_uat.required_quality_checks, REQUIRED_BROWSER_QUALITY_CHECKS, "quality checks"],
  ]) {
    uniqueStrings(values, `policy.browser_uat.required_${label.replace(/ /g, "_")}`, IDENTIFIER);
    if (JSON.stringify(values) !== JSON.stringify(expected)) fail(`policy browser UAT ${label} are not canonical and ordered`);
  }

  const requiredRoles = nonEmptyArray(policy.required_roles, "policy.required_roles", { minimum: 4, maximum: 4 });
  const roleSet = uniqueStrings(requiredRoles, "policy.required_roles", IDENTIFIER);
  if (["admin", "boss", "operator", "sales"].some((role) => !roleSet.has(role))) {
    fail("policy must require admin, boss, operator, and sales");
  }

  const flowSet = new Set();
  for (const [index, flow] of nonEmptyArray(policy.required_flows, "policy.required_flows", { minimum: 1, maximum: 32 }).entries()) {
    exactKeys(flow, ["id", "role", "participants", "assertions"], `policy.required_flows[${index}]`);
    stringMatching(flow.id, IDENTIFIER, `policy.required_flows[${index}].id`);
    if (!roleSet.has(flow.role)) fail(`policy.required_flows[${index}].role is not required`);
    if (flowSet.has(flow.id)) fail(`policy.required_flows contains duplicate ${JSON.stringify(flow.id)}`);
    const assertions = uniqueStrings(nonEmptyArray(flow.assertions, `policy.required_flows[${index}].assertions`), `policy.required_flows[${index}].assertions`, IDENTIFIER);
    const requiredAssertions = REQUIRED_FLOW_ASSERTIONS.get(flow.id);
    if (
      !requiredAssertions
      || assertions.size !== requiredAssertions.length
      || requiredAssertions.some((id) => !assertions.has(id))
    ) {
      fail(`policy flow ${flow.id} does not require its canonical readback assertions`);
    }
    if (flow.role !== REQUIRED_FLOW_ROLES.get(flow.id)) {
      fail(`policy flow ${flow.id} is not assigned to its canonical coordinating role`);
    }
    const participants = uniqueStrings(flow.participants, `policy.required_flows[${index}].participants`, IDENTIFIER);
    const requiredParticipants = new Set(REQUIRED_FLOW_PARTICIPANTS.get(flow.id) ?? []);
    if (!sameStringSet(participants, requiredParticipants)) {
      fail(`policy flow ${flow.id} does not require its canonical participant roles`);
    }
    flowSet.add(flow.id);
  }
  const requiredFlowIds = [
    "lead_to_contract",
    "contract_status_transition",
    "quotation_conversion",
    "quotation_two_step_approval",
    "payment_allocation",
    "kpi_period_replace",
  ];
  if (requiredFlowIds.some((flow) => !flowSet.has(flow)) || flowSet.size !== requiredFlowIds.length) {
    fail("policy does not require the complete production business-flow set");
  }

  exactKeys(policy.fixture_cleanup, ["runner", "created_equals_cleaned", "maximum_residual_count", "require_canonical_payment_void", "require_exact_kpi_restore"], "policy.fixture_cleanup");
  if (
    policy.fixture_cleanup.runner !== FIXTURE_RUNNER
    || policy.fixture_cleanup.created_equals_cleaned !== true
    || policy.fixture_cleanup.maximum_residual_count !== 0
    || policy.fixture_cleanup.require_canonical_payment_void !== true
    || policy.fixture_cleanup.require_exact_kpi_restore !== true
  ) {
    fail("policy fixture cleanup must require exact cleanup and zero residuals");
  }
  exactKeys(policy.alert_drill, ["runner", "require_canonical_trigger", "require_provider_receipts", "require_notifier_owned_provider_delivery", "require_distinct_event_ids", "final_status"], "policy.alert_drill");
  if (
    policy.alert_drill.runner !== ALERT_RUNNER
    || policy.alert_drill.require_canonical_trigger !== true
    || policy.alert_drill.require_provider_receipts !== true
    || policy.alert_drill.require_notifier_owned_provider_delivery !== true
    || policy.alert_drill.require_distinct_event_ids !== true
    || policy.alert_drill.final_status !== "ok"
  ) {
    fail("policy alert drill must require canonical triggers, provider receipts, distinct events, and final ok");
  }
  exactKeys(policy.performance, ["runner", "minimum_sample_count", "p75_max_ms", "p95_max_ms"], "policy.performance");
  if (policy.performance.runner !== PERFORMANCE_RUNNER) fail("policy performance runner is not canonical");
  integer(policy.performance.minimum_sample_count, "policy.performance.minimum_sample_count", { minimum: 20, maximum: 10000 });
  integer(policy.performance.p75_max_ms, "policy.performance.p75_max_ms", { minimum: 1, maximum: 600000 });
  integer(policy.performance.p95_max_ms, "policy.performance.p95_max_ms", { minimum: 1, maximum: 600000 });
  if (policy.performance.p75_max_ms > policy.performance.p95_max_ms) fail("policy p75 limit exceeds p95 limit");
  exactKeys(policy.delayed_verification, ["runner", "minimum_delay_seconds", "require_fresh_provider_readback", "require_post_delay_unpredictable_challenge", "require_same_recovery_delivery_readback", "required_checks"], "policy.delayed_verification");
  if (
    policy.delayed_verification.runner !== DELAYED_RUNNER
    || policy.delayed_verification.require_fresh_provider_readback !== true
    || policy.delayed_verification.require_post_delay_unpredictable_challenge !== true
    || policy.delayed_verification.require_same_recovery_delivery_readback !== true
  ) {
    fail("policy delayed-verification runner and provider readback contract are not canonical");
  }
  integer(policy.delayed_verification.minimum_delay_seconds, "policy.delayed_verification.minimum_delay_seconds", { minimum: 900, maximum: 604800 });
  const delayedChecks = uniqueStrings(policy.delayed_verification.required_checks, "policy.delayed_verification.required_checks", IDENTIFIER);
  if (delayedChecks.size !== REQUIRED_DELAYED_CHECKS.length || REQUIRED_DELAYED_CHECKS.some((id) => !delayedChecks.has(id))) {
    fail("policy does not require the complete delayed verification check set");
  }
  exactKeys(policy.artifacts, ["minimum_count", "maximum_count", "maximum_bytes_each"], "policy.artifacts");
  integer(policy.artifacts.minimum_count, "policy.artifacts.minimum_count", { minimum: 1, maximum: 64 });
  integer(policy.artifacts.maximum_count, "policy.artifacts.maximum_count", { minimum: policy.artifacts.minimum_count, maximum: 64 });
  integer(policy.artifacts.maximum_bytes_each, "policy.artifacts.maximum_bytes_each", { minimum: 1, maximum: 64 * 1024 * 1024 });
  if (policy.artifacts.minimum_count !== 16 || policy.artifacts.maximum_count !== 64 || policy.artifacts.maximum_bytes_each !== 16 * 1024 * 1024) {
    fail("policy artifact inventory limits are not canonical for eight browser sessions");
  }
}

function requireRootOwnedAncestorChain(filePath, label) {
  if (process.platform === "win32") fail(`${label} root-owned verification requires a POSIX host`);
  let cursor = path.dirname(path.resolve(filePath));
  while (true) {
    const metadata = lstatSync(cursor);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.uid !== 0
      || metadata.gid !== 0
      || (metadata.mode & 0o022) !== 0
    ) {
      fail(`${label} traverses an ancestor that is not a root-owned, non-writable directory`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function requireSafeFile(filePath, label, { requireRootOwned = false, maximumBytes = 1024 * 1024 } = {}) {
  const resolved = path.resolve(filePath);
  if (requireRootOwned) requireRootOwnedAncestorChain(resolved, label);
  let descriptor;
  try {
    descriptor = openSync(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    fail(`${label} could not be opened without following a symlink (${error.code ?? "open_failed"})`);
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail(`${label} must be a regular non-symlink file`);
    if (before.size <= 0 || before.size > maximumBytes) fail(`${label} size is outside the accepted range`);
    const permissions = before.mode & 0o777;
    if (requireRootOwned && (
      before.uid !== 0
      || before.gid !== 0
      || ![0o400, 0o600].includes(permissions)
    )) {
      fail(`${label} must be root-owned with mode 0400 or 0600`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || bytes.length !== before.size
    ) {
      fail(`${label} changed while it was being read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function requireArtifactPath(artifactRoot, relativePath, label, { requireRootOwned = false } = {}) {
  stringMatching(relativePath, ARTIFACT_PATH, `${label}.path`);
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${label}.path is not a normalized relative path`);
  }
  const root = path.resolve(artifactRoot);
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail("artifact root must be a non-symlink directory");
  if (requireRootOwned && (rootMetadata.uid !== 0 || rootMetadata.gid !== 0 || (rootMetadata.mode & 0o022) !== 0)) {
    fail("artifact root must be root-owned and not writable by group or other users");
  }
  let cursor = root;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) fail(`${label}.path traverses a symlink`);
    if (requireRootOwned && index < segments.length - 1 && (
      !metadata.isDirectory()
      || metadata.uid !== 0
      || metadata.gid !== 0
      || (metadata.mode & 0o022) !== 0
    )) {
      fail(`${label}.path traverses an untrusted directory`);
    }
  }
  const realRoot = realpathSync(root);
  const realFile = realpathSync(cursor);
  const relative = path.relative(realRoot, realFile);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label}.path escapes or names the artifact root`);
  }
  return realFile;
}

function nearestRank(samples, percentile) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

function assertNotFuture(milliseconds, nowMs, label) {
  if (milliseconds > nowMs) fail(`${label} is in the future`);
}

function sameStringSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function verifyPassingChecks(checks, expectedIds, label, nowMs) {
  const values = nonEmptyArray(checks, label, { minimum: expectedIds.length, maximum: expectedIds.length });
  const byId = new Map();
  for (const [index, check] of values.entries()) {
    const checkLabel = `${label}[${index}]`;
    exactKeys(check, ["id", "status", "completed_at"], checkLabel);
    stringMatching(check.id, IDENTIFIER, `${checkLabel}.id`);
    if (check.status !== "pass") fail(`${checkLabel}.status must be pass`);
    if (byId.has(check.id)) fail(`${label} contains duplicate ${JSON.stringify(check.id)}`);
    const completedAt = timestamp(check.completed_at, `${checkLabel}.completed_at`);
    assertNotFuture(completedAt, nowMs, `${checkLabel}.completed_at`);
    byId.set(check.id, { ...check, completedAt });
  }
  const expected = new Set(expectedIds);
  if (byId.size !== expected.size || [...expected].some((id) => !byId.has(id))) {
    fail(`${label} does not exactly match the canonical required checks`);
  }
  return byId;
}

function verifySessionChecks(checks, expectedIds, label, nowMs) {
  const values = nonEmptyArray(checks, label, { minimum: expectedIds.length, maximum: expectedIds.length });
  const byId = new Map();
  for (const [index, check] of values.entries()) {
    const checkLabel = `${label}[${index}]`;
    exactKeys(check, ["id", "status", "completed_at", "http_status", "response_sha256"], checkLabel);
    stringMatching(check.id, IDENTIFIER, `${checkLabel}.id`);
    if (check.status !== "pass") fail(`${checkLabel}.status must be pass`);
    const expectedStatus = check.id === "post_logout_denied" ? new Set([401, 403]) : new Set([200]);
    if (!expectedStatus.has(integer(check.http_status, `${checkLabel}.http_status`, { minimum: 100, maximum: 599 }))) {
      fail(`${checkLabel}.http_status does not prove the canonical session transition`);
    }
    stringMatching(check.response_sha256, SHA256, `${checkLabel}.response_sha256`);
    if (byId.has(check.id)) fail(`${label} contains duplicate ${JSON.stringify(check.id)}`);
    const completedAt = timestamp(check.completed_at, `${checkLabel}.completed_at`);
    assertNotFuture(completedAt, nowMs, `${checkLabel}.completed_at`);
    byId.set(check.id, { ...check, completedAt });
  }
  const expected = new Set(expectedIds);
  if (!sameStringSet(new Set(byId.keys()), expected)) fail(`${label} does not exactly match the canonical required checks`);
  return byId;
}

function verifyHttpRequests(requests, participantsByRole, startedAt, completedAt, label, nowMs) {
  const values = nonEmptyArray(requests, label, { minimum: 1, maximum: 32 });
  const byId = new Map();
  for (const [index, request] of values.entries()) {
    const requestLabel = `${label}[${index}]`;
    exactKeys(request, ["id", "actor_role", "actor_id", "method", "path", "http_status", "completed_at", "response_sha256"], requestLabel);
    stringMatching(request.id, EVENT_ID, `${requestLabel}.id`);
    if (byId.has(request.id)) fail(`${label} contains duplicate ${JSON.stringify(request.id)}`);
    if (participantsByRole.get(request.actor_role) !== request.actor_id) {
      fail(`${requestLabel} actor is not a canonical participant in this flow`);
    }
    if (!["GET", "POST", "PATCH", "DELETE"].includes(request.method)) fail(`${requestLabel}.method is not allowed`);
    if (typeof request.path !== "string" || !/^\/api\/[A-Za-z0-9?&=._/-]{1,235}$/.test(request.path)) {
      fail(`${requestLabel}.path is not a redacted API route`);
    }
    integer(request.http_status, `${requestLabel}.http_status`, { minimum: 200, maximum: 299 });
    stringMatching(request.response_sha256, SHA256, `${requestLabel}.response_sha256`);
    const requestCompleted = timestamp(request.completed_at, `${requestLabel}.completed_at`);
    if (requestCompleted < startedAt || requestCompleted > completedAt) {
      fail(`${requestLabel}.completed_at falls outside the flow interval`);
    }
    assertNotFuture(requestCompleted, nowMs, `${requestLabel}.completed_at`);
    byId.set(request.id, request);
  }
  return byId;
}

function verifyFlowAssertions(assertions, expectedIds, requestsById, fixtureIds, participantsByRole, startedAt, completedAt, label, nowMs) {
  const values = nonEmptyArray(assertions, label, { minimum: expectedIds.length, maximum: expectedIds.length });
  const byId = new Map();
  for (const [index, assertion] of values.entries()) {
    const assertionLabel = `${label}[${index}]`;
    exactKeys(assertion, ["id", "status", "completed_at", "request_id", "fixture_id", "http_status", "actor_role", "actor_id", "readback_sha256"], assertionLabel);
    stringMatching(assertion.id, IDENTIFIER, `${assertionLabel}.id`);
    stringMatching(assertion.request_id, EVENT_ID, `${assertionLabel}.request_id`);
    stringMatching(assertion.fixture_id, UUID, `${assertionLabel}.fixture_id`);
    if (assertion.status !== "pass") fail(`${assertionLabel}.status must be pass`);
    const request = requestsById.get(assertion.request_id);
    if (!request) fail(`${assertionLabel}.request_id is not in the flow request transcript`);
    if (!fixtureIds.has(assertion.fixture_id)) fail(`${assertionLabel}.fixture_id is not in the flow fixture set`);
    integer(assertion.http_status, `${assertionLabel}.http_status`, { minimum: 200, maximum: 299 });
    stringMatching(assertion.readback_sha256, SHA256, `${assertionLabel}.readback_sha256`);
    const requiredRole = REQUIRED_ASSERTION_ROLES.get(assertion.id);
    if (
      assertion.actor_role !== requiredRole
      || participantsByRole.get(assertion.actor_role) !== assertion.actor_id
      || request.actor_role !== assertion.actor_role
      || request.actor_id !== assertion.actor_id
      || request.http_status !== assertion.http_status
    ) {
      fail(`${assertionLabel} is not bound to the canonical role and HTTP request`);
    }
    const assertionCompleted = timestamp(assertion.completed_at, `${assertionLabel}.completed_at`);
    if (assertionCompleted < startedAt || assertionCompleted > completedAt) {
      fail(`${assertionLabel}.completed_at falls outside the flow interval`);
    }
    assertNotFuture(assertionCompleted, nowMs, `${assertionLabel}.completed_at`);
    if (byId.has(assertion.id)) fail(`${label} contains duplicate ${JSON.stringify(assertion.id)}`);
    byId.set(assertion.id, assertion);
  }
  const expected = new Set(expectedIds);
  if (byId.size !== expected.size || [...expected].some((id) => !byId.has(id))) {
    fail(`${label} does not exactly match the canonical flow readback assertions`);
  }
  return byId;
}

function canonicalBrowserRunnerSha256() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return sha256(readFileSync(path.join(repositoryRoot, ...BROWSER_UAT_SOURCE_PATH.split("/"))));
}

function verifyBrowserQuality(quality, label) {
  exactKeys(quality, REQUIRED_BROWSER_QUALITY_CHECKS, label);
  for (const key of REQUIRED_BROWSER_QUALITY_CHECKS) {
    if (quality[key] !== 0) fail(`${label}.${key} must be zero`);
  }
}

function verifyBrowserHttpChecks(checks, startedAt, completedAt, label, nowMs) {
  const values = nonEmptyArray(checks, label, {
    minimum: REQUIRED_BROWSER_HTTP_CHECKS.length,
    maximum: REQUIRED_BROWSER_HTTP_CHECKS.length,
  });
  const expected = new Map([
    ["login", { method: "POST", path: "/api/auth/login", statuses: new Set([200]) }],
    ["identity", { method: "GET", path: "/api/auth/me", statuses: new Set([200]) }],
    ["logout", { method: "POST", path: "/api/auth/logout", statuses: new Set([200]) }],
    ["post_logout_denied", { method: "GET", path: "/api/auth/me", statuses: new Set([401, 403]) }],
  ]);
  const times = [];
  for (const [index, check] of values.entries()) {
    const checkLabel = `${label}[${index}]`;
    exactKeys(check, ["id", "method", "path", "http_status", "response_sha256", "completed_at"], checkLabel);
    if (check.id !== REQUIRED_BROWSER_HTTP_CHECKS[index]) fail(`${label} is not in canonical order`);
    const contract = expected.get(check.id);
    if (check.method !== contract.method || check.path !== contract.path || !contract.statuses.has(check.http_status)) {
      fail(`${checkLabel} does not prove the canonical browser session transition`);
    }
    stringMatching(check.response_sha256, SHA256, `${checkLabel}.response_sha256`);
    const completed = timestamp(check.completed_at, `${checkLabel}.completed_at`);
    if (completed < startedAt || completed > completedAt) fail(`${checkLabel} falls outside the browser session interval`);
    assertNotFuture(completed, nowMs, `${checkLabel}.completed_at`);
    times.push(completed);
  }
  if (times.some((value, index) => index > 0 && value < times[index - 1])) fail(`${label} is not chronologically ordered`);
}

function verifyBrowserSubject(subject, label, { created = null, cleaned = null } = {}) {
  exactKeys(subject, ["lead_id", "contract_id", "marker_sha256"], label);
  stringMatching(subject.lead_id, UUID, `${label}.lead_id`);
  stringMatching(subject.contract_id, UUID, `${label}.contract_id`);
  stringMatching(subject.marker_sha256, SHA256, `${label}.marker_sha256`);
  if (subject.lead_id === subject.contract_id) fail(`${label} must bind distinct lead and contract fixtures`);
  if (
    created
    && cleaned
    && (
      !created.has(subject.lead_id)
      || !created.has(subject.contract_id)
      || !cleaned.has(subject.lead_id)
      || !cleaned.has(subject.contract_id)
    )
  ) fail(`${label} is not bound to fixtures created and cleaned by this acceptance run`);
  return subject;
}

function semanticAssertion(id, value) {
  return { id, value };
}

function expectedBrowserSemantics(stepId, { role, locale, subject }) {
  const copy = BROWSER_UI_COPY[locale];
  const alternateLocale = locale === "en" ? "zh" : "en";
  const alternateCopy = BROWSER_UI_COPY[alternateLocale];
  const management = role !== "sales";
  const bulkAllowed = role === "admin" || role === "boss";
  const contractsNavigation = role === "sales" ? copy.salesContractsNav : copy.managementContractsNav;
  const leadsNavigation = role === "sales" ? copy.salesLeadsNav : copy.managementLeadsNav;
  const byStep = {
    login_page_visible: [semanticAssertion("login_copy", copy.signIn)],
    login_submitted: [],
    landing_visible: [semanticAssertion("authenticated_role", role)],
    navigation_visible: [
      semanticAssertion("leads_navigation_copy", leadsNavigation),
      semanticAssertion("contracts_navigation_copy", contractsNavigation),
    ],
    collection_card_visible: [
      semanticAssertion("leads_heading_copy", copy.leads),
      semanticAssertion("fixture_lead_id", subject.lead_id),
      semanticAssertion("fixture_marker_sha256", subject.marker_sha256),
    ],
    bulk_action_verified: bulkAllowed
      ? [
          semanticAssertion("bulk_access", "allowed"),
          semanticAssertion("bulk_transfer_copy", copy.transferAction),
          semanticAssertion("bulk_cancel_copy", copy.cancel),
        ]
      : [
          semanticAssertion("bulk_access", "denied"),
          semanticAssertion("permitted_create_copy", copy.create),
          semanticAssertion("create_dialog_copy", copy.quickCreate),
        ],
    detail_visible: [
      semanticAssertion("fixture_detail_id", subject.lead_id),
      semanticAssertion("fixture_detail_copy_sha256", subject.marker_sha256),
    ],
    contract_list_visible: [
      semanticAssertion("contracts_heading_copy", copy.contracts),
      semanticAssertion("fixture_contract_id", subject.contract_id),
      semanticAssertion("fixture_contract_number", `UAT-C-${subject.contract_id.slice(0, 8)}`),
    ],
    settings_contract_verified: management
      ? [
          semanticAssertion("settings_access", "allowed"),
          semanticAssertion("settings_heading_copy", copy.settings),
          semanticAssertion("settings_fixture_lead_id", subject.lead_id),
        ]
      : [semanticAssertion("settings_access", "denied")],
    locale_switched: [semanticAssertion("locale_target", alternateLocale)],
    locale_content_verified: [
      semanticAssertion("alternate_leads_heading_copy", alternateCopy.leads),
      semanticAssertion("alternate_create_copy", alternateCopy.create),
      semanticAssertion("alternate_html_locale", alternateLocale),
    ],
    locale_restored: [semanticAssertion("locale_restored", locale)],
    logout: [semanticAssertion("logout_copy", copy.logout)],
    post_logout_denied: [],
  };
  return byStep[stepId];
}

function verifyBrowserSteps({
  steps,
  role,
  locale,
  subject,
  artifactRoot,
  requireRootOwned,
  startedAt,
  completedAt,
  nowMs,
  label,
  screenshotPaths,
}) {
  const values = nonEmptyArray(steps, label, {
    minimum: REQUIRED_BROWSER_STEPS.length,
    maximum: REQUIRED_BROWSER_STEPS.length,
  });
  let previousCompleted = startedAt;
  for (const [index, step] of values.entries()) {
    const stepLabel = `${label}[${index}]`;
    exactKeys(step, ["sequence", "id", "status", "started_at", "completed_at", "path", "semantic_assertions", "evidence_sha256", "screenshot"], stepLabel);
    if (step.sequence !== index + 1 || step.id !== REQUIRED_BROWSER_STEPS[index] || step.status !== "pass") {
      fail(`${stepLabel} is missing or outside the canonical ordered browser journey`);
    }
    if (typeof step.path !== "string" || !/^\/[A-Za-z0-9._/-]{0,239}$/.test(step.path)) fail(`${stepLabel}.path is not redacted`);
    const expectedSemantics = expectedBrowserSemantics(step.id, { role, locale, subject });
    if (JSON.stringify(step.semantic_assertions) !== JSON.stringify(expectedSemantics)) {
      fail(`${stepLabel}.semantic_assertions do not prove the canonical bilingual subject-bound journey`);
    }
    stringMatching(step.evidence_sha256, SHA256, `${stepLabel}.evidence_sha256`);
    const stepStarted = timestamp(step.started_at, `${stepLabel}.started_at`);
    const stepCompleted = timestamp(step.completed_at, `${stepLabel}.completed_at`);
    if (stepStarted < previousCompleted || stepCompleted < stepStarted || stepCompleted > completedAt) {
      fail(`${stepLabel} is outside the ordered browser session interval`);
    }
    assertNotFuture(stepCompleted, nowMs, `${stepLabel}.completed_at`);
    const canonicalStepDigest = sha256(Buffer.from(JSON.stringify({
      completed_at: step.completed_at,
      id: step.id,
      path: step.path,
      semantic_assertions: step.semantic_assertions,
      sequence: step.sequence,
      started_at: step.started_at,
      status: step.status,
    }), "utf8"));
    if (canonicalStepDigest !== step.evidence_sha256) fail(`${stepLabel}.evidence_sha256 is not canonical`);
    const screenshotRequired = REQUIRED_BROWSER_SCREENSHOT_STEPS.includes(step.id);
    if (screenshotRequired !== (step.screenshot !== null)) fail(`${stepLabel} screenshot coverage is not canonical`);
    if (step.screenshot !== null) {
      exactKeys(step.screenshot, ["path", "sha256", "media_type", "redaction_version"], `${stepLabel}.screenshot`);
      if (
        step.screenshot.media_type !== "image/png"
        || step.screenshot.redaction_version !== BROWSER_REDACTION_VERSION
        || !step.screenshot.path.startsWith(`${role}/${locale}/screenshots/`)
        || screenshotPaths.has(step.screenshot.path)
      ) fail(`${stepLabel}.screenshot is not a distinct canonical redacted screenshot`);
      stringMatching(step.screenshot.sha256, SHA256, `${stepLabel}.screenshot.sha256`);
      const screenshotFile = requireArtifactPath(artifactRoot, step.screenshot.path, `${stepLabel}.screenshot`, { requireRootOwned });
      const screenshotBytes = requireSafeFile(screenshotFile, `${stepLabel}.screenshot`, {
        requireRootOwned,
        maximumBytes: 16 * 1024 * 1024,
      });
      const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      if (screenshotBytes.length < 8 || !screenshotBytes.subarray(0, 8).equals(pngSignature)) {
        fail(`${stepLabel}.screenshot is not PNG evidence`);
      }
      if (sha256(screenshotBytes) !== step.screenshot.sha256) fail(`${stepLabel}.screenshot digest does not match its bytes`);
      screenshotPaths.add(step.screenshot.path);
    }
    previousCompleted = stepCompleted;
  }
  if (values.at(-1).completed_at !== new Date(completedAt).toISOString().replace(".000Z", "Z")) {
    fail(`${label} does not end at the browser artifact completion time`);
  }
  return values;
}

function verifyBrowserArtifactContracts({
  bundle,
  policy,
  artifactsById,
  browserSessions,
  created,
  cleaned,
  artifactRoot,
  requireRootOwned,
  deployedAt,
  nowMs,
}) {
  const runnerSourceSha256 = canonicalBrowserRunnerSha256();
  const runIds = new Set();
  const screenshotPaths = new Set();
  const tracePaths = new Set();
  let canonicalSubjectJson = null;
  for (const role of policy.required_roles) {
    for (const locale of policy.browser_uat.required_locales) {
      const key = `${role}:${locale}`;
      const summary = browserSessions.get(key);
      const subject = verifyBrowserSubject(summary.subject, `browser session ${JSON.stringify(key)}.subject`, { created, cleaned });
      const subjectJson = JSON.stringify(subject);
      if (canonicalSubjectJson === null) canonicalSubjectJson = subjectJson;
      if (subjectJson !== canonicalSubjectJson) fail("all browser sessions must bind the same acceptance fixture subject");
      const artifact = artifactsById.get(summary.artifact_id);
      const label = `browser artifact ${JSON.stringify(summary.artifact_id)}`;
      if (artifact.kind !== "browser_uat" || artifact.document.kind !== "browser_uat") fail(`${label} must be browser_uat evidence`);
      const payload = artifact.document.payload;
      exactKeys(payload, [
        "runner",
        "runner_run_id",
        "runner_source_path",
        "runner_source_sha256",
        "playwright_image",
        "browser_name",
        "browser_version",
        "role",
        "actor_id",
        "locale",
        "subject",
        "viewport",
        "status",
        "started_at",
        "completed_at",
        "ordered_steps",
        "http_checks",
        "quality",
        "redaction",
        "trace",
      ], `${label}.payload`);
      if (
        payload.runner !== BROWSER_UAT_RUNNER
        || payload.runner !== policy.browser_uat.runner
        || payload.runner_source_path !== BROWSER_UAT_SOURCE_PATH
        || payload.runner_source_sha256 !== runnerSourceSha256
        || payload.playwright_image !== PLAYWRIGHT_IMAGE
        || payload.browser_name !== BROWSER_NAME
        || payload.browser_version !== BROWSER_VERSION
      ) fail(`${label} is not bound to the immutable canonical browser runner and runtime`);
      stringMatching(payload.runner_run_id, EVENT_ID, `${label}.payload.runner_run_id`);
      if (runIds.has(payload.runner_run_id)) fail("each browser locale session must have a distinct runner run ID");
      runIds.add(payload.runner_run_id);
      if (
        payload.role !== summary.role
        || payload.actor_id !== summary.actor_id
        || payload.locale !== summary.locale
        || JSON.stringify(payload.subject) !== subjectJson
        || payload.status !== summary.status
      ) fail(`${label} identity does not match its browser session claim`);
      verifyBrowserSubject(payload.subject, `${label}.payload.subject`, { created, cleaned });
      exactKeys(payload.viewport, ["width", "height"], `${label}.payload.viewport`);
      if (payload.viewport.width !== 1440 || payload.viewport.height !== 900) fail(`${label} is not desktop viewport evidence`);
      const startedAt = timestamp(payload.started_at, `${label}.payload.started_at`);
      const completedAt = timestamp(payload.completed_at, `${label}.payload.completed_at`);
      if (startedAt < deployedAt || completedAt < startedAt) fail(`${label} predates the deployed release`);
      if (payload.completed_at !== summary.completed_at || artifact.document.observed_at !== payload.completed_at) {
        fail(`${label} completion is not bound to its summary and receipt envelope`);
      }
      assertNotFuture(completedAt, nowMs, `${label}.payload.completed_at`);
      const steps = verifyBrowserSteps({
        steps: payload.ordered_steps,
        role,
        locale,
        subject,
        artifactRoot,
        requireRootOwned,
        startedAt,
        completedAt,
        nowMs,
        label: `${label}.payload.ordered_steps`,
        screenshotPaths,
      });
      verifyBrowserHttpChecks(payload.http_checks, startedAt, completedAt, `${label}.payload.http_checks`, nowMs);
      verifyBrowserQuality(payload.quality, `${label}.payload.quality`);
      exactKeys(payload.redaction, [
        "redaction_version",
        "non_subject_dynamic_text_hidden",
        "evidence_copy_visible",
        "input_values_hidden",
        "screenshot_images_hidden",
        "trace_closed_fields_only",
        "storage_state_written",
      ], `${label}.payload.redaction`);
      if (
        payload.redaction.redaction_version !== BROWSER_REDACTION_VERSION
        || payload.redaction.non_subject_dynamic_text_hidden !== true
        || payload.redaction.evidence_copy_visible !== true
        || payload.redaction.input_values_hidden !== true
        || payload.redaction.screenshot_images_hidden !== true
        || payload.redaction.trace_closed_fields_only !== true
        || payload.redaction.storage_state_written !== false
      ) fail(`${label} redaction and non-persistence contract is not proven`);
      exactKeys(payload.trace, ["trace_version", "path", "sha256", "media_type"], `${label}.payload.trace`);
      if (
        payload.trace.trace_version !== BROWSER_TRACE_VERSION
        || payload.trace.media_type !== "application/json"
        || !payload.trace.path.startsWith(`${role}/${locale}/`)
        || tracePaths.has(payload.trace.path)
      ) fail(`${label} trace metadata is not canonical and distinct`);
      stringMatching(payload.trace.sha256, SHA256, `${label}.payload.trace.sha256`);
      const traceFile = requireArtifactPath(artifactRoot, payload.trace.path, `${label}.payload.trace`, { requireRootOwned });
      const traceBytes = requireSafeFile(traceFile, `${label}.payload.trace`, {
        requireRootOwned,
        maximumBytes: 16 * 1024 * 1024,
      });
      if (sha256(traceBytes) !== payload.trace.sha256) fail(`${label} trace digest does not match its bytes`);
      const trace = parseJson(traceBytes, `${label} redacted trace`);
      exactKeys(trace, [
        "trace_version",
        "release",
        "runner",
        "runner_source_sha256",
        "role",
        "actor_id",
        "locale",
        "subject",
        "viewport",
        "ordered_steps",
        "http_checks",
        "quality",
      ], `${label} redacted trace`);
      if (
        trace.trace_version !== BROWSER_TRACE_VERSION
        || trace.runner !== BROWSER_UAT_RUNNER
        || trace.runner_source_sha256 !== runnerSourceSha256
        || trace.role !== role
        || trace.actor_id !== summary.actor_id
        || trace.locale !== locale
        || JSON.stringify(trace.subject) !== subjectJson
        || JSON.stringify(trace.viewport) !== JSON.stringify(payload.viewport)
        || JSON.stringify(trace.ordered_steps) !== JSON.stringify(steps)
        || JSON.stringify(trace.http_checks) !== JSON.stringify(payload.http_checks)
        || JSON.stringify(trace.quality) !== JSON.stringify(payload.quality)
      ) fail(`${label} redacted trace does not exactly match its signed browser evidence`);
      verifyBrowserSubject(trace.subject, `${label} redacted trace.subject`, { created, cleaned });
      exactKeys(trace.release, ["git_sha", "build_id", "deploy_run_id", "deployed_at"], `${label} redacted trace.release`);
      if (
        trace.release.git_sha !== bundle.release.git_sha
        || trace.release.build_id !== bundle.release.build_id
        || trace.release.deploy_run_id !== bundle.release.deploy_run_id
        || trace.release.deployed_at !== bundle.release.deployed_at
      ) fail(`${label} redacted trace is not bound to the exact deployed release`);
      tracePaths.add(payload.trace.path);
    }
  }
}

function verifyArtifactContracts({
  bundle,
  policy,
  artifactsById,
  rolesByName,
  flowsById,
  created,
  cleaned,
  browserSessions,
  artifactRoot,
  requireRootOwned,
  deployedAt,
  nowMs,
}) {
  verifyBrowserArtifactContracts({
    bundle,
    policy,
    artifactsById,
    browserSessions,
    created,
    cleaned,
    artifactRoot,
    requireRootOwned,
    deployedAt,
    nowMs,
  });
  const roleArtifactIds = new Set();
  const roleRunnerRunIds = new Set();
  for (const roleName of policy.required_roles) {
    const role = rolesByName.get(roleName);
    const artifact = artifactsById.get(role.artifact_id);
    const label = `artifact ${JSON.stringify(role.artifact_id)}`;
    if (artifact.kind !== "role_uat" || artifact.document.kind !== "role_uat") {
      fail(`${label} must be a role_uat artifact`);
    }
    if (roleArtifactIds.has(role.artifact_id)) fail("each required role must have a distinct role_uat artifact");
    roleArtifactIds.add(role.artifact_id);
    const payload = artifact.document.payload;
    exactKeys(payload, [
      "runner",
      "runner_run_id",
      "role",
      "actor_id",
      "status",
      "started_at",
      "completed_at",
      "session_checks",
      "flows",
    ], `${label}.payload`);
    if (payload.runner !== policy.uat.runner || payload.runner !== UAT_RUNNER) fail(`${label} runner is not canonical`);
    stringMatching(payload.runner_run_id, EVENT_ID, `${label}.payload.runner_run_id`);
    if (roleRunnerRunIds.has(payload.runner_run_id)) fail("each required role must have a distinct canonical UAT runner run ID");
    roleRunnerRunIds.add(payload.runner_run_id);
    if (payload.role !== role.role || payload.actor_id !== role.actor_id || payload.status !== role.status) {
      fail(`${label} role result does not match the bundle role claim`);
    }
    const startedAt = timestamp(payload.started_at, `${label}.payload.started_at`);
    const completedAt = timestamp(payload.completed_at, `${label}.payload.completed_at`);
    if (startedAt < deployedAt || completedAt < startedAt) fail(`${label} role UAT is outside the deployed-release interval`);
    if (payload.completed_at !== role.completed_at || artifact.document.observed_at !== payload.completed_at) {
      fail(`${label} completion time does not match its bundle role and artifact envelope`);
    }
    assertNotFuture(completedAt, nowMs, `${label}.payload.completed_at`);
    const sessionChecks = verifySessionChecks(
      payload.session_checks,
      policy.uat.required_session_checks,
      `${label}.payload.session_checks`,
      nowMs,
    );
    const orderedSessionChecks = policy.uat.required_session_checks.map((id) => sessionChecks.get(id).completedAt);
    if (
      orderedSessionChecks[0] < startedAt
      || orderedSessionChecks.some((value, index) => index > 0 && value < orderedSessionChecks[index - 1])
      || orderedSessionChecks.at(-1) !== completedAt
    ) {
      fail(`${label} authenticated session checks are not ordered through post-logout denial within the UAT interval`);
    }

    const expectedFlowIds = role.flowIds;
    const artifactFlows = nonEmptyArray(payload.flows, `${label}.payload.flows`, {
      minimum: expectedFlowIds.size,
      maximum: expectedFlowIds.size,
    });
    const artifactFlowsById = new Map();
    for (const [index, flowResult] of artifactFlows.entries()) {
      const flowLabel = `${label}.payload.flows[${index}]`;
      exactKeys(flowResult, [
        "id",
        "status",
        "started_at",
        "completed_at",
        "participants",
        "requests",
        "fixture_ids",
        "assertions",
      ], flowLabel);
      stringMatching(flowResult.id, IDENTIFIER, `${flowLabel}.id`);
      if (artifactFlowsById.has(flowResult.id)) fail(`${label} contains duplicate flow ${JSON.stringify(flowResult.id)}`);
      const bundleFlow = flowsById.get(flowResult.id);
      if (!bundleFlow || bundleFlow.role !== roleName || bundleFlow.artifact_id !== role.artifact_id) {
        fail(`${flowLabel} is not the bundle flow assigned to this role artifact`);
      }
      if (
        flowResult.status !== "pass"
        || flowResult.status !== bundleFlow.status
        || flowResult.started_at !== bundleFlow.started_at
        || flowResult.completed_at !== bundleFlow.completed_at
      ) {
        fail(`${flowLabel} result does not match the bundle flow claim`);
      }
      if (bundleFlow.startedMs < startedAt || bundleFlow.completedMs > completedAt) {
        fail(`${flowLabel} falls outside its authenticated role UAT interval`);
      }
      if (
        bundleFlow.startedMs < sessionChecks.get("authorization").completedAt
        || bundleFlow.completedMs > sessionChecks.get("logout").completedAt
      ) {
        fail(`${flowLabel} was not executed inside the authenticated authorization-to-logout interval`);
      }
      const requiredFlowPolicy = policy.required_flows.find((item) => item.id === flowResult.id);
      const participantsByRole = new Map();
      for (const [participantIndex, participant] of nonEmptyArray(flowResult.participants, `${flowLabel}.participants`, {
        minimum: requiredFlowPolicy.participants.length,
        maximum: requiredFlowPolicy.participants.length,
      }).entries()) {
        const participantLabel = `${flowLabel}.participants[${participantIndex}]`;
        exactKeys(participant, ["role", "actor_id"], participantLabel);
        if (!requiredFlowPolicy.participants.includes(participant.role)) fail(`${participantLabel}.role is not required by policy`);
        if (participantsByRole.has(participant.role)) fail(`${flowLabel}.participants contains a duplicate role`);
        if (rolesByName.get(participant.role)?.actor_id !== participant.actor_id) {
          fail(`${participantLabel}.actor_id does not match the authenticated role actor`);
        }
        participantsByRole.set(participant.role, participant.actor_id);
      }
      if (requiredFlowPolicy.participants.some((participantRole) => !participantsByRole.has(participantRole))) {
        fail(`${flowLabel}.participants does not exactly cover the canonical participant roles`);
      }
      const requestsById = verifyHttpRequests(
        flowResult.requests,
        participantsByRole,
        bundleFlow.startedMs,
        bundleFlow.completedMs,
        `${flowLabel}.requests`,
        nowMs,
      );
      const fixtureIds = uniqueStrings(nonEmptyArray(flowResult.fixture_ids, `${flowLabel}.fixture_ids`), `${flowLabel}.fixture_ids`, UUID);
      if ([...fixtureIds].some((id) => !created.has(id))) fail(`${flowLabel}.fixture_ids contains an ID not created by this acceptance run`);
      const requiredAssertions = requiredFlowPolicy.assertions;
      verifyFlowAssertions(
        flowResult.assertions,
        requiredAssertions,
        requestsById,
        fixtureIds,
        participantsByRole,
        bundleFlow.startedMs,
        bundleFlow.completedMs,
        `${flowLabel}.assertions`,
        nowMs,
      );
      artifactFlowsById.set(flowResult.id, flowResult);
    }
    if (artifactFlowsById.size !== expectedFlowIds.size || [...expectedFlowIds].some((id) => !artifactFlowsById.has(id))) {
      fail(`${label} flows do not exactly match the bundle role flow_ids`);
    }
  }

  const fixtureArtifact = artifactsById.get(bundle.fixtures.artifact_id);
  if (fixtureArtifact.kind !== "fixture_cleanup") fail("fixture evidence must use a fixture_cleanup artifact");
  const fixturePayload = fixtureArtifact.document.payload;
  exactKeys(fixturePayload, [
    "runner",
    "query_run_id",
    "created_ids",
    "cleaned_ids",
    "residual_count",
    "verified_at",
    "payment_id",
    "payment_status",
    "payment_void_request_id",
    "payment_void_receipt_sha256",
    "payment_voided_at",
    "kpi_baseline_sha256",
    "kpi_restored_sha256",
  ], "fixture artifact payload");
  if (fixturePayload.runner !== policy.fixture_cleanup.runner || fixturePayload.runner !== FIXTURE_RUNNER) fail("fixture artifact runner is not canonical");
  stringMatching(fixturePayload.query_run_id, EVENT_ID, "fixture artifact payload.query_run_id");
  const artifactCreated = uniqueStrings(nonEmptyArray(fixturePayload.created_ids, "fixture artifact payload.created_ids"), "fixture artifact payload.created_ids", UUID);
  const artifactCleaned = uniqueStrings(nonEmptyArray(fixturePayload.cleaned_ids, "fixture artifact payload.cleaned_ids"), "fixture artifact payload.cleaned_ids", UUID);
  if (
    !sameStringSet(artifactCreated, created)
    || !sameStringSet(artifactCleaned, cleaned)
    || fixturePayload.residual_count !== bundle.fixtures.residual_count
    || fixturePayload.verified_at !== bundle.fixtures.verified_at
    || fixturePayload.payment_id !== bundle.fixtures.payment_id
    || fixturePayload.payment_status !== bundle.fixtures.payment_status
    || fixturePayload.payment_void_request_id !== bundle.fixtures.payment_void_request_id
    || fixturePayload.payment_void_receipt_sha256 !== bundle.fixtures.payment_void_receipt_sha256
    || fixturePayload.payment_voided_at !== bundle.fixtures.payment_voided_at
    || fixturePayload.kpi_baseline_sha256 !== bundle.fixtures.kpi_baseline_sha256
    || fixturePayload.kpi_restored_sha256 !== bundle.fixtures.kpi_restored_sha256
    || fixtureArtifact.document.observed_at !== bundle.fixtures.verified_at
  ) fail("fixture artifact does not exactly match the bundle cleanup claim");

  const alertArtifact = artifactsById.get(bundle.alert_drill.artifact_id);
  if (alertArtifact.kind !== "alert_drill") fail("alert evidence must use an alert_drill artifact");
  const alertPayload = alertArtifact.document.payload;
  exactKeys(alertPayload, [
    "runner",
    "drill_run_id",
    "failure_event_id",
    "recovery_event_id",
    "failure_provider_delivery_id",
    "recovery_provider_delivery_id",
    "failure_provider_operation_id",
    "recovery_provider_operation_id",
    "failure_trigger_sha256",
    "recovery_trigger_sha256",
    "failure_receipt_sha256",
    "recovery_receipt_sha256",
    "failed_at",
    "recovered_at",
    "final_status",
  ], "alert artifact payload");
  if (alertPayload.runner !== policy.alert_drill.runner || alertPayload.runner !== ALERT_RUNNER) fail("alert artifact runner is not canonical");
  stringMatching(alertPayload.drill_run_id, EVENT_ID, "alert artifact payload.drill_run_id");
  for (const key of [
    "failure_event_id",
    "recovery_event_id",
    "failure_provider_delivery_id",
    "recovery_provider_delivery_id",
    "failure_provider_operation_id",
    "recovery_provider_operation_id",
    "failure_trigger_sha256",
    "recovery_trigger_sha256",
    "failure_receipt_sha256",
    "recovery_receipt_sha256",
    "failed_at",
    "recovered_at",
    "final_status",
  ]) {
    if (alertPayload[key] !== bundle.alert_drill[key]) fail(`alert artifact ${key} does not match the bundle alert claim`);
  }
  if (alertArtifact.document.observed_at !== bundle.alert_drill.recovered_at) fail("alert artifact observed_at must equal recovered_at");

  const performanceArtifact = artifactsById.get(bundle.performance.artifact_id);
  if (performanceArtifact.kind !== "performance") fail("performance evidence must use a performance artifact");
  const performancePayload = performanceArtifact.document.payload;
  exactKeys(performancePayload, ["runner", "measurement_run_id", "samples_ms", "p75_ms", "p95_ms", "measured_at"], "performance artifact payload");
  if (performancePayload.runner !== policy.performance.runner || performancePayload.runner !== PERFORMANCE_RUNNER) fail("performance artifact runner is not canonical");
  stringMatching(performancePayload.measurement_run_id, EVENT_ID, "performance artifact payload.measurement_run_id");
  if (
    JSON.stringify(performancePayload.samples_ms) !== JSON.stringify(bundle.performance.samples_ms)
    || performancePayload.p75_ms !== bundle.performance.p75_ms
    || performancePayload.p95_ms !== bundle.performance.p95_ms
    || performancePayload.measured_at !== bundle.performance.measured_at
    || performanceArtifact.document.observed_at !== bundle.performance.measured_at
  ) fail("performance artifact does not exactly match the bundle measurement claim");

  const delayedArtifact = artifactsById.get(bundle.delayed_verification.artifact_id);
  if (delayedArtifact.kind !== "delayed_verification") fail("delayed evidence must use a delayed_verification artifact");
  const delayedPayload = delayedArtifact.document.payload;
  exactKeys(delayedPayload, [
    "runner",
    "verification_run_id",
    "not_before",
    "completed_at",
    "status",
    "checks",
    "provider_trigger_sha256",
    "provider_event_id",
    "provider_delivery_id",
    "provider_query_id",
    "provider_receipt_sha256",
    "provider_observed_at",
  ], "delayed artifact payload");
  if (delayedPayload.runner !== policy.delayed_verification.runner || delayedPayload.runner !== DELAYED_RUNNER) fail("delayed artifact runner is not canonical");
  stringMatching(delayedPayload.verification_run_id, EVENT_ID, "delayed artifact payload.verification_run_id");
  if (
    delayedPayload.not_before !== bundle.delayed_verification.not_before
    || delayedPayload.completed_at !== bundle.delayed_verification.completed_at
    || delayedPayload.status !== bundle.delayed_verification.status
    || delayedPayload.provider_trigger_sha256 !== bundle.delayed_verification.provider_trigger_sha256
    || delayedPayload.provider_event_id !== bundle.delayed_verification.provider_event_id
    || delayedPayload.provider_delivery_id !== bundle.delayed_verification.provider_delivery_id
    || delayedPayload.provider_query_id !== bundle.delayed_verification.provider_query_id
    || delayedPayload.provider_receipt_sha256 !== bundle.delayed_verification.provider_receipt_sha256
    || delayedPayload.provider_observed_at !== bundle.delayed_verification.provider_observed_at
    || delayedArtifact.document.observed_at !== bundle.delayed_verification.completed_at
  ) fail("delayed artifact does not exactly match the bundle delayed-verification claim");
  const delayedChecks = verifyPassingChecks(
    delayedPayload.checks,
    policy.delayed_verification.required_checks,
    "delayed artifact payload.checks",
    nowMs,
  );
  const delayedNotBefore = timestamp(bundle.delayed_verification.not_before, "bundle.delayed_verification.not_before");
  const delayedCompletedAt = timestamp(bundle.delayed_verification.completed_at, "bundle.delayed_verification.completed_at");
  if ([...delayedChecks.values()].some((check) => check.completedAt < delayedNotBefore || check.completedAt > delayedCompletedAt)) {
    fail("delayed artifact checks must complete between not_before and completed_at");
  }

  const expectedKinds = new Map([
    ["role_uat", 4],
    ["browser_uat", 8],
    ["fixture_cleanup", 1],
    ["alert_drill", 1],
    ["performance", 1],
    ["delayed_verification", 1],
  ]);
  for (const [kind, expectedCount] of expectedKinds) {
    const actualCount = [...artifactsById.values()].filter((artifact) => artifact.kind === kind).length;
    if (actualCount !== expectedCount) fail(`artifact kind ${kind} must occur exactly ${expectedCount} time(s)`);
  }
}

export function verifyPostdeployAcceptance({
  bundleBytes,
  bundlePath = "bundle",
  policyBytes,
  schemaBytes,
  receiptPublicKeyBytes,
  artifactRoot,
  expectedReleaseSha,
  expectedBuildId,
  expectedDeployRunId,
  expectedDeployedAt,
  now = new Date(),
  requireRootOwned = false,
}) {
  const policy = parseJson(policyBytes, "policy");
  const schema = parseJson(schemaBytes, "schema");
  const bundle = parseJson(bundleBytes, "postdeploy evidence bundle");
  verifyPolicy(policy);
  verifySchemaIsClosed(schema);
  if (!receiptPublicKeyBytes) fail("protected receipt public key bytes are required");
  const receiptKeySha256 = receiptPublicKeySha256(receiptPublicKeyBytes);

  exactKeys(bundle, [
    "schema_version",
    "policy",
    "schema",
    "receipt_key_sha256",
    "release",
    "roles",
    "browser_uat",
    "flows",
    "fixtures",
    "alert_drill",
    "performance",
    "delayed_verification",
    "artifacts",
    "generated_at",
  ], "bundle");
  if (bundle.schema_version !== SCHEMA_VERSION) fail("bundle schema_version is not supported");

  exactKeys(bundle.policy, ["path", "sha256"], "bundle.policy");
  exactKeys(bundle.schema, ["path", "sha256"], "bundle.schema");
  if (bundle.policy.path !== POLICY_PATH || bundle.policy.sha256 !== sha256(policyBytes)) {
    fail("bundle policy digest is not bound to the canonical policy bytes");
  }
  if (bundle.schema.path !== SCHEMA_PATH || bundle.schema.sha256 !== sha256(schemaBytes)) {
    fail("bundle schema digest is not bound to the canonical schema bytes");
  }
  if (bundle.receipt_key_sha256 !== receiptKeySha256) {
    fail("bundle receipt key digest is not bound to the protected public key");
  }

  exactKeys(bundle.release, ["git_sha", "build_id", "deploy_run_id", "deploy_run_url", "deployed_at"], "bundle.release");
  stringMatching(bundle.release.git_sha, SHA40, "bundle.release.git_sha");
  stringMatching(bundle.release.build_id, BUILD_ID, "bundle.release.build_id");
  stringMatching(bundle.release.deploy_run_id, RUN_ID, "bundle.release.deploy_run_id");
  const expectedRunUrl = `https://github.com/69755354/newme-platform/actions/runs/${bundle.release.deploy_run_id}`;
  if (bundle.release.deploy_run_url !== expectedRunUrl) fail("bundle.release.deploy_run_url does not name deploy_run_id");
  const deployedAt = timestamp(bundle.release.deployed_at, "bundle.release.deployed_at");
  if (expectedReleaseSha !== undefined && bundle.release.git_sha !== expectedReleaseSha) fail("bundle release SHA does not match deployment evidence");
  if (expectedBuildId !== undefined && bundle.release.build_id !== expectedBuildId) fail("bundle build ID does not match deployment evidence");
  if (expectedDeployRunId !== undefined && bundle.release.deploy_run_id !== String(expectedDeployRunId)) fail("bundle deploy run ID does not match deployment evidence");
  if (expectedDeployedAt !== undefined && bundle.release.deployed_at !== expectedDeployedAt) fail("bundle deployed_at does not match deployment evidence");

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) fail("verification time is invalid");
  assertNotFuture(deployedAt, nowMs, "bundle.release.deployed_at");

  const artifacts = nonEmptyArray(bundle.artifacts, "bundle.artifacts", {
    minimum: policy.artifacts.minimum_count,
    maximum: policy.artifacts.maximum_count,
  });
  const artifactsById = new Map();
  const artifactPaths = new Set();
  const verifiedArtifacts = [];
  for (const [index, artifact] of artifacts.entries()) {
    const label = `bundle.artifacts[${index}]`;
    exactKeys(artifact, ["id", "kind", "path", "sha256", "media_type"], label);
    stringMatching(artifact.id, IDENTIFIER, `${label}.id`);
    if (!ARTIFACT_KINDS.has(artifact.kind)) fail(`${label}.kind is not allowed`);
    stringMatching(artifact.sha256, SHA256, `${label}.sha256`);
    if (!ALLOWED_MEDIA_TYPES.has(artifact.media_type)) fail(`${label}.media_type is not allowed`);
    if (artifactsById.has(artifact.id)) fail(`bundle.artifacts contains duplicate id ${JSON.stringify(artifact.id)}`);
    if (artifactPaths.has(artifact.path)) fail(`bundle.artifacts contains duplicate path ${JSON.stringify(artifact.path)}`);
    const absolutePath = requireArtifactPath(artifactRoot, artifact.path, label, { requireRootOwned });
    const bytes = requireSafeFile(absolutePath, label, {
      requireRootOwned,
      maximumBytes: policy.artifacts.maximum_bytes_each,
    });
    const digest = sha256(bytes);
    if (digest !== artifact.sha256) fail(`${label} digest does not match artifact bytes`);
    const document = parseJson(bytes, `${label} content`);
    exactKeys(document, ["artifact_version", "kind", "release", "observed_at", "payload", "receipt"], `${label} content`);
    if (document.artifact_version !== policy.uat.artifact_version || document.artifact_version !== ARTIFACT_VERSION) {
      fail(`${label} content artifact_version is not canonical`);
    }
    if (document.kind !== artifact.kind) fail(`${label} content kind does not match artifact metadata`);
    exactKeys(document.release, ["git_sha", "build_id", "deploy_run_id"], `${label} content.release`);
    if (
      document.release.git_sha !== bundle.release.git_sha
      || document.release.build_id !== bundle.release.build_id
      || document.release.deploy_run_id !== bundle.release.deploy_run_id
    ) {
      fail(`${label} content release identity does not match the deployed release`);
    }
    const observedAt = timestamp(document.observed_at, `${label} content.observed_at`);
    if (observedAt < deployedAt) fail(`${label} content predates deployment`);
    assertNotFuture(observedAt, nowMs, `${label} content.observed_at`);
    if (!isObject(document.payload)) fail(`${label} content.payload must be an object`);
    const expectedProducer = {
      role_uat: UAT_RUNNER,
      browser_uat: BROWSER_UAT_RUNNER,
      fixture_cleanup: FIXTURE_RUNNER,
      alert_drill: ALERT_RUNNER,
      performance: PERFORMANCE_RUNNER,
      delayed_verification: DELAYED_RUNNER,
    }[artifact.kind];
    const verifiedReceipt = verifyPostdeployArtifactReceipt({
      document,
      publicKeyBytes: receiptPublicKeyBytes,
      expectedProducer,
    });
    const signedAt = timestamp(verifiedReceipt.signedAt, `${label} content.receipt.signed_at`);
    if (signedAt < observedAt) fail(`${label} receipt was signed before its observation completed`);
    assertNotFuture(signedAt, nowMs, `${label} content.receipt.signed_at`);
    const verifiedArtifact = { ...artifact, bytes, document, observedAt };
    artifactsById.set(artifact.id, verifiedArtifact);
    artifactPaths.add(artifact.path);
    verifiedArtifacts.push(verifiedArtifact);
  }

  const referencedArtifacts = new Set();
  const referenceArtifact = (id, label) => {
    stringMatching(id, IDENTIFIER, label);
    if (!artifactsById.has(id)) fail(`${label} names an undeclared artifact`);
    referencedArtifacts.add(id);
  };

  const requiredRoleNames = policy.required_roles;
  const roles = nonEmptyArray(bundle.roles, "bundle.roles", { minimum: requiredRoleNames.length, maximum: requiredRoleNames.length });
  const rolesByName = new Map();
  const actorIds = new Set();
  const roleCompletedTimes = [];
  for (const [index, role] of roles.entries()) {
    const label = `bundle.roles[${index}]`;
    exactKeys(role, ["role", "actor_id", "status", "completed_at", "flow_ids", "artifact_id"], label);
    if (!requiredRoleNames.includes(role.role)) fail(`${label}.role is not required by policy`);
    if (rolesByName.has(role.role)) fail(`bundle.roles contains duplicate role ${JSON.stringify(role.role)}`);
    stringMatching(role.actor_id, UUID, `${label}.actor_id`);
    if (actorIds.has(role.actor_id)) fail("four-role acceptance must use four distinct actor IDs");
    if (role.status !== "pass") fail(`${label}.status must be pass`);
    const completed = timestamp(role.completed_at, `${label}.completed_at`);
    if (completed < deployedAt) fail(`${label}.completed_at predates deployment`);
    assertNotFuture(completed, nowMs, `${label}.completed_at`);
    const flowIds = uniqueStrings(nonEmptyArray(role.flow_ids, `${label}.flow_ids`), `${label}.flow_ids`, IDENTIFIER);
    referenceArtifact(role.artifact_id, `${label}.artifact_id`);
    rolesByName.set(role.role, { ...role, flowIds, completedMs: completed });
    actorIds.add(role.actor_id);
    roleCompletedTimes.push(completed);
  }
  for (const requiredRole of requiredRoleNames) {
    if (!rolesByName.has(requiredRole)) fail(`bundle.roles is missing ${requiredRole}`);
  }

  const expectedBrowserSessionCount = requiredRoleNames.length * policy.browser_uat.required_locales.length;
  const browserClaims = nonEmptyArray(bundle.browser_uat, "bundle.browser_uat", {
    minimum: expectedBrowserSessionCount,
    maximum: expectedBrowserSessionCount,
  });
  const browserSessions = new Map();
  const browserArtifactIds = new Set();
  const browserCompletedTimes = [];
  let claimedBrowserSubjectJson = null;
  for (const [index, session] of browserClaims.entries()) {
    const label = `bundle.browser_uat[${index}]`;
    exactKeys(session, ["role", "actor_id", "locale", "subject", "status", "completed_at", "artifact_id"], label);
    if (!requiredRoleNames.includes(session.role) || !policy.browser_uat.required_locales.includes(session.locale)) {
      fail(`${label} is not a required role-locale pair`);
    }
    const expectedActor = rolesByName.get(session.role).actor_id;
    if (session.actor_id !== expectedActor) fail(`${label}.actor_id does not match the authenticated role actor`);
    const claimedSubject = verifyBrowserSubject(session.subject, `${label}.subject`);
    const claimedSubjectJson = JSON.stringify(claimedSubject);
    if (claimedBrowserSubjectJson === null) claimedBrowserSubjectJson = claimedSubjectJson;
    if (claimedSubjectJson !== claimedBrowserSubjectJson) fail("bundle.browser_uat must bind one exact fixture subject across all role-locale sessions");
    if (session.status !== "pass") fail(`${label}.status must be pass`);
    const key = `${session.role}:${session.locale}`;
    const expectedRole = requiredRoleNames[Math.floor(index / policy.browser_uat.required_locales.length)];
    const expectedLocale = policy.browser_uat.required_locales[index % policy.browser_uat.required_locales.length];
    if (session.role !== expectedRole || session.locale !== expectedLocale) fail("bundle.browser_uat is not in canonical role-locale order");
    if (browserSessions.has(key)) fail(`bundle.browser_uat contains duplicate ${key}`);
    if (browserArtifactIds.has(session.artifact_id)) fail("each browser role-locale session must use a distinct artifact");
    const completed = timestamp(session.completed_at, `${label}.completed_at`);
    if (completed < deployedAt) fail(`${label}.completed_at predates deployment`);
    assertNotFuture(completed, nowMs, `${label}.completed_at`);
    referenceArtifact(session.artifact_id, `${label}.artifact_id`);
    browserSessions.set(key, { ...session, completedMs: completed });
    browserArtifactIds.add(session.artifact_id);
    browserCompletedTimes.push(completed);
  }
  for (const role of requiredRoleNames) {
    for (const locale of policy.browser_uat.required_locales) {
      if (!browserSessions.has(`${role}:${locale}`)) fail(`bundle.browser_uat is missing ${role}:${locale}`);
    }
  }

  const requiredFlows = policy.required_flows;
  const flows = nonEmptyArray(bundle.flows, "bundle.flows", { minimum: requiredFlows.length, maximum: requiredFlows.length });
  const flowsById = new Map();
  const flowCompletedTimes = [];
  for (const [index, flow] of flows.entries()) {
    const label = `bundle.flows[${index}]`;
    exactKeys(flow, ["id", "role", "status", "started_at", "completed_at", "artifact_id"], label);
    stringMatching(flow.id, IDENTIFIER, `${label}.id`);
    const required = requiredFlows.find((entry) => entry.id === flow.id);
    if (!required) fail(`${label}.id is not required by policy`);
    if (flow.role !== required.role) fail(`${label}.role does not match policy`);
    if (flow.status !== "pass") fail(`${label}.status must be pass`);
    if (flowsById.has(flow.id)) fail(`bundle.flows contains duplicate ${JSON.stringify(flow.id)}`);
    const started = timestamp(flow.started_at, `${label}.started_at`);
    const completed = timestamp(flow.completed_at, `${label}.completed_at`);
    if (started < deployedAt) fail(`${label}.started_at predates deployment`);
    if (completed < started) fail(`${label}.completed_at precedes started_at`);
    assertNotFuture(completed, nowMs, `${label}.completed_at`);
    referenceArtifact(flow.artifact_id, `${label}.artifact_id`);
    flowsById.set(flow.id, { ...flow, startedMs: started, completedMs: completed });
    flowCompletedTimes.push(completed);
  }
  for (const required of requiredFlows) {
    if (!flowsById.has(required.id)) fail(`bundle.flows is missing ${required.id}`);
  }
  for (const roleName of requiredRoleNames) {
    const expected = new Set(requiredFlows.filter((flow) => flow.role === roleName).map((flow) => flow.id));
    const actual = rolesByName.get(roleName).flowIds;
    if (expected.size !== actual.size || [...expected].some((flow) => !actual.has(flow))) {
      fail(`bundle role ${roleName} flow_ids do not exactly cover its required flows`);
    }
  }

  exactKeys(bundle.fixtures, [
    "created_ids",
    "cleaned_ids",
    "residual_count",
    "verified_at",
    "payment_id",
    "payment_status",
    "payment_void_request_id",
    "payment_void_receipt_sha256",
    "payment_voided_at",
    "kpi_baseline_sha256",
    "kpi_restored_sha256",
    "artifact_id",
  ], "bundle.fixtures");
  const created = uniqueStrings(nonEmptyArray(bundle.fixtures.created_ids, "bundle.fixtures.created_ids"), "bundle.fixtures.created_ids", UUID);
  const cleaned = uniqueStrings(nonEmptyArray(bundle.fixtures.cleaned_ids, "bundle.fixtures.cleaned_ids"), "bundle.fixtures.cleaned_ids", UUID);
  if (created.size !== cleaned.size || [...created].some((id) => !cleaned.has(id))) {
    fail("fixture created_ids and cleaned_ids must be identical sets");
  }
  if (integer(bundle.fixtures.residual_count, "bundle.fixtures.residual_count") !== policy.fixture_cleanup.maximum_residual_count) {
    fail("fixture residual_count exceeds policy");
  }
  const fixtureVerified = timestamp(bundle.fixtures.verified_at, "bundle.fixtures.verified_at");
  if (fixtureVerified < deployedAt) fail("bundle.fixtures.verified_at predates deployment");
  assertNotFuture(fixtureVerified, nowMs, "bundle.fixtures.verified_at");
  stringMatching(bundle.fixtures.payment_id, UUID, "bundle.fixtures.payment_id");
  if (!created.has(bundle.fixtures.payment_id)) fail("bundle.fixtures.payment_id was not created by this run");
  if (bundle.fixtures.payment_status !== "voided") fail("fixture payment was not canonically voided");
  stringMatching(bundle.fixtures.payment_void_request_id, EVENT_ID, "bundle.fixtures.payment_void_request_id");
  stringMatching(bundle.fixtures.payment_void_receipt_sha256, SHA256, "bundle.fixtures.payment_void_receipt_sha256");
  stringMatching(bundle.fixtures.kpi_baseline_sha256, SHA256, "bundle.fixtures.kpi_baseline_sha256");
  stringMatching(bundle.fixtures.kpi_restored_sha256, SHA256, "bundle.fixtures.kpi_restored_sha256");
  if (bundle.fixtures.kpi_baseline_sha256 !== bundle.fixtures.kpi_restored_sha256) {
    fail("fixture payment KPI effect was not restored to the exact baseline");
  }
  const paymentVoided = timestamp(bundle.fixtures.payment_voided_at, "bundle.fixtures.payment_voided_at");
  if (paymentVoided < deployedAt || paymentVoided > fixtureVerified) fail("fixture payment reversal time is outside the deploy/cleanup interval");
  assertNotFuture(paymentVoided, nowMs, "bundle.fixtures.payment_voided_at");
  referenceArtifact(bundle.fixtures.artifact_id, "bundle.fixtures.artifact_id");

  exactKeys(bundle.alert_drill, [
    "failure_event_id",
    "recovery_event_id",
    "failure_provider_delivery_id",
    "recovery_provider_delivery_id",
    "failure_provider_operation_id",
    "recovery_provider_operation_id",
    "failure_trigger_sha256",
    "recovery_trigger_sha256",
    "failure_receipt_sha256",
    "recovery_receipt_sha256",
    "failed_at",
    "recovered_at",
    "final_status",
    "artifact_id",
  ], "bundle.alert_drill");
  stringMatching(bundle.alert_drill.failure_event_id, EVENT_ID, "bundle.alert_drill.failure_event_id");
  stringMatching(bundle.alert_drill.recovery_event_id, EVENT_ID, "bundle.alert_drill.recovery_event_id");
  stringMatching(bundle.alert_drill.failure_provider_delivery_id, EVENT_ID, "bundle.alert_drill.failure_provider_delivery_id");
  stringMatching(bundle.alert_drill.recovery_provider_delivery_id, EVENT_ID, "bundle.alert_drill.recovery_provider_delivery_id");
  stringMatching(bundle.alert_drill.failure_provider_operation_id, EVENT_ID, "bundle.alert_drill.failure_provider_operation_id");
  stringMatching(bundle.alert_drill.recovery_provider_operation_id, EVENT_ID, "bundle.alert_drill.recovery_provider_operation_id");
  for (const field of ["failure_trigger_sha256", "recovery_trigger_sha256", "failure_receipt_sha256", "recovery_receipt_sha256"]) {
    stringMatching(bundle.alert_drill[field], SHA256, `bundle.alert_drill.${field}`);
  }
  if (bundle.alert_drill.failure_event_id === bundle.alert_drill.recovery_event_id) fail("alert failure and recovery event IDs must differ");
  if (bundle.alert_drill.failure_provider_delivery_id === bundle.alert_drill.recovery_provider_delivery_id) {
    fail("alert failure and recovery provider delivery IDs must differ");
  }
  if (bundle.alert_drill.failure_provider_operation_id === bundle.alert_drill.recovery_provider_operation_id) {
    fail("alert failure and recovery provider operation IDs must differ");
  }
  if (bundle.alert_drill.failure_trigger_sha256 === bundle.alert_drill.recovery_trigger_sha256) {
    fail("alert failure and recovery canonical trigger digests must differ");
  }
  if (bundle.alert_drill.final_status !== policy.alert_drill.final_status) fail("alert drill final_status is not ok");
  const failedAt = timestamp(bundle.alert_drill.failed_at, "bundle.alert_drill.failed_at");
  const recoveredAt = timestamp(bundle.alert_drill.recovered_at, "bundle.alert_drill.recovered_at");
  if (failedAt < deployedAt) fail("alert drill failure predates deployment");
  if (recoveredAt <= failedAt) fail("alert recovery must occur after failure");
  assertNotFuture(recoveredAt, nowMs, "bundle.alert_drill.recovered_at");
  referenceArtifact(bundle.alert_drill.artifact_id, "bundle.alert_drill.artifact_id");

  exactKeys(bundle.performance, ["samples_ms", "p75_ms", "p95_ms", "measured_at", "artifact_id"], "bundle.performance");
  const samples = nonEmptyArray(bundle.performance.samples_ms, "bundle.performance.samples_ms", {
    minimum: policy.performance.minimum_sample_count,
    maximum: 10000,
  });
  samples.forEach((sample, index) => integer(sample, `bundle.performance.samples_ms[${index}]`, { maximum: 600000 }));
  const p75 = nearestRank(samples, 0.75);
  const p95 = nearestRank(samples, 0.95);
  if (bundle.performance.p75_ms !== p75 || bundle.performance.p95_ms !== p95) {
    fail(`performance percentiles are not nearest-rank values (expected p75=${p75}, p95=${p95})`);
  }
  if (p75 > policy.performance.p75_max_ms || p95 > policy.performance.p95_max_ms) {
    fail("performance percentiles exceed policy thresholds");
  }
  const measuredAt = timestamp(bundle.performance.measured_at, "bundle.performance.measured_at");
  if (measuredAt < deployedAt) fail("bundle.performance.measured_at predates deployment");
  assertNotFuture(measuredAt, nowMs, "bundle.performance.measured_at");
  referenceArtifact(bundle.performance.artifact_id, "bundle.performance.artifact_id");

  exactKeys(bundle.delayed_verification, [
    "not_before",
    "completed_at",
    "status",
    "provider_trigger_sha256",
    "provider_event_id",
    "provider_delivery_id",
    "provider_query_id",
    "provider_receipt_sha256",
    "provider_observed_at",
    "artifact_id",
  ], "bundle.delayed_verification");
  if (bundle.delayed_verification.status !== "pass") fail("delayed verification status must be pass");
  const notBefore = timestamp(bundle.delayed_verification.not_before, "bundle.delayed_verification.not_before");
  const delayedCompleted = timestamp(bundle.delayed_verification.completed_at, "bundle.delayed_verification.completed_at");
  stringMatching(bundle.delayed_verification.provider_trigger_sha256, SHA256, "bundle.delayed_verification.provider_trigger_sha256");
  stringMatching(bundle.delayed_verification.provider_event_id, EVENT_ID, "bundle.delayed_verification.provider_event_id");
  stringMatching(bundle.delayed_verification.provider_delivery_id, EVENT_ID, "bundle.delayed_verification.provider_delivery_id");
  stringMatching(bundle.delayed_verification.provider_query_id, EVENT_ID, "bundle.delayed_verification.provider_query_id");
  stringMatching(bundle.delayed_verification.provider_receipt_sha256, SHA256, "bundle.delayed_verification.provider_receipt_sha256");
  const providerObservedAt = timestamp(bundle.delayed_verification.provider_observed_at, "bundle.delayed_verification.provider_observed_at");
  const minimumNotBefore = deployedAt + policy.delayed_verification.minimum_delay_seconds * 1000;
  if (notBefore < minimumNotBefore) fail("delayed verification not_before is earlier than policy permits");
  if (delayedCompleted < notBefore) fail("delayed verification completed before not_before");
  if (providerObservedAt < notBefore || providerObservedAt > delayedCompleted) {
    fail("delayed provider readback was not freshly observed inside the delayed interval");
  }
  if (
    bundle.delayed_verification.provider_event_id !== bundle.alert_drill.recovery_event_id
    || bundle.delayed_verification.provider_delivery_id !== bundle.alert_drill.recovery_provider_delivery_id
    || bundle.delayed_verification.provider_query_id === bundle.alert_drill.recovery_provider_operation_id
  ) {
    fail("delayed provider readback is not bound to the recovered alert through a distinct provider query");
  }
  assertNotFuture(delayedCompleted, nowMs, "bundle.delayed_verification.completed_at");
  referenceArtifact(bundle.delayed_verification.artifact_id, "bundle.delayed_verification.artifact_id");

  const generatedAt = timestamp(bundle.generated_at, "bundle.generated_at");
  const latestEvidence = Math.max(
    deployedAt,
    ...roleCompletedTimes,
    ...browserCompletedTimes,
    ...flowCompletedTimes,
    fixtureVerified,
    recoveredAt,
    measuredAt,
    delayedCompleted,
  );
  if (generatedAt < latestEvidence) fail("bundle.generated_at predates contained evidence");
  assertNotFuture(generatedAt, nowMs, "bundle.generated_at");
  if (referencedArtifacts.size !== artifactsById.size) fail("bundle contains an unreferenced artifact");
  verifyArtifactContracts({
    bundle,
    policy,
    artifactsById,
    rolesByName,
    flowsById,
    created,
    cleaned,
    browserSessions,
    artifactRoot,
    requireRootOwned,
    deployedAt,
    nowMs,
  });

  return {
    bundle,
    bundleBytes,
    bundlePath,
    policy,
    schema,
    receiptKeySha256,
    artifacts: verifiedArtifacts,
    bundleSha256: sha256(bundleBytes),
    policySha256: sha256(policyBytes),
    schemaSha256: sha256(schemaBytes),
    verifiedAt: new Date(nowMs).toISOString().replace(".000Z", "Z"),
    requireRootOwned,
  };
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeDurable(filePath, bytes, mode = 0o600) {
  if (existsSync(filePath)) {
    const existing = requireSafeFile(filePath, filePath, { maximumBytes: 64 * 1024 * 1024 });
    if (!existing.equals(bytes)) fail(`sealed file already exists with different bytes: ${filePath}`);
    return;
  }
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function sealVerifiedAcceptance(result, sealDirectory, { recoverPending = false } = {}) {
  const resolved = path.resolve(sealDirectory);
  const sealedArtifacts = [];
  for (const artifact of [...result.artifacts].sort((left, right) => left.id.localeCompare(right.id))) {
    const relativeFile = `artifacts/${artifact.sha256}`;
    sealedArtifacts.push({ id: artifact.id, sha256: artifact.sha256, file: relativeFile });
  }

  const attestation = {
    attestation_version: ATTESTATION_VERSION,
    schema_version: SCHEMA_VERSION,
    release_sha: result.bundle.release.git_sha,
    build_id: result.bundle.release.build_id,
    deploy_run_id: result.bundle.release.deploy_run_id,
    bundle_sha256: result.bundleSha256,
    policy_sha256: result.policySha256,
    schema_sha256: result.schemaSha256,
    receipt_key_sha256: result.receiptKeySha256,
    sealed_artifacts: sealedArtifacts,
    verified_at: result.verifiedAt,
  };
  const attestationBytes = Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`, "utf8");
  const expectedFiles = new Map([
    ["bundle.json", result.bundleBytes],
    ["attestation.json", attestationBytes],
    ...[...result.artifacts].map((artifact) => [`artifacts/${artifact.sha256}`, artifact.bytes]),
  ]);
  const verifyTree = (directory) => {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("seal transaction root must be a non-symlink directory");
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) fail("seal transaction root must have mode 0700");
    if (result.requireRootOwned && (metadata.uid !== 0 || metadata.gid !== 0)) fail("seal transaction root must be root-owned");
    const artifactsDirectory = path.join(directory, "artifacts");
    const artifactMetadata = lstatSync(artifactsDirectory);
    if (!artifactMetadata.isDirectory() || artifactMetadata.isSymbolicLink()) fail("seal transaction artifacts path is invalid");
    if (process.platform !== "win32" && (artifactMetadata.mode & 0o077) !== 0) fail("seal transaction artifacts path must have mode 0700");
    if (result.requireRootOwned && (artifactMetadata.uid !== 0 || artifactMetadata.gid !== 0)) fail("seal transaction artifacts path must be root-owned");
    const rootEntries = readdirSync(directory).sort();
    if (JSON.stringify(rootEntries) !== JSON.stringify(["artifacts", "attestation.json", "bundle.json"])) {
      fail("seal transaction root inventory is not exact");
    }
    const expectedArtifactNames = [...expectedFiles.keys()]
      .filter((file) => file.startsWith("artifacts/"))
      .map((file) => file.slice("artifacts/".length))
      .sort();
    if (JSON.stringify(readdirSync(artifactsDirectory).sort()) !== JSON.stringify(expectedArtifactNames)) {
      fail("seal transaction artifact inventory is not exact");
    }
    for (const [relativeFile, expectedBytes] of expectedFiles) {
      const actual = requireSafeFile(path.join(directory, ...relativeFile.split("/")), `sealed ${relativeFile}`, {
        requireRootOwned: result.requireRootOwned,
        maximumBytes: 64 * 1024 * 1024,
      });
      if (!actual.equals(expectedBytes)) fail(`sealed ${relativeFile} bytes do not match the verified transaction`);
    }
  };

  const pending = `${resolved}.pending`;
  if (existsSync(resolved)) {
    if (existsSync(pending)) fail("completed seal has an unresolved pending transaction");
    verifyTree(resolved);
    return attestation;
  }
  const pendingExists = existsSync(pending);
  if (pendingExists && !recoverPending) fail("postdeploy seal transaction recovery or abort is required");
  if (!pendingExists) {
    mkdirSync(pending, { mode: 0o700 });
  } else {
    const pendingMetadata = lstatSync(pending);
    if (!pendingMetadata.isDirectory() || pendingMetadata.isSymbolicLink()) fail("seal transaction root must be a non-symlink directory");
    if (process.platform !== "win32" && (pendingMetadata.mode & 0o077) !== 0) fail("seal transaction root must have mode 0700");
    if (result.requireRootOwned && (pendingMetadata.uid !== 0 || pendingMetadata.gid !== 0)) fail("seal transaction root must be root-owned");
    const allowedRootEntries = new Set(["artifacts", "attestation.json", "bundle.json"]);
    if (readdirSync(pending).some((entry) => !allowedRootEntries.has(entry))) fail("seal recovery found an unexpected root entry");
  }
  const artifactsDirectory = path.join(pending, "artifacts");
  if (!existsSync(artifactsDirectory)) {
    mkdirSync(artifactsDirectory, { mode: 0o700 });
  } else {
    const artifactMetadata = lstatSync(artifactsDirectory);
    if (!artifactMetadata.isDirectory() || artifactMetadata.isSymbolicLink()) fail("seal transaction artifacts path is invalid");
    if (process.platform !== "win32" && (artifactMetadata.mode & 0o077) !== 0) fail("seal transaction artifacts path must have mode 0700");
    if (result.requireRootOwned && (artifactMetadata.uid !== 0 || artifactMetadata.gid !== 0)) fail("seal transaction artifacts path must be root-owned");
    const expectedArtifactNames = new Set(result.artifacts.map((artifact) => artifact.sha256));
    if (readdirSync(artifactsDirectory).some((entry) => !expectedArtifactNames.has(entry))) {
      fail("seal recovery found an unexpected artifact entry");
    }
  }
  writeDurable(path.join(pending, "bundle.json"), result.bundleBytes);
  for (const artifact of result.artifacts) writeDurable(path.join(artifactsDirectory, artifact.sha256), artifact.bytes);
  writeDurable(path.join(pending, "attestation.json"), attestationBytes);
  fsyncDirectory(artifactsDirectory);
  fsyncDirectory(pending);
  verifyTree(pending);
  renameSync(pending, resolved);
  fsyncDirectory(path.dirname(resolved));
  return attestation;
}

export function abortSealTransaction(sealDirectory, { requireRootOwned = false } = {}) {
  const resolved = path.resolve(sealDirectory);
  const pending = `${resolved}.pending`;
  if (existsSync(resolved)) fail("cannot abort a completed postdeploy seal");
  if (!existsSync(pending)) return { status: "none" };
  const parent = path.dirname(resolved);
  if (path.dirname(pending) !== parent || !path.basename(pending).endsWith(".pending")) fail("seal abort target is invalid");
  const metadata = lstatSync(pending);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("seal abort target is not a directory transaction");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) fail("seal abort target must have mode 0700");
  if (requireRootOwned && (metadata.uid !== 0 || metadata.gid !== 0)) fail("seal abort target must be root-owned");
  rmSync(pending, { recursive: true, force: false });
  fsyncDirectory(parent);
  return { status: "aborted" };
}

function parseArgs(argv) {
  const valueFlags = new Set([
    "--bundle",
    "--policy",
    "--schema",
    "--receipt-public-key",
    "--artifact-root",
    "--expected-release-sha",
    "--expected-build-id",
    "--expected-deploy-run-id",
    "--expected-deployed-at",
    "--now",
    "--seal-dir",
    "--abort-seal-dir",
  ]);
  const booleanFlags = new Set(["--require-root-owned", "--recover-seal"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (booleanFlags.has(flag)) {
      if (values.has(flag)) fail(`argument ${flag} was provided more than once`);
      values.set(flag, true);
      continue;
    }
    if (!valueFlags.has(flag)) fail(`unknown argument ${JSON.stringify(flag)}`);
    if (values.has(flag)) fail(`argument ${flag} was provided more than once`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`argument ${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  if (values.has("--abort-seal-dir")) {
      if ([...values.keys()].some((flag) => !["--abort-seal-dir", "--require-root-owned"].includes(flag))) {
      fail("seal abort mode accepts no verification arguments");
    }
    return values;
  }
  for (const flag of [
    "--bundle",
    "--policy",
    "--schema",
    "--receipt-public-key",
    "--artifact-root",
    "--expected-release-sha",
    "--expected-build-id",
    "--expected-deploy-run-id",
    "--expected-deployed-at",
  ]) {
    if (!values.has(flag)) fail(`missing required argument ${flag}`);
  }
  return values;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    const requireRootOwned = options.has("--require-root-owned");
    if (options.has("--abort-seal-dir")) {
      process.stdout.write(`${JSON.stringify(abortSealTransaction(options.get("--abort-seal-dir"), { requireRootOwned }))}\n`);
      return 0;
    }
    const bundlePath = path.resolve(options.get("--bundle"));
    const policyPath = path.resolve(options.get("--policy"));
    const schemaPath = path.resolve(options.get("--schema"));
    const result = verifyPostdeployAcceptance({
      bundleBytes: requireSafeFile(bundlePath, "postdeploy evidence bundle", { requireRootOwned, maximumBytes: 1024 * 1024 }),
      bundlePath,
      policyBytes: requireSafeFile(policyPath, "postdeploy policy", { maximumBytes: 1024 * 1024 }),
      schemaBytes: requireSafeFile(schemaPath, "postdeploy schema", { maximumBytes: 1024 * 1024 }),
      receiptPublicKeyBytes: requireSafeFile(
        path.resolve(options.get("--receipt-public-key")),
        "postdeploy receipt public key",
        { requireRootOwned, maximumBytes: 64 * 1024 },
      ),
      artifactRoot: path.resolve(options.get("--artifact-root")),
      expectedReleaseSha: options.get("--expected-release-sha"),
      expectedBuildId: options.get("--expected-build-id"),
      expectedDeployRunId: options.get("--expected-deploy-run-id"),
      expectedDeployedAt: options.get("--expected-deployed-at"),
      now: options.has("--now") ? new Date(options.get("--now")) : new Date(),
      requireRootOwned,
    });
    if (options.has("--recover-seal") && !options.has("--seal-dir")) fail("--recover-seal requires --seal-dir");
    const attestation = options.has("--seal-dir")
      ? sealVerifiedAcceptance(result, options.get("--seal-dir"), { recoverPending: options.has("--recover-seal") })
      : {
          bundle_sha256: result.bundleSha256,
          policy_sha256: result.policySha256,
          schema_sha256: result.schemaSha256,
          receipt_key_sha256: result.receiptKeySha256,
          verified_at: result.verifiedAt,
        };
    process.stdout.write(`${JSON.stringify(attestation)}\n`);
    return 0;
  } catch (error) {
    console.error(`postdeploy acceptance: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
