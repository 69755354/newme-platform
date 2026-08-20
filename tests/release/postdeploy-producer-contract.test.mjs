import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertExactPaymentKpiRestoration,
  assertNoServiceRestartSinceDeploy,
  compareFixtureInventory,
  describeDatabaseFailure,
  FIXTURE_LEAD_SOURCE,
  LEAD_WON_APPROVAL_STATUS,
  LEAD_WON_APPROVAL_STEP,
  LEAD_WON_CONTRACT_APPROVAL_STATUS,
  LEAD_WON_CONTRACT_STATUS,
  leadWonUnmetExpectations,
  requireProtectedAncestors,
  taxonomyValue,
  verifyAlertProviderReadback,
} from "../../scripts/run-postdeploy-acceptance.mjs";
import { canonicalJsonBytes } from "../../scripts/postdeploy-receipt.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PRODUCER = readFileSync(path.join(ROOT, "scripts/run-postdeploy-acceptance.mjs"), "utf8");
const CANONICAL_BROWSER = readFileSync(path.join(ROOT, "scripts/canonical-browser-uat.mjs"), "utf8");
const BROWSER_RUNNER = readFileSync(path.join(ROOT, "scripts/run-postdeploy-browser-uat.mjs"), "utf8");
const WRAPPER = readFileSync(path.join(ROOT, "infra/systemd/newme-deploy.sh"), "utf8");
const PROVIDER = readFileSync(path.join(ROOT, "infra/observability/newme-alert-provider-v1.mjs"), "utf8");
const NOTIFIER = readFileSync(path.join(ROOT, "infra/observability/hermes-alert-notifier-v1.sh"), "utf8");
const ALERT_STATE = readFileSync(path.join(ROOT, "infra/observability/hermes-alert-state-v1.sh"), "utf8");
const ALERT_POLICY = readFileSync(path.join(ROOT, "infra/observability/hermes-alert-v1.env.example"), "utf8");
const INSTALLER = readFileSync(path.join(ROOT, "scripts/install-systemd-assets.sh"), "utf8");
const REQUIRED_JOBS = JSON.parse(readFileSync(path.join(ROOT, "infra/release/required-jobs.json"), "utf8"));
const digest = (value) => createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");

function predeployCiPython() {
  const startMarker = "CI_GATE_AUDIT_RESULT=\"$(python3 -c '\n";
  const start = WRAPPER.indexOf(startMarker);
  const end = WRAPPER.indexOf("\n' \"$SHA\"", start + startMarker.length);
  assert.ok(start >= 0 && end > start, "predeploy CI Python gate was not found");
  return WRAPPER.slice(start + startMarker.length, end);
}

function runPredeployCiGate(overrides = {}) {
  const sha = "a".repeat(40);
  const runId = "29351813434";
  const completedAt = new Date(Date.now() - 60_000);
  const startedAt = new Date(completedAt.getTime() - 60_000);
  const createdAt = new Date(startedAt.getTime() - 60_000);
  const run = {
    id: Number(runId),
    head_sha: sha,
    name: REQUIRED_JOBS.workflow,
    path: REQUIRED_JOBS.workflow_path,
    workflow_id: REQUIRED_JOBS.workflow_id,
    status: "completed",
    conclusion: "success",
    event: REQUIRED_JOBS.event,
    head_branch: REQUIRED_JOBS.head_branch,
    created_at: createdAt.toISOString(),
    run_started_at: startedAt.toISOString(),
    updated_at: completedAt.toISOString(),
    ...overrides.run,
  };
  const jobs = REQUIRED_JOBS.required_jobs.map((entry) => ({
    name: entry.name,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
  }));
  const workflow = {
    id: REQUIRED_JOBS.workflow_id,
    path: REQUIRED_JOBS.workflow_path,
    name: REQUIRED_JOBS.workflow,
    state: "active",
    ...overrides.workflow,
  };
  return spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-c", predeployCiPython(), sha, runId,
      JSON.stringify(run),
      JSON.stringify({ total_count: jobs.length, jobs }),
      JSON.stringify(workflow),
      JSON.stringify(REQUIRED_JOBS),
    ],
    { encoding: "utf8", windowsHide: true },
  );
}

test("an interrupted confirmed payment cannot pass cleanup until its real-month KPI baseline is exactly restored", () => {
  const existingRealTarget = [{ id: "10000000-0000-4000-8000-000000000001", actual_amount: "4000.00" }];
  const effect = { baseline_rows: existingRealTarget, baseline_sha256: digest(existingRealTarget) };

  assert.equal(assertExactPaymentKpiRestoration(effect, existingRealTarget).sha256, effect.baseline_sha256);
  assert.throws(
    () => assertExactPaymentKpiRestoration(effect, [{ ...existingRealTarget[0], actual_amount: "5000.00" }]),
    /fixture_payment_kpi_not_restored/,
  );
  assert.throws(
    () => assertExactPaymentKpiRestoration(effect, [...existingRealTarget, { id: "10000000-0000-4000-8000-000000000002", actual_amount: "0.00" }]),
    /fixture_payment_kpi_not_restored/,
  );
});

test("the producer durably snapshots before confirm and reverses through the canonical API on normal and failure paths", () => {
  const snapshot = PRODUCER.indexOf("await capturePaymentKpiBaseline(db, fixture, journal)");
  const flows = PRODUCER.indexOf("flowResults = await runBusinessFlows({ db, sessions, fixture })");
  assert.ok(snapshot > 0 && snapshot < flows, "the durable KPI snapshot must precede the payment flow");
  assert.match(PRODUCER, /journal\.payment_effect = effect;[\s\S]*persistJournal\(journal\)/);
  assert.match(PRODUCER, /`\/api\/payments\/\$\{fixture\.ids\.payment\}\/void`/);
  assert.match(PRODUCER, /assertFixturePaymentSafeToDelete\(db, fixture\)[\s\S]*delete from public\.payments/);
  assert.match(PRODUCER, /catch \(error\)[\s\S]*reverseFixturePayment\([\s\S]*cleanupFixtures\(/);
  assert.match(PRODUCER, /recoverCanonicalPostdeployAcceptance[\s\S]*reverseFixturePayment\([\s\S]*cleanupFixtures\(/);
});

test("fixture KPI cleanup is exact-ID and period-lock scoped, and foreign rows are preserved", () => {
  assert.match(PRODUCER, /pg_advisory_xact_lock\(hashtextextended\('public\.kpi_targets:' \|\| \$1, 0\)\)/);
  assert.match(PRODUCER, /delete from public\.kpi_targets where id = any\(\$1::uuid\[\]\) and period = \$2 and notes = \$3 and set_by = \$4 returning id/);
  assert.doesNotMatch(PRODUCER, /delete from public\.kpi_targets where period = \$1/);
  assert.match(PRODUCER, /foreignKpiRowPresent[\s\S]*fixture_kpi_foreign_row_present/);
});

test("normal cleanup refuses already-missing objects while recovery records the exact missing subset", () => {
  const expected = [
    { table: "leads", id: "10000000-0000-4000-8000-000000000001" },
    { table: "payments", id: "10000000-0000-4000-8000-000000000002" },
  ];
  assert.throws(() => compareFixtureInventory(expected, expected.slice(0, 1)), /fixture_inventory_changed_before_cleanup/);
  assert.deepEqual(
    compareFixtureInventory(expected, expected.slice(0, 1), { allowAlreadyMissing: true }).alreadyMissing,
    [expected[1]],
  );
  assert.throws(
    () => compareFixtureInventory(expected, [...expected, { table: "contracts", id: "10000000-0000-4000-8000-000000000003" }], { allowAlreadyMissing: true }),
    /fixture_inventory_changed_before_cleanup/,
  );
});

test("canonical wrapper fixes acceptance intake and all state changes share its global release lock", () => {
  assert.match(WRAPPER, /exec 9>\/run\/lock\/newme-production-release\.lock[\s\S]*flock -n 9/);
  assert.match(WRAPPER, /POSTDEPLOY_INTAKE_ROOT=\/var\/lib\/newme\/postdeploy-intake-v1/);
  assert.match(WRAPPER, /ATTEST_BUNDLE="\$POSTDEPLOY_INTAKE_ROOT\/\$ATTEST_RELEASE_SHA\/bundle\.json"/);
  assert.doesNotMatch(WRAPPER, /attest[^\n]*<bundle/);
  assert.match(WRAPPER, /--assert-ready --release-sha "\$ATTEST_RELEASE_SHA"/);
  assert.match(WRAPPER, /accept\|accept-recover\|accept-abort/);
  assert.match(WRAPPER, /attest\|attest-recover\|attest-abort/);
  assert.match(WRAPPER, /require_postdeploy_operations_clear\(\)[\s\S]*--assert-operations-clear/);
  const liveRelease = WRAPPER.indexOf('LIVE_RELEASE="$(readlink -f /opt/newme/current', WRAPPER.indexOf('DB_TRANSITION_ONLY=0'));
  const operationsClear = WRAPPER.indexOf('require_postdeploy_operations_clear "$LIVE_RELEASE"', liveRelease);
  const databaseOnlyBranch = WRAPPER.indexOf('if [ "$DB_TRANSITION_ONLY" -eq 1 ]; then', liveRelease);
  assert.ok(
    liveRelease >= 0
      && operationsClear > liveRelease
      && databaseOnlyBranch > operationsClear,
  );
});

test("canonical wrapper executes only immutable exact-SHA postdeploy and finalizer assets", () => {
  assert.match(WRAPPER, /require_immutable_release_asset\(\)/);
  assert.match(WRAPPER, /stat -c '%U:%G'[\s\S]*root:ubuntu/);
  assert.match(WRAPPER, /case "\$expected_mode" in 440\|550/);
  assert.match(WRAPPER, /git --git-dir="\$CANONICAL_RELEASE_MIRROR" show "\$release_sha:\$relative_path" \| sha256sum/);
  const producerValidation = WRAPPER.indexOf('scripts/run-postdeploy-acceptance.mjs "$ATTEST_PRODUCER" 440');
  const producerExecution = WRAPPER.indexOf('"$ATTEST_PRODUCER" --assert-ready');
  assert.ok(producerValidation > 0 && producerValidation < producerExecution);
  assert.match(WRAPPER, /scripts\/verify-postdeploy-acceptance\.mjs "\$ATTEST_VERIFIER" 440/);
  assert.match(WRAPPER, /scripts\/record-deploy-acceptance\.mjs "\$ATTEST_RECORDER" 440/);
  assert.match(WRAPPER, /scripts\/finalize-deploy-evidence\.sh "\$FINALIZE_TARGET\/scripts\/finalize-deploy-evidence\.sh" 440/);
  assert.match(WRAPPER, /scripts\/canonical-browser-uat\.mjs "\$ACCEPT_TARGET\/scripts\/canonical-browser-uat\.mjs" 440/);
  assert.match(WRAPPER, /scripts\/run-postdeploy-browser-uat\.mjs "\$ACCEPT_TARGET\/scripts\/run-postdeploy-browser-uat\.mjs" 440/);
  assert.match(WRAPPER, /POSTDEPLOY_BROWSER_IMAGE='mcr\.microsoft\.com\/playwright:v1\.60\.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948'/);
  assert.match(WRAPPER, /docker image inspect --format '\{\{json \.RepoDigests\}\}' "\$POSTDEPLOY_BROWSER_IMAGE"/);
  assert.match(WRAPPER, /env -i PATH=\/usr\/bin:\/bin HOME=\/root LANG=C\.UTF-8[\s\S]*docker pull "\$POSTDEPLOY_BROWSER_IMAGE"/);
  const imagePreparation = WRAPPER.lastIndexOf("prepare_postdeploy_browser_image");
  const immutableDeploy = WRAPPER.indexOf('bash "$WORKTREE/scripts/deploy-immutable.sh" "$SHA"', imagePreparation);
  assert.ok(imagePreparation > 0 && immutableDeploy > imagePreparation);
});

test("canonical acceptance runs the exact browser matrix in a locked local image and imports every signed raw artifact", () => {
  const roleSessionsRevoked = PRODUCER.indexOf('recordJournalStep(journal, "role_sessions_revoked"');
  const browserRun = PRODUCER.indexOf("browserResult = await runCanonicalBrowserUat");
  const browserInventory = PRODUCER.indexOf("browser_uat_fixture_inventory_verified", browserRun);
  const cleanupRun = PRODUCER.indexOf("cleanup = await cleanupFixtures", browserInventory);
  const performanceRun = PRODUCER.indexOf("const performanceResult = await measurePerformance", browserRun);
  const assemble = PRODUCER.indexOf("const assembled = assemblePostdeployBundle", performanceRun);
  assert.ok(
    roleSessionsRevoked > 0
      && browserRun > roleSessionsRevoked
      && browserInventory > browserRun
      && cleanupRun > browserInventory
      && performanceRun > cleanupRun
      && assemble > performanceRun,
  );
  assert.match(PRODUCER, /fixture: \{\s*marker: fixture\.marker,\s*lead_id: fixture\.ids\.browserLead,\s*contract_id: fixture\.ids\.browserContract,/);
  assert.match(PRODUCER, /postBrowserObjects = await fixtureObjects\(db, fixture\)[\s\S]*compareFixtureInventory\(journal\.observed_objects, postBrowserObjects\)/);
  assert.match(PRODUCER, /browser_uat: structuredClone\(browserResult\.sessions\)/);
  assert.match(PRODUCER, /for \(const \[file, bytes\] of browserResult\.documents\)/);
  assert.match(PRODUCER, /mkdirSync\(parent, \{ recursive: true, mode: 0o700 \}\)/);

  assert.match(CANONICAL_BROWSER, /mcr\.microsoft\.com\/playwright:v1\.60\.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948/);
  for (const marker of [
    '"--pull=never"',
    '"--read-only"',
    '"--user", "pwuser"',
    '"--group-add", String(identity.releaseGid)',
    '"--cap-drop=ALL"',
    '"--security-opt=no-new-privileges"',
    '"--pids-limit=512"',
    '"--mount", `type=bind,src=${releaseRoot},dst=/release,readonly`',
    '"--entrypoint", "/usr/bin/node"',
  ]) assert.ok(CANONICAL_BROWSER.includes(marker), `browser container omitted ${marker}`);
  assert.match(CANONICAL_BROWSER, /image", "inspect", "--format", "\{\{json \.RepoDigests\}\}"/);
  assert.match(CANONICAL_BROWSER, /child\.stdin\.end\(inputBytes\)/);
  assert.match(CANONICAL_BROWSER, /fixture: \{ \.\.\.fixture \}/);
  assert.match(CANONICAL_BROWSER, /session\.subject\.lead_id !== fixture\.lead_id[\s\S]*document\.payload\?\.subject\?\.contract_id !== fixture\.contract_id/);
  assert.match(CANONICAL_BROWSER, /expectedPaths\.size !== 72/);
  assert.match(CANONICAL_BROWSER, /verifyPostdeployArtifactReceipt/);
  assert.doesNotMatch(CANONICAL_BROWSER, /--pull=(?:always|missing)/);
  assert.doesNotMatch(CANONICAL_BROWSER, /password.*(?:args|env)|email.*(?:args|env)/i);
  assert.match(BROWSER_RUNNER, /CANONICAL_DATA_ORIGIN = "https:\/\/vfopmpxlhwzpxqegayew\.supabase\.co"/);
  assert.match(BROWSER_RUNNER, /context\.route\("\*\*\/\*"[\s\S]*!ALLOWED_HTTP_ORIGINS\.has\(origin\)/);
});

test("predeploy CI is bound to the canonical live workflow and a fresh ordered run", () => {
  assert.equal(REQUIRED_JOBS.workflow_path, ".github/workflows/ci.yml");
  assert.equal(REQUIRED_JOBS.workflow_id, 310914082);
  assert.equal(REQUIRED_JOBS.max_run_age_seconds, 86400);
  assert.match(WRAPPER, /actions\/workflows\/\$CANONICAL_CI_WORKFLOW_ID/);
  assert.match(WRAPPER, /run\.get\("path"\) != manifest\.get\("workflow_path"\)/);
  assert.match(WRAPPER, /run\.get\("workflow_id"\) != manifest\.get\("workflow_id"\)/);
  assert.match(WRAPPER, /created_at <= run_started_at <= updated_at/);
  assert.match(WRAPPER, /completion is outside the manifest freshness SLO/);
  assert.match(WRAPPER, /workflow\.get\("state"\) != "active"/);
  assert.match(WRAPPER, /required_job_completed_at/);
  assert.match(WRAPPER, /oldest_completion = min\(completion_values\)/);

  const valid = runPredeployCiGate();
  assert.equal(valid.status, 0, valid.stderr);
  const auditFields = valid.stdout.trim().split("\t");
  assert.equal(auditFields.length, 7);
  assert.match(auditFields[0], /^[0-9a-f]{64}$/);
  assert.equal(auditFields[3], "310914082");
  assert.equal(auditFields[4], ".github/workflows/ci.yml");
  assert.equal(auditFields[5], "86400");
  const auditBytes = Buffer.from(auditFields[6], "base64");
  assert.equal(createHash("sha256").update(auditBytes).digest("hex"), auditFields[0]);
  const auditDocument = JSON.parse(auditBytes);
  assert.equal(auditDocument.version, "newme-ci-gate-audit/v1");
  assert.equal(auditDocument.workflow_id, 310914082);
  assert.equal(auditDocument.max_run_age_seconds, 86400);
  assert.deepEqual(Object.keys(auditDocument.required_job_completed_at).sort(), REQUIRED_JOBS.required_jobs.map((job) => job.name).sort());
  assert.match(auditDocument.manifest_sha256, /^[0-9a-f]{64}$/);

  const lookalike = runPredeployCiGate({ run: { path: ".github/workflows/lookalike.yml" } });
  assert.notEqual(lookalike.status, 0);
  assert.match(lookalike.stderr, /different workflow path/);

  const wrongIdentity = runPredeployCiGate({ workflow: { id: 999 } });
  assert.notEqual(wrongIdentity.status, 0);
  assert.match(wrongIdentity.stderr, /different workflow_id/);

  const stale = runPredeployCiGate({ run: {
    created_at: "2026-08-10T12:00:00Z",
    run_started_at: "2026-08-10T12:01:00Z",
    updated_at: "2026-08-10T12:02:00Z",
  } });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /freshness SLO/);

  const dbBoundary = WRAPPER.indexOf('require_ci_gate_still_fresh', WRAPPER.indexOf('canonical main changed before the database transition'));
  const dbMutation = WRAPPER.indexOf('case "$DB_TRANSITION_OPERATION" in', dbBoundary);
  assert.ok(dbBoundary > 0 && dbBoundary < dbMutation);
  const assetBoundary = WRAPPER.indexOf('require_ci_gate_still_fresh', WRAPPER.indexOf('canonical main changed before the control-plane asset transaction'));
  const assetMutation = WRAPPER.indexOf('ASSET_BACKUP_RECORD="$(mktemp', assetBoundary);
  assert.ok(assetBoundary > 0 && assetBoundary < assetMutation);
  const durableAudit = WRAPPER.indexOf("materialize_ci_gate_audit_record", assetBoundary);
  assert.ok(durableAudit > assetBoundary && durableAudit < assetMutation);
  assert.match(WRAPPER, /CI_GATE_AUDIT_RECORD="\$CI_GATE_AUDIT_RECORD"/);
  // Once the record is materialized, CI_GATE_AUDIT_BASE64 is unset on purpose, so a
  // re-check that could only read that variable would fail every deploy with a
  // bogus "evidence expired". It must fall back to the durable record -- under the
  // same ownership/mode trust, and still bound by the sha256 comparison.
  const freshness = WRAPPER.slice(
    WRAPPER.indexOf("require_ci_gate_still_fresh() {"),
    WRAPPER.indexOf("materialize_ci_gate_audit_record() {"),
  );
  assert.ok(freshness.length > 0);
  assert.match(freshness, /record="\$\{CI_GATE_AUDIT_RECORD:-\}"/);
  assert.match(freshness, /\[ "\$record" = "\$STATE_ROOT\/ci-gate-audit\.pending" \] \|\| return 65/);
  assert.match(freshness, /O_NOFOLLOW/);
  assert.match(freshness, /metadata\.st_uid != 0/);
  assert.match(freshness, /stat\.S_IMODE\(metadata\.st_mode\) != 0o600/);
  assert.match(freshness, /hashlib\.sha256\(audit_bytes\)\.hexdigest\(\) != expected_digest/);
  assert.match(WRAPPER, /unset CI_GATE_AUDIT_BASE64/);
  assert.match(WRAPPER, /CI_MAX_RUN_AGE_SECONDS="\$CI_MAX_RUN_AGE_SECONDS"/);
});

test("provider configuration is installed and validated without accepting a no-op notifier", () => {
  assert.match(INSTALLER, /PROVIDER_CONFIG=\/etc\/newme\/postdeploy-alert-provider-v1\.json/);
  assert.match(INSTALLER, /newme-alert-provider-v1\.mjs" validate-config/);
  assert.match(INSTALLER, /install -D -o root -g root -m 0640 "\$ROOT\/infra\/observability\/hermes-alert-v1\.env\.example" "\$ALERT_POLICY"/);
  assert.match(INSTALLER, /cmp -s "\$ROOT\/infra\/observability\/hermes-alert-v1\.env\.example" "\$ALERT_POLICY"/);
  assert.doesNotMatch(INSTALLER, /\[ -e \/etc\/hermes\/observability\/hermes-alert-v1\.env \] \|\|/);
  assert.match(ALERT_STATE, /CANONICAL_STATE=\/opt\/hermes-scripts\/observability\/hermes-alert-state-v1\.sh/);
  assert.match(ALERT_STATE, /CANONICAL_STATE_ROOT=\/var\/lib\/newme\/hermes-alert-v1/);
  assert.match(ALERT_STATE, /EXPECTED_STATE_DIR="\$CANONICAL_STATE_ROOT\/production"/);
  assert.match(ALERT_STATE, /EXPECTED_STATE_DIR="\$CANONICAL_STATE_ROOT\/postdeploy\/\$DRILL_RELEASE_SHA"/);
  assert.match(ALERT_STATE, /trusted state directory owner mismatch/);
  assert.match(ALERT_STATE, /persisted state path is untrusted/);
  assert.match(ALERT_STATE, /recovery:firing\|recovery:pending_failure\|recovery:pending_recovery/);
  assert.equal(ALERT_POLICY.match(/^HERMES_ALERT_STATE_DIR=(.*)$/m)?.[1], "/var/lib/newme/hermes-alert-v1/production");
  const alertStateTrustCheck = INSTALLER.indexOf("preflight_alert_state_trust ||");
  const installerLockOpen = INSTALLER.indexOf("exec 8>/run/lock/newme-systemd-assets.lock");
  const alertStateInstall = INSTALLER.indexOf("install -d -o root -g root -m 0700", alertStateTrustCheck);
  assert.ok(
    alertStateTrustCheck >= 0 &&
      alertStateTrustCheck < installerLockOpen &&
      installerLockOpen < alertStateInstall,
    "the full alert-state trust preflight must run before the installer's first filesystem write",
  );
  assert.match(INSTALLER, /existing alert state contains untrusted metadata/);
  assert.match(INSTALLER, /metadata\.st_uid != 0 or metadata\.st_gid != 0/);
  assert.match(INSTALLER, /stat\.S_IMODE\(metadata\.st_mode\) != 0o700/);
  assert.match(INSTALLER, /stat\.S_IMODE\(metadata\.st_mode\) != 0o600/);
  assert.match(INSTALLER, /install -d -o root -g root -m 0700[\s\S]*\/var\/lib\/newme\/hermes-alert-v1\/production[\s\S]*\/var\/lib\/newme\/hermes-alert-v1\/postdeploy/);
  assert.match(ALERT_STATE, /if \[ "\$0" = "\$CANONICAL_STATE" \]; then[\s\S]*NOTIFIER="\$CANONICAL_NOTIFIER"/);
  assert.match(PROVIDER, /"getMe"/);
  assert.match(PROVIDER, /"sendMessage"/);
  assert.match(PROVIDER, /"editMessageText"/);
  assert.doesNotMatch(NOTIFIER, /HERMES_ALERT_LIBRARY|hermes_alert|hermes_ok/);
  assert.match(NOTIFIER, /"\$PROVIDER" notify "\$EVENT" "\$SOURCE" "\$DETAIL" "\$LEVEL"/);
  assert.match(NOTIFIER, /ACK_VERSION[\s\S]*ACK_DELIVERY/);
  const ordinaryStart = PROVIDER.indexOf("export async function produceOperationalNotification");
  const ordinaryEnd = PROVIDER.indexOf("function lstatExists", ordinaryStart);
  assert.ok(ordinaryStart > 0 && ordinaryEnd > ordinaryStart);
  assert.doesNotMatch(PROVIDER.slice(ordinaryStart, ordinaryEnd), /receiptSecret|readTrigger|durablePair|INBOX_ROOT/);
  assert.match(PROVIDER, /recoverExistingReceipt\(mode, releaseSha, secret, triggerSha256\)[\s\S]*publishDeliveryIntent\(mode, releaseSha, triggerSha256\)[\s\S]*verifyProviderIdentity/);
  assert.match(PROVIDER, /provider_delivery_outcome_unknown/);
  assert.match(PROVIDER, /persistProviderReceiptPair[\s\S]*return "recovered"/);
});

test("a pre-signed future provider readback cannot satisfy the post-delay challenge", () => {
  const secret = Buffer.alloc(32, 7);
  const receipt = {
    receipt_version: "newme-alert-provider-receipt/v1",
    source: "newme-l0-alert-drill",
    release_sha: "a".repeat(40),
    trigger_sha256: "b".repeat(64),
    event_type: "readback",
    event_id: "newme:alert:recovery:001",
    provider_delivery_id: "telegram:message:1001",
    provider_operation_id: "telegram:edit:1001:1893456000",
    occurred_at: "2030-01-01T00:00:00Z",
    status: "ok",
  };
  const body = Buffer.from(`${JSON.stringify(receipt)}\n`);
  const signature = Buffer.from(`${createHmac("sha256", secret).update(body).digest("hex")}\n`);
  assert.throws(() => verifyAlertProviderReadback({
    body,
    signature,
    secret,
    releaseSha: receipt.release_sha,
    readbackTriggerSha: receipt.trigger_sha256,
    recoveryEventId: receipt.event_id,
    recoveryProviderDeliveryId: receipt.provider_delivery_id,
    recoveryProviderOperationId: "telegram:send:1001",
    notBefore: "2026-08-15T00:15:00Z",
    now: new Date("2026-08-15T00:16:00Z"),
  }), /alert_readback_semantic_invalid/);
  assert.throws(() => verifyAlertProviderReadback({
    body,
    signature,
    secret,
    releaseSha: receipt.release_sha,
    readbackTriggerSha: "c".repeat(64),
    recoveryEventId: receipt.event_id,
    recoveryProviderDeliveryId: receipt.provider_delivery_id,
    recoveryProviderOperationId: "telegram:send:1001",
    notBefore: "2026-08-15T00:15:00Z",
    now: new Date("2030-01-01T00:01:00Z"),
  }), /alert_readback_semantic_invalid/);
});

test("the drill traverses state then notifier before provider delivery and delayed readback edits that recovery message", () => {
  assert.match(NOTIFIER, /\[ "\$#" -eq 3 \] \|\| exit 2/);
  assert.match(NOTIFIER, /"\$PROVIDER" "\$DRILL_MODE" "\$DRILL_RELEASE_SHA"/);
  assert.match(ALERT_STATE, /postdeploy-acceptance-\$DRILL_RELEASE_SHA/);
  assert.match(PRODUCER, /installedObservabilityAsset\(releaseRoot, "hermes-alert-state-v1\.sh"\)/);
  assert.match(PRODUCER, /execFileSync\(stateMachine,[\s\S]*NEWME_ALERT_DRILL_TRIGGER_SHA256: triggerSha256/);
  assert.doesNotMatch(PRODUCER, /execFileSync\(notifier,/);
  assert.doesNotMatch(PRODUCER, /invokeProviderWriter\(\{ releaseRoot, releaseSha, mode: eventType \}\)/);
  assert.match(PRODUCER, /Date\.parse\(verifiedFailure\.occurred_at\) \+ 1050 - Date\.now\(\)/);
  assert.match(PROVIDER, /newme-alert-state-notifier-provider\/v1/);
  assert.match(PROVIDER, /mode === "readback"[\s\S]*readRecoveryReceipt\(releaseSha, secret\)[\s\S]*"editMessageText"/);
  assert.match(PROVIDER, /providerDeliveryId = recovery\.receipt\.provider_delivery_id/);
  assert.match(PROVIDER, /provider_operation_id: providerOperationId/);
  const recoverStart = PRODUCER.indexOf("export async function recoverCanonicalPostdeployAcceptance");
  const recoverAlert = PRODUCER.indexOf("recoverCanonicalAlertState({ releaseRoot, releaseSha })", recoverStart);
  const archiveInbox = PRODUCER.indexOf("uat_alert_inbox", recoverStart);
  assert.ok(recoverAlert > recoverStart && recoverAlert < archiveInbox, "accept-recover must confirm alert recovery before archiving provider state");
  assert.match(PRODUCER, /stageUncertainFailureState\(releaseSha\)[\s\S]*eventType: "recovery", reuseExisting: true/);
});

test("deploy-time service identity rejects a restart even when NRestarts is unchanged", () => {
  const baseline = {
    nrestarts: 0,
    main_pid: 4100,
    invocation_id: "a".repeat(32),
    exec_main_start_monotonic: 100000,
  };
  assert.doesNotThrow(() => assertNoServiceRestartSinceDeploy(baseline, { ...baseline }));
  assert.throws(
    () => assertNoServiceRestartSinceDeploy(baseline, { ...baseline, main_pid: 4101, invocation_id: "b".repeat(32), exec_main_start_monotonic: 100100 }),
    /service_restarted_since_deploy/,
  );
});

// The acceptance producer reads the deployment evidence from inside the
// immutable release tree, which the deploy path owns as root:<service group>
// mode 0550. These four arms pin the rule that made that readable without
// making it lax: root ownership and the absence of any group/other write bit are
// what is required, and the group id is not.
function ancestorMetadata({ uid = 0, gid = 0, mode = 0o550, directory = true, symlink = false } = {}) {
  return {
    uid,
    gid,
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => symlink,
  };
}

function ancestorChain(overridesByPath = {}) {
  return (cursor) => ancestorMetadata(overridesByPath[cursor] ?? {});
}

const RELEASE_EVIDENCE_PATH =
  "/opt/newme/releases/" + "a".repeat(40) + "/.audit/deploy-20260820T025658Z-747121.json";

test("protected ancestors accept the release tree's non-root read group", () => {
  // Exactly what the host has: the release directory is root:ubuntu 0550 and its
  // .audit directory is root:root 0700. Before the fix this threw
  // deployment_evidence_ancestor_untrusted, which is what blocked acceptance.
  const releaseDir = "/opt/newme/releases/" + "a".repeat(40);
  assert.doesNotThrow(() =>
    requireProtectedAncestors(
      RELEASE_EVIDENCE_PATH,
      "deployment_evidence",
      ancestorChain({
        [releaseDir + "/.audit"]: { gid: 0, mode: 0o700 },
        [releaseDir]: { gid: 1000, mode: 0o550 },
        "/opt/newme/releases": { mode: 0o755 },
        "/opt/newme": { mode: 0o755 },
        "/opt": { mode: 0o755 },
        "/": { mode: 0o755 },
      }),
    ),
  );
});

test("protected ancestors still refuse a group-writable directory", () => {
  // The negative control for the arm above. Without it, relaxing the group id
  // would be indistinguishable from deleting the ancestor check: this is the
  // case where a non-root group could replace the evidence file.
  const releaseDir = "/opt/newme/releases/" + "a".repeat(40);
  assert.throws(
    () =>
      requireProtectedAncestors(
        RELEASE_EVIDENCE_PATH,
        "deployment_evidence",
        ancestorChain({
          [releaseDir + "/.audit"]: { gid: 0, mode: 0o700 },
          [releaseDir]: { gid: 1000, mode: 0o570 },
        }),
      ),
    (error) => error.code === "deployment_evidence_ancestor_untrusted",
  );
});

test("protected ancestors refuse a world-writable or non-root ancestor", () => {
  assert.throws(
    () =>
      requireProtectedAncestors(RELEASE_EVIDENCE_PATH, "deployment_evidence", ancestorChain({
        "/opt": { mode: 0o757 },
      })),
    (error) => error.code === "deployment_evidence_ancestor_untrusted",
  );
  assert.throws(
    () =>
      requireProtectedAncestors(RELEASE_EVIDENCE_PATH, "deployment_evidence", ancestorChain({
        "/opt/newme": { uid: 1000 },
      })),
    (error) => error.code === "deployment_evidence_ancestor_untrusted",
  );
  assert.throws(
    () =>
      requireProtectedAncestors(RELEASE_EVIDENCE_PATH, "deployment_evidence", ancestorChain({
        "/opt/newme/releases": { symlink: true },
      })),
    (error) => error.code === "deployment_evidence_ancestor_untrusted",
  );
});

test("the ancestor rule stays tied to the ownership the deploy path enforces", () => {
  // If the deploy path ever stops owning the release tree as root:<group> 0550,
  // or the browser runner stops requiring a non-root group, the reasoning behind
  // the rule above no longer holds and this test must be revisited.
  const deploy = readFileSync(path.join(ROOT, "scripts/deploy-immutable.sh"), "utf8");
  assert.match(deploy, /chown -hR root:ubuntu "\$STAGE"/);
  assert.match(deploy, /type d -exec chmod 0550/);
  assert.match(deploy, /protected release ownership is not root:ubuntu/);
  assert.match(CANONICAL_BROWSER, /browser_release_group_invalid/);
  // And the producer must not have quietly regained the gid requirement.
  assert.doesNotMatch(
    PRODUCER.slice(PRODUCER.indexOf("function requireProtectedAncestors"), PRODUCER.indexOf("function readProtectedFile")),
    /metadata\.gid !== 0/,
  );
});

// --- fixture Lead source vs the sales taxonomy -------------------------------
//
// `public.leads.source` carries `leads_source_check`, a closed set. The fixture
// wrote `postdeploy_uat`, which the set has never contained, so acceptance
// refused `fixture_seed_failed` on production. These tests bind the fixture's
// value to the constraint's own text, in both the owning migration and the
// production schema baseline, so the two cannot drift apart again.

function allowedLeadSources(sql, label) {
  const at = sql.lastIndexOf("CONSTRAINT leads_source_check");
  assert.notEqual(at, -1, `${label} does not define leads_source_check`);
  const end = sql.indexOf(";", at);
  assert.ok(end > at, `${label} has an unterminated leads_source_check statement`);
  const values = [...sql.slice(at, end).matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  assert.ok(values.length >= 5, `${label} yielded no source values: ${values.join(",")}`);
  return values;
}

function owningLeadSourceMigration() {
  const dir = path.join(ROOT, "supabase/migrations");
  const owning = readdirSync(dir)
    .filter((name) => name.endsWith(".sql") && !name.startsWith("rollback") && !name.startsWith("recontract"))
    .sort()
    .filter((name) => readFileSync(path.join(dir, name), "utf8").includes("ADD CONSTRAINT leads_source_check"))
    .at(-1);
  assert.ok(owning, "no migration adds leads_source_check");
  return { name: owning, sql: readFileSync(path.join(dir, owning), "utf8") };
}

test("the fixture Lead source is a value the live taxonomy admits", () => {
  const migration = owningLeadSourceMigration();
  const fromMigration = allowedLeadSources(migration.sql, migration.name);
  const baseline = readFileSync(path.join(ROOT, "supabase/replay/production-schema-baseline.sql"), "utf8");
  const fromBaseline = allowedLeadSources(baseline, "production-schema-baseline.sql");

  assert.ok(
    fromMigration.includes(FIXTURE_LEAD_SOURCE),
    `${migration.name} forbids the fixture source ${FIXTURE_LEAD_SOURCE}: ${fromMigration.join(",")}`,
  );
  assert.ok(
    fromBaseline.includes(FIXTURE_LEAD_SOURCE),
    `the production baseline forbids the fixture source ${FIXTURE_LEAD_SOURCE}: ${fromBaseline.join(",")}`,
  );
  // The regression that shipped: a descriptive value invented by the fixture.
  assert.doesNotMatch(FIXTURE_LEAD_SOURCE, /uat|postdeploy/);
});

test("the fixture Lead insert binds its source instead of writing a literal", () => {
  const start = PRODUCER.indexOf("insert into public.leads");
  assert.ok(start > 0, "the fixture Lead insert was not found");
  const insert = PRODUCER.slice(start, PRODUCER.indexOf("`,", start));
  assert.doesNotMatch(insert, /'[a-z_]*(uat|postdeploy)[a-z_]*'/);
  assert.equal((insert.match(/\$9/g) ?? []).length, 6, "every seeded Lead must take the bound source");
  assert.match(PRODUCER, /ids\.browserLead, FIXTURE_LEAD_SOURCE\]/);
});

test("a failed fixture seed reports the database's identifiers, never the row", () => {
  const described = describeDatabaseFailure({
    code: "23514",
    constraint: "leads_source_check",
    table: "leads",
    detail: "Failing row contains (0000, postdeploy_uat, Some Customer Name).",
    message: 'new row for relation "leads" violates check constraint "leads_source_check"',
  });
  assert.match(described, /code=23514/);
  assert.match(described, /constraint=leads_source_check/);
  assert.match(described, /table=leads/);
  assert.match(described, /leads_source_check/);
  // `detail` embeds the offending row, so it must never be printed.
  assert.doesNotMatch(described, /Failing row|Some Customer Name/);
  assert.equal(describeDatabaseFailure(undefined), "code=unknown");
  assert.equal(describeDatabaseFailure({}), "code=unknown");

  const start = PRODUCER.indexOf("async function seedFixtures");
  const seed = PRODUCER.slice(start, PRODUCER.indexOf("\nfunction ", start));
  assert.match(seed, /catch \(error\)/);
  assert.match(seed, /describeDatabaseFailure\(error\)/);
  assert.doesNotMatch(seed, /\} catch \{/);
});

/**
 * Reads one JavaScript string literal starting at `start` (which must be the
 * opening quote) and returns its raw text plus the index just past the closing
 * quote. Template literals are returned verbatim, `${...}` included: the SQL
 * this producer writes never interpolates a parameter placeholder, and the
 * parameter scan below only looks for `$<digits>`.
 */
function readLiteral(source, start) {
  const quote = source[start];
  let index = start + 1;
  let braceDepth = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (quote === "`" && character === "$" && source[index + 1] === "{") {
      braceDepth += 1;
      index += 2;
      continue;
    }
    if (braceDepth > 0) {
      if (character === "{") braceDepth += 1;
      else if (character === "}") braceDepth -= 1;
      index += 1;
      continue;
    }
    if (character === quote) return { text: source.slice(start + 1, index), end: index + 1 };
    index += 1;
  }
  throw new Error(`unterminated literal at ${start}`);
}

/**
 * Counts the top-level elements of the array literal starting at `start` (which
 * must be `[`). Nested literals, calls, and template interpolations all carry
 * commas of their own, so only commas at depth zero are separators.
 */
function countArrayElements(source, start) {
  let index = start + 1;
  let depth = 0;
  let elements = 0;
  let sawValue = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "\"" || character === "'" || character === "`") {
      index = readLiteral(source, index).end;
      sawValue = true;
      continue;
    }
    if ("([{".includes(character)) {
      depth += 1;
      sawValue = true;
      index += 1;
      continue;
    }
    if (character === ")" || character === "}") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (character === "]") {
      if (depth === 0) return { count: sawValue ? elements + 1 : elements, end: index + 1 };
      depth -= 1;
      index += 1;
      continue;
    }
    if (character === "," && depth === 0) {
      if (sawValue) elements += 1;
      sawValue = false;
      index += 1;
      continue;
    }
    if (!/\s/.test(character)) sawValue = true;
    index += 1;
  }
  throw new Error(`unterminated array literal at ${start}`);
}

function producerQueries() {
  const calls = [];
  let dynamic = 0;
  const needle = "db.query(";
  for (let at = PRODUCER.indexOf(needle); at !== -1; at = PRODUCER.indexOf(needle, at + 1)) {
    let index = at + needle.length;
    while (/\s/.test(PRODUCER[index])) index += 1;
    if (!"\"'`".includes(PRODUCER[index])) {
      dynamic += 1;
      continue;
    }
    const literal = readLiteral(PRODUCER, index);
    let cursor = literal.end;
    while (/\s/.test(PRODUCER[cursor])) cursor += 1;
    let bound = 0;
    if (PRODUCER[cursor] === ",") {
      cursor += 1;
      while (/\s/.test(PRODUCER[cursor])) cursor += 1;
      if (PRODUCER[cursor] === "[") bound = countArrayElements(PRODUCER, cursor).count;
      else if (PRODUCER[cursor] !== ")") bound = -1;
    }
    calls.push({ sql: literal.text, bound, offset: at });
  }
  return { calls, dynamic };
}

test("the scanner used below can actually see a parameter gap", () => {
  // Without this arm a broken scanner would report every producer query clean.
  const source = 'db.query(`insert into t (a, b) values ($1, $3)`, [one, two, three]);';
  const saved = PRODUCER;
  assert.equal(typeof saved, "string");
  const calls = [];
  const needle = "db.query(";
  const at = source.indexOf(needle);
  const literal = readLiteral(source, at + needle.length);
  const array = countArrayElements(source, source.indexOf("[", literal.end));
  calls.push({ used: [...new Set([...literal.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))], bound: array.count });
  assert.deepEqual(calls[0].used, [1, 3]);
  assert.equal(calls[0].bound, 3);
});

test("every producer query numbers its parameters contiguously", () => {
  const { calls, dynamic } = producerQueries();
  // A parameter PostgreSQL never sees used has no inferable type: the statement
  // fails to parse with 42P18 and not one row is written. This is exactly how
  // the contracts insert failed on production on 2026-08-20 with an unused $8.
  assert.ok(calls.length >= 12, `expected the producer's queries to be visible, saw ${calls.length}`);
  assert.equal(dynamic, 0, "a query with a non-literal SQL argument cannot be checked statically");
  for (const call of calls) {
    const used = [...new Set([...call.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
    const label = call.sql.replace(/\s+/g, " ").slice(0, 70);
    assert.notEqual(call.bound, -1, `parameter array is not a literal: ${label}`);
    assert.equal(used.length, call.bound, `bound ${call.bound} value(s) but used ${used.length}: ${label}`);
    assert.deepEqual(
      used,
      used.map((_value, position) => position + 1),
      `parameter numbering has a gap: ${label}`,
    );
  }
});

test("the contract insert binds the sales actor and never an unused admin", () => {
  const insert = PRODUCER.slice(PRODUCER.indexOf("insert into public.contracts"));
  const body = insert.slice(0, insert.indexOf("],") + 2);
  assert.doesNotMatch(body, /actorIds\.admin/);
  assert.match(body, /actorIds\.sales/);
});

// ---------------------------------------------------------------------------
// The lead -> contract flow expected a status the trigger never writes
// ---------------------------------------------------------------------------
//
// `on_lead_won()` creates a `draft` contract with a pending `admin_review` row;
// 20260812000000 §12 made that change deliberately, to stop a lead field update
// from producing a contract that had skipped both approvals. The flow demanded
// `pending_admin`, so `accept` refused with `flow_lead_to_contract_readback_failed`
// on production and said nothing further.

function owningLeadWonMigration() {
  const dir = path.join(ROOT, "supabase/migrations");
  const owning = readdirSync(dir)
    .filter((name) => name.endsWith(".sql") && !name.startsWith("rollback") && !name.startsWith("recontract"))
    .sort()
    .filter((name) => /function public\.on_lead_won/i.test(readFileSync(path.join(dir, name), "utf8")))
    .at(-1);
  assert.ok(owning, "no migration defines public.on_lead_won()");
  return { name: owning, sql: readFileSync(path.join(dir, owning), "utf8") };
}

// The contract insert inside a given on_lead_won() body: its final two literals
// are `status` and `approval_status`, in the column order the statement lists.
function leadWonContractState(sql, label) {
  const lower = sql.toLowerCase();
  // The last CREATE of the function, not the last mention of its name: the
  // migrations also revoke privileges on it below the body, and matching that
  // line puts the scan past the insert it is looking for.
  const definitions = [...lower.matchAll(/create (?:or replace )?function public\.on_lead_won/g)].map((match) => match.index);
  assert.ok(definitions.length > 0, `${label} does not define on_lead_won()`);
  const fn = definitions.at(-1);
  const candidates = ["insert into public.contracts (", "insert into contracts ("]
    .map((needle) => lower.indexOf(needle, fn))
    .filter((index) => index >= 0);
  assert.ok(candidates.length > 0, `${label} has no contract insert inside on_lead_won()`);
  const at = Math.min(...candidates);
  const end = lower.indexOf("returning", at);
  assert.ok(end > at, `${label} has an unterminated contract insert`);
  const literals = [...sql.slice(at, end).matchAll(/'([A-Za-z_][A-Za-z0-9_ ]*)'/g)].map((match) => match[1]);
  assert.ok(literals.length >= 3, `${label} yielded too few literals: ${literals.join(",")}`);
  return { status: literals.at(-2), approval_status: literals.at(-1) };
}

test("the lead-won expectation is the state the owning migration's trigger writes", () => {
  const migration = owningLeadWonMigration();
  const observed = leadWonContractState(migration.sql, migration.name);
  assert.equal(observed.status, LEAD_WON_CONTRACT_STATUS, `${migration.name} writes ${observed.status}`);
  assert.equal(observed.approval_status, LEAD_WON_CONTRACT_APPROVAL_STATUS);

  // The approval row the same trigger inserts, which is where the pending
  // admin step actually lives.
  const approvalInsert = migration.sql.slice(migration.sql.lastIndexOf("insert into public.contract_approvals"));
  assert.match(approvalInsert.slice(0, 400), new RegExp(`'${LEAD_WON_APPROVAL_STEP}'`));
  assert.match(approvalInsert.slice(0, 400), new RegExp(`'${LEAD_WON_APPROVAL_STATUS}'`));

  // Not copied from the pre-migration schema: the baseline still writes the
  // status this migration removed, so a constant tracking the baseline would
  // fail here.
  const baseline = readFileSync(path.join(ROOT, "supabase/replay/production-schema-baseline.sql"), "utf8");
  assert.equal(leadWonContractState(baseline, "production-schema-baseline.sql").status, "active");
  assert.notEqual(LEAD_WON_CONTRACT_STATUS, "active");

  // The regression that shipped: a status no code on this path ever writes.
  assert.notEqual(LEAD_WON_CONTRACT_STATUS, "pending_admin");
  const flow = PRODUCER.slice(PRODUCER.indexOf('flow("lead_to_contract"'), PRODUCER.indexOf('flow("contract_status_transition"'));
  assert.doesNotMatch(flow, /pending_admin/);
});

test("the lead-won readback names each unmet expectation instead of one opaque code", () => {
  const won = { stage: "won", final_status: "won" };
  const contract = { id: "c", status: LEAD_WON_CONTRACT_STATUS, approval_status: LEAD_WON_CONTRACT_APPROVAL_STATUS };
  const approvals = [{ step: LEAD_WON_APPROVAL_STEP, status: LEAD_WON_APPROVAL_STATUS }];

  assert.deepEqual(
    leadWonUnmetExpectations({ leadRows: [won], contractRows: [contract], approvalRows: approvals }),
    [],
    "the state the production trigger produces must satisfy the flow",
  );

  // Positive control 1: the pre-migration behaviour this expectation exists to
  // catch. Without it, an always-empty implementation would pass.
  const preMigration = leadWonUnmetExpectations({
    leadRows: [won],
    contractRows: [{ ...contract, status: "active" }],
    approvalRows: approvals,
  });
  assert.equal(preMigration.length, 1);
  assert.match(preMigration[0], /contracts\.status=active expected=draft/);

  // Positive control 2: the approval row missing -- the half of the behaviour
  // change the old assertion never looked at.
  const noApproval = leadWonUnmetExpectations({ leadRows: [won], contractRows: [contract], approvalRows: [] });
  assert.equal(noApproval.length, 1);
  assert.match(noApproval[0], /contract_approvals admin_review\/pending rows=0 expected=1/);
  assert.match(noApproval[0], /observed=none/);

  // Positive control 3: a lead the request never moved.
  const notWon = leadWonUnmetExpectations({
    leadRows: [{ stage: "pending_decision", final_status: null }],
    contractRows: [],
    approvalRows: [],
  });
  assert.match(notWon.join("; "), /leads\.stage=pending_decision expected=won/);
  assert.match(notWon.join("; "), /leads\.final_status=<null> expected=won/);
  assert.match(notWon.join("; "), /contracts rows=0 expected=1/);
});

test("the lead-won diagnostic prints taxonomy values and redacts everything else", () => {
  assert.equal(taxonomyValue("pending_admin"), "pending_admin");
  assert.equal(taxonomyValue(null), "<null>");
  assert.equal(taxonomyValue(undefined), "<null>");
  assert.equal(taxonomyValue(3), "3");
  // These rows also carry customer names and free-text notes; a diagnostic that
  // could print them would be unusable in a deploy log.
  assert.equal(taxonomyValue("Fahad Al Mansoori"), "<not-a-taxonomy-value>");
  assert.equal(taxonomyValue("+971 50 123 4567"), "<not-a-taxonomy-value>");
  assert.equal(taxonomyValue({ id: 1 }), "<not-a-taxonomy-value>");
});

test("the admin_review assertion reads the approval table it claims to verify", () => {
  const flow = PRODUCER.slice(PRODUCER.indexOf('flow("lead_to_contract"'), PRODUCER.indexOf('flow("contract_status_transition"'));
  assert.match(flow, /from public\.contract_approvals/);
  assert.match(flow, /admin_review_pending: approval\.rows/);
  // It used to re-read the contract rows, so the pending approval row was never
  // part of the evidence the assertion digested.
  assert.doesNotMatch(flow, /admin_review_pending: contract\.rows/);
});
