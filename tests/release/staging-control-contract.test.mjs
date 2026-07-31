import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const run = promisify(execFile);
const bash = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "bash";
const controller = fileURLToPath(
  new URL("scripts/newme-staging-control.sh", root),
);

test("staging controller has one fixed command surface and strict SHA arity", async () => {
  const control = await read("scripts/newme-staging-control.sh");
  assert.match(control, /\[ "\$#" -eq 2 \] \|\| usage/);
  assert.match(control, /\[\[ "\$SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\] \|\| usage/);
  for (const action of [
    "build",
    "deploy",
    "uat",
    "uat-sam20",
    "uat-sam22",
    "uat-sam27",
    "uat-sam52",
    "uat-sam54",
    "uat-sam68",
    "uat-sam70",
    "uat-product-saas",
    "rollback",
  ]) assert.ok(control.includes(action), `missing fixed controller action ${action}`);
  assert.doesNotMatch(control, /\beval\b/);
});

test("staging controller rejects missing, extra, unknown, and malformed arguments", async () => {
  const invalidArguments = [
    [],
    ["build"],
    ["unknown", "a".repeat(40)],
    ["build", "a".repeat(39)],
    ["build", "a".repeat(40), "extra"],
  ];
  for (const args of invalidArguments) {
    await assert.rejects(
      run(bash, [controller, ...args]),
      (error) => error.code === 64 && /usage: newme-staging-control/.test(error.stderr),
    );
  }
});

test("staging controller is root-only, single-lock, and canonical-blob bound", async () => {
  const control = await read("scripts/newme-staging-control.sh");
  for (const pattern of [
    /\[ "\$\(id -u\)" -eq 0 \]/,
    /LOCK="\/run\/lock\/newme-staging-control\.lock"/,
    /flock -n 9/,
    /refs\/remotes\/origin\/\$BRANCH/,
    /target SHA must equal the canonical staging head/,
    /git hash-object "\$SELF"/,
    /\$CANONICAL_SHA:\$SELF_SOURCE/,
    /installed controller blob does not match canonical staging head/,
  ]) assert.match(control, pattern);
  assert.match(control, /readonly BRANCH="agent\/saas-staging-isolation"/);
  assert.doesNotMatch(control, /NEWME_STAGING_BRANCH/);
});

test("build and deploy use fixed systemd units and immutable state", async () => {
  const [control, install] = await Promise.all([
    read("scripts/newme-staging-control.sh"),
    read("scripts/install-staging-assets.sh"),
  ]);
  assert.match(control, /newme-staging-build@\$SHA\.service/);
  assert.match(control, /newme-staging-deploy@\$SHA\.service/);
  assert.match(control, /systemctl start "\$unit"/);
  assert.match(control, /STATE_FILE="\$STATE_DIR\/last-deploy\.state"/);
  assert.match(control, /mktemp "\$STATE_DIR\/\.last-deploy\.XXXXXX"/);
  assert.match(control, /chmod 0600 "\$temporary"/);
  assert.match(control, /mv -f "\$temporary" "\$STATE_FILE"/);
  assert.match(install, /install -d -m 0700 -o root -g root \/var\/lib\/newme-staging-control/);
  assert.match(
    install,
    /install -m 0755 -o root -g root "\$ROOT\/scripts\/newme-staging-control\.sh" \/usr\/local\/sbin\/newme-staging-control/,
  );
});

test("SAM-26 UAT image and runtime remain SHA-bound and disposable", async () => {
  const control = await read("scripts/newme-staging-control.sh");
  for (const pattern of [
    /copy_commit_blob "\$SHA" "infra\/staging\/uat-runner\/Dockerfile"/,
    /org\.opencontainers\.image\.revision=\$SHA/,
    /--rm/,
    /--init/,
    /--ipc=host/,
    /--network host/,
    /--add-host staging\.newme\.ae:127\.0\.0\.1/,
    /--read-only/,
    /--env-file "\$ENV_FILE"/,
    /SAM_UAT_SUITE=sam26/,
    /SAM26_EXPECTED_RELEASE_SHA=\$SHA/,
    /SAM26_RELEASE_MANIFEST=\/runner\/release\/manifest\.json/,
  ]) assert.match(control, pattern);
  assert.equal((control.match(/--network host/g) ?? []).length, 5);
  assert.equal(
    (control.match(/--add-host staging\.newme\.ae:127\.0\.0\.1/g) ?? []).length,
    3,
  );
  assert.doesNotMatch(control, /docker\.sock/);
  assert.doesNotMatch(control, new RegExp(`--env[^\\n]*${"SUPABASE_SERVICE_ROLE_KEY"}=`));
});

test("SAM-20 UAT uses the current release, fixed runner, local manifest, and zero cleanup", async () => {
  const control = await read("scripts/newme-staging-control.sh");
  for (const pattern of [
    /verify_current_release "\$SHA"/,
    /SAM20_RUNNER="scripts\/uat\/sam20-lead-organization-isolation\.mjs"/,
    /boundedReasonAndExpiry !== 1/,
    /companyAdminDeniedPlatformRole !== 2/,
    /startAudit !== 1/,
    /objectAudit !== 1/,
    /endAudit !== 1/,
    /endedSessionDenied !== 1/,
    /copy_commit_blob "\$SHA" "\$SAM20_RUNNER" "\$runner"/,
    /docker image inspect "\$UAT_IMAGE_PREFIX:\$SHA"/,
    /--env "SAM20_UAT_BASE_URL=http:\/\/127\.0\.0\.1:3101"/,
    /--env "SAM20_RELEASE_MANIFEST=\/runner\/release\/manifest\.json"/,
    /--env "SAM20_UAT_CONFIRM=SAM20_STAGING_ONLY"/,
    /--mount "type=bind,src=\$runner,dst=\/runner\/sam20-lead-organization-isolation\.mjs,readonly"/,
    /--mount "type=bind,src=\$RELEASES\/\$SHA\/manifest\.json,dst=\/runner\/release\/manifest\.json,readonly"/,
    /--entrypoint \/usr\/bin\/node/,
    /"\$UAT_IMAGE_PREFIX:\$SHA"/,
    /body\.linearId !== "SAM-20"/,
    /body\.releaseSha !== process\.argv\[2\]/,
    /body\.cleanup !== "verified"/,
    /body\.cleanupCounts\?\.\[key\] !== 0/,
  ]) assert.match(control, pattern);
  for (const fixture of [
    "organizations",
    "memberships",
    "leads",
    "platform_staff",
    "support_sessions",
    "audit_events",
    "user_session_daily",
    "audit_logs",
    "profiles",
    "auth_fixtures",
  ]) assert.ok(control.includes(`"${fixture}"`));
  assert.doesNotMatch(control, /RELEASES\/\$SHA\/node_modules/);
  assert.doesNotMatch(control, /ln -s .*node_modules/);
  assert.doesNotMatch(control, /cat "\$ENV_FILE"/);
  assert.doesNotMatch(control, /cat "\$output"/);
});

test("SAM-22 UAT is SHA-bound, complete, and proves zero fixture residue", async () => {
  const control = await read("scripts/newme-staging-control.sh");
  for (const pattern of [
    /SAM22_RUNNER="scripts\/uat\/sam22-two-organization-isolation\.mjs"/,
    /copy_commit_blob "\$SHA" "\$SAM22_RUNNER" "\$runner"/,
    /verify_current_release "\$SHA"/,
    /SAM22_UAT_BASE_URL=http:\/\/127\.0\.0\.1:3101/,
    /SAM22_RELEASE_SHA=\$SHA/,
    /SAM22_UAT_CONFIRM=SAM22_STAGING_ONLY/,
    /src=\$runner,dst=\/runner\/sam22-two-organization-isolation\.mjs,readonly/,
    /src=\$RELEASES\/\$SHA\/manifest\.json,dst=\/runner\/release\/manifest\.json,readonly/,
    /body\.linearId !== "SAM-22"/,
    /body\.releaseSha !== process\.argv\[2\]/,
    /body\.projectRef !== process\.argv\[3\]/,
    /body\.cleanup !== "verified"/,
    /resultNames\.some\(\(key\) => body\.results\?\.\[key\] === undefined\)/,
    /body\.cleanupCounts\?\.\[key\] !== 0/,
    /uat-sam22\) run_uat_sam22/,
  ]) assert.match(control, pattern);
  for (const result of [
    "list_search",
    "direct_id",
    "export",
    "import",
    "webhook",
    "cron",
    "dashboard",
    "member_admin",
  ]) assert.ok(control.includes(`"${result}"`));
  for (const fixture of [
    "organizations",
    "memberships",
    "leads",
    "snapshots",
    "audit_events",
    "child_records",
    "user_session_daily",
    "audit_logs",
    "profiles",
    "auth_fixtures",
  ]) assert.ok(control.includes(`"${fixture}"`));
  assert.doesNotMatch(control, /cat "\$ENV_FILE"/);
  assert.doesNotMatch(control, /cat "\$output"/);
});

test("SAM-68 UAT is SHA-bound, secret-free, auditable, and N/A-explicit", async () => {
  const control = await read("scripts/newme-staging-control.sh");
  for (const pattern of [
    /SAM68_RUNNER="scripts\/verify-staging-sam68-observability\.mjs"/,
    /copy_commit_blob "\$SHA" "\$SAM68_RUNNER" "\$runner"/,
    /verify_current_release "\$SHA"/,
    /\/usr\/bin\/env -i/,
    /SAM68_EXPECTED_RELEASE_SHA="\$SHA"/,
    /body\.linearId !== "SAM-68"/,
    /body\.releaseSha !== process\.argv\[2\]/,
    /body\.monitoring\?\.httpStatus !== 410/,
    /body\.monitoring\?\.hostileBodyPersisted !== false/,
    /body\.readiness\?\.timeoutMs !== 3000/,
    /readinessElapsed > 3000/,
    /body\.observability\?\.journald\?\.hostileMarkerMatches !== 0/,
    /body\.observability\?\.journald\?\.errorMatches !== 0/,
    /body\.observability\?\.sentry\?\.status !== "not_applicable"/,
    /body\.cleanup\?\.status !== "not_applicable"/,
    /body\.cleanup\.fixtureIds\.length !== 0/,
    /SAM68_EVIDENCE="\$STATE_DIR\/last-uat-sam68\.json"/,
    /chmod 0600 "\$output"/,
    /mv -f "\$output" "\$SAM68_EVIDENCE"/,
  ]) assert.match(control, pattern);
  assert.doesNotMatch(control, /cat "\$ENV_FILE"/);
  assert.doesNotMatch(control, /cat "\$output"/);
  assert.doesNotMatch(
    control,
    /SAM68_EXPECTED_RELEASE_SHA[^\n]*(?:SENTRY|READINESS|SUPABASE)/,
  );
});

test("SAM-27 UAT is SHA-bound, loopback-only, and preserves fail-closed evidence", async () => {
  const [control, readme] = await Promise.all([
    read("scripts/newme-staging-control.sh"),
    read("infra/staging/uat-runner/README.md"),
  ]);
  for (const pattern of [
    /SAM27_RUNNER="scripts\/verify-staging-sam27-integrations\.mjs"/,
    /SAM27_LIBRARY="src\/lib\/integration-execution\.mjs"/,
    /copy_commit_blob "\$SHA" "\$SAM27_RUNNER" "\$runner"/,
    /copy_commit_blob "\$SHA" "\$SAM27_LIBRARY" "\$library"/,
    /verify_current_release "\$SHA"/,
    /\/usr\/bin\/env -i/,
    /SAM27_EXPECTED_RELEASE_SHA="\$SHA"/,
    /body\.linearId !== "SAM-27"/,
    /body\.releaseSha !== process\.argv\[2\]/,
    /body\.target !== "staging-loopback"/,
    /body\.health\?\.responseFields, \["status"\]/,
    /disabled\?\.metaOAuthStart\?\.status !== "disabled"/,
    /disabled\?\.metaOAuthCallback\?\.status !== "disabled"/,
    /disabled\?\.metaCapi\?\.status !== "disabled"/,
    /disabled\?\.productionCallbackContacted !== false/,
    /synthetic\?\.recovered\?\.attempts !== 2/,
    /synthetic\?\.terminal\?\.finalAlerts !== 1/,
    /synthetic\?\.exhausted\?\.attempts !== 3/,
    /body\.cleanup\?\.status !== "not_applicable"/,
    /SAM27_EVIDENCE="\$STATE_DIR\/last-uat-sam27\.json"/,
    /chmod 0600 "\$output"/,
    /mv -f "\$output" "\$SAM27_EVIDENCE"/,
  ]) assert.match(control, pattern);
  assert.match(readme, /uat-sam27 <SHA>/);
  assert.match(readme, /never calls the production Meta callback/);
  assert.doesNotMatch(control, /SAM27_EXPECTED_RELEASE_SHA[^\n]*(?:META|SUPABASE)/);
  assert.doesNotMatch(control, /cat "\$ENV_FILE"/);
  assert.doesNotMatch(control, /cat "\$output"/);
});

test("SAM-54 UAT crosses the versioned alert state and captures read-only diagnostics", async () => {
  const control = await read("scripts/newme-staging-control.sh");
  for (const pattern of [
    /SAM54_RUNNER="scripts\/verify-staging-sam54-diagnostics\.mjs"/,
    /SAM54_ALERT_STATE="infra\/observability\/hermes-alert-state-v1\.sh"/,
    /copy_commit_blob "\$SHA" "\$SAM54_RUNNER" "\$runner"/,
    /copy_commit_blob "\$SHA" "\$SAM54_ALERT_STATE" "\$alert_state"/,
    /verify_current_release "\$SHA"/,
    /HERMES_ALERT_THRESHOLD="2"/,
    /HERMES_ALERT_NOTIFIER="\/usr\/bin\/true"/,
    /HERMES_ALERT_DIAGNOSTIC="\$runner"/,
    /"sam54-staging-uat" "failure" "synthetic_acceptance"/,
    /transition=below-threshold .*failure_count=1/,
    /transition=alert .*diagnostic=complete capture=1/,
    /body\.linearId !== "SAM-54"/,
    /body\.releaseSha !== process\.argv\[2\]/,
    /body\.automaticDispatch !== true/,
    /body\.trigger\?\.alertKey !== "sam54-staging-uat"/,
    /body\.checks\?\.health\?\.httpStatus !== 200/,
    /body\.checks\?\.authMe\?\.httpStatus !== 401/,
    /journal\?\.windowMinutes !== 15/,
    /disk\?\.alertThresholdPercent !== 90/,
    /disk\?\.overThreshold !== \(disk\.usedPercent >= 90\)/,
    /body\.safety\?\.mode !== "read_only"/,
    /body\.safety\?\.secretsRead !== false/,
    /body\.safety\?\.mutationAttempted !== false/,
    /SAM54_EVIDENCE="\$STATE_DIR\/last-uat-sam54\.json"/,
    /chmod 0600 "\$output"/,
    /mv -f "\$output" "\$SAM54_EVIDENCE"/,
  ]) assert.match(control, pattern);
  assert.doesNotMatch(control, /cat "\$output"/);
  assert.doesNotMatch(
    control,
    /SAM54_EXPECTED_RELEASE_SHA[^\n]*(?:SUPABASE|SENTRY|READINESS)/,
  );
});

test("SAM-70 UAT is SHA-bound, staging-only, fail-closed, and residue verified", async () => {
  const control = await read("scripts/newme-staging-control.sh");
  for (const pattern of [
    /copy_commit_blob "\$SHA" "scripts\/verify-staging-sam70-xlsx\.mjs"/,
    /verify_current_release "\$SHA"/,
    /SAM_UAT_SUITE=sam70/,
    /--network host/,
    /--add-host staging\.newme\.ae:127\.0\.0\.1/,
    /SAM70_EXPECTED_RELEASE_SHA=\$SHA/,
    /SAM70_BASE_URL=https:\/\/staging\.newme\.ae/,
    /SAM70_RELEASE_MANIFEST=\/runner\/release\/manifest\.json/,
    /SAM70_UAT_CONFIRM=SAM70_STAGING_ONLY/,
    /body\.linearId !== "SAM-70"/,
    /body\.releaseSha !== process\.argv\[2\]/,
    /body\.projectRef !== process\.argv\[3\]/,
    /body\.cleanup !== "verified"/,
    /body\.importedIds\.length !== 1/,
    /body\.cleanupCounts\?\.\[key\] !== 0/,
  ]) assert.match(control, pattern);
  for (const fixture of [
    "leads",
    "follow_up_logs",
    "quotations",
    "profiles",
    "auth_fixtures",
    "organizations",
    "memberships",
    "user_session_daily",
    "audit_logs",
  ]) assert.ok(control.includes(`"${fixture}"`));
  for (const requiredCase of [
    "unauthenticated import endpoints return 401",
    "non-management import endpoints return 403",
    "admin import succeeds with exact IDs and batch",
    "boss idempotent replay creates no duplicate",
    "requests over 5 MiB fail closed",
    "2,001 rows fail closed",
    "prototype-pollution keys fail closed",
    "normal workbook reaches authenticated preview",
    "corrupt workbook is rejected before preview",
    "workbook over 5 MiB is rejected before preview",
    "quotation export enforces ownership and management access",
  ]) assert.ok(control.includes(`"${requiredCase}"`));
  assert.doesNotMatch(control, /cat "\$ENV_FILE"/);
  assert.doesNotMatch(control, /cat "\$output"/);
});

test("Product/SaaS UAT is image-bound, staging-only, and verifies every issue and cleanup class", async () => {
  const [control, dockerfile, runScript, packageJson, lockfile, rootLockfile, readme] = await Promise.all([
    read("scripts/newme-staging-control.sh"),
    read("infra/staging/uat-runner/Dockerfile"),
    read("infra/staging/uat-runner/run.sh"),
    read("infra/staging/uat-runner/package.json"),
    read("infra/staging/uat-runner/package-lock.json"),
    read("package-lock.json"),
    read("infra/staging/uat-runner/README.md"),
  ]);
  for (const pattern of [
    /PRODUCT_SAAS_RUNNER="scripts\/uat\/product-saas-final\.mjs"/,
    /copy_commit_blob "\$SHA" "\$PRODUCT_SAAS_RUNNER"/,
    /verify_current_release "\$SHA"/,
    /SAM_UAT_SUITE=product-saas-final/,
    /--network host/,
    /--add-host staging\.newme\.ae:127\.0\.0\.1/,
    /PRODUCT_UAT_RELEASE_SHA=\$SHA/,
    /PRODUCT_UAT_BASE_URL=https:\/\/staging\.newme\.ae/,
    /PRODUCT_UAT_RELEASE_MANIFEST=\/runner\/release\/manifest\.json/,
    /PRODUCT_UAT_CONFIRM=PRODUCT_SAAS_STAGING_ONLY/,
    /body\.scope !== "product-saas-final"/,
    /body\.release\?\.project !== process\.argv\[3\]/,
    /body\.release\?\.release_sha !== process\.argv\[2\]/,
    /body\.cleanup !== "verified"/,
    /body\.results\?\.\[id\]\?\.status !== "pass"/,
    /const sam25 = body\.results\?\.\["SAM-25"\]\?\.evidence/,
    /negative\.length !== negativeCases\.size/,
    /chain\.installment_plan_ids\.length !== 1/,
    /chain\.payment_allocation_ids\.length !== 1/,
    /new Set\(negative\.map\(\(item\) => item\?\.name\)\)\.size !== negativeCases\.size/,
    /last-uat-product-saas\.json/,
    /install -m 0600 -o root -g root "\$output" "\$evidence_tmp"/,
    /body\.cleanupCounts\?\.\[key\] !== 0/,
  ]) assert.match(control, pattern);
  for (const issue of ["SAM-11", "SAM-13", "SAM-25", "SAM-35", "SAM-49", "SAM-61"]) {
    assert.ok(control.includes(`"${issue}"`));
  }
  for (const fixture of [
    "auth_users",
    "profiles",
    "organizations",
    "memberships",
    "leads",
    "audit_logs",
    "activity_logs",
    "activities",
    "user_session_daily",
    "quotations",
    "contracts",
    "payments",
    "projects",
    "installment_plans",
    "contract_approvals",
    "payment_allocations",
    "pipeline_notifications",
    "lead_children",
  ]) assert.ok(control.includes(`"${fixture}"`));
  for (const [name, status] of [
    ["hermes_unauthenticated", 401],
    ["draft_conversion", 400],
    ["finance_conversion", 403],
    ["duplicate_conversion", 400],
    ["zero_amount_payment", 400],
    ["operator_confirmation", 403],
  ]) {
    assert.ok(control.includes(`["${name}", ${status}]`));
  }

  assert.match(dockerfile, /COPY product-saas-final\.mjs \/runner\/product-saas-final\.mjs/);
  assert.match(runScript, /product-saas-final\)/);
  assert.match(runScript, /exec node \/runner\/product-saas-final\.mjs/);
  assert.match(runScript, /PRODUCT_SAAS_STAGING_ONLY/);
  assert.doesNotMatch(runScript, /uat-sam68/);

  const packageBody = JSON.parse(packageJson);
  const lockBody = JSON.parse(lockfile);
  const rootLockBody = JSON.parse(rootLockfile);
  assert.equal(packageBody.dependencies["@supabase/supabase-js"], "2.106.2");
  assert.equal(
    lockBody.packages[""].dependencies["@supabase/supabase-js"],
    "2.106.2",
  );
  assert.ok(lockBody.packages["node_modules/@supabase/supabase-js"]);
  for (const dependency of [
    "@supabase/auth-js",
    "@supabase/functions-js",
    "@supabase/phoenix",
    "@supabase/postgrest-js",
    "@supabase/realtime-js",
    "@supabase/storage-js",
    "@supabase/supabase-js",
    "iceberg-js",
    "tslib",
  ]) {
    assert.deepEqual(
      lockBody.packages[`node_modules/${dependency}`],
      rootLockBody.packages[`node_modules/${dependency}`],
      `${dependency} must match the application lockfile`,
    );
  }

  assert.match(readme, /uat-product-saas <SHA>/);
  assert.match(readme, /uat-sam54 <SHA>/);
  assert.match(readme, /uat-sam68 <SHA>/);
  assert.match(control, /uat-sam20/);
  assert.match(control, /uat-sam54/);
  assert.match(control, /uat-sam68/);
  assert.match(control, /uat-sam70/);
  assert.doesNotMatch(control, /cat "\$ENV_FILE"/);
  assert.doesNotMatch(control, /cat "\$output"/);
});

test("rollback only accepts the direct previous compatible immutable release", async () => {
  const control = await read("scripts/newme-staging-control.sh");
  for (const pattern of [
    /\[ "\$SHA" = "\$STATE_OLD_SHA" \]/,
    /rollback target is not the recorded direct previous release/,
    /\[ "\$STATE_NEW_SHA" = "\$CANONICAL_SHA" \]/,
    /verify_current_release "\$STATE_NEW_SHA"/,
    /verify_release "\$STATE_OLD_SHA"/,
    /\$STATE_NEW_SHA:\$SAM20_MIGRATION/,
    /\$STATE_OLD_SHA:\$SAM20_MIGRATION/,
    /sam20_database_contract_absent/,
    /SAM-20 database contract may still be active/,
    /mv -Tf "\$next" "\$CURRENT"/,
    /systemctl restart newme-staging\.service/,
    /the deployed release was restored/,
    /"rolled_back"/,
  ]) assert.match(control, pattern);
  assert.doesNotMatch(control, /supabase\s+(?:db|migration|link)/);
});

test("SAM-20 rollback compatibility proof is staging-only, read-only, and fail-closed", async () => {
  const control = await read("scripts/newme-staging-control.sh");
  assert.match(
    control,
    /staging_url" = "https:\/\/\$STAGING_REF\.supabase\.co"/,
  );
  assert.match(control, /staging_url" != \*"\$PRODUCTION_REF"\*/);
  assert.match(
    control,
    /env -i[\s\S]*\/usr\/bin\/node --input-type=module --env-file="\$compatibility_env"/,
  );
  assert.doesNotMatch(
    control,
    /\/usr\/bin\/node[^\n]*SUPABASE_SERVICE_ROLE_KEY=/,
  );
  assert.match(control, / >\/dev\/null 2>&1 \|\| rc=\$\?/);

  for (const table of [
    "organizations",
    "memberships",
    "platform_staff",
    "support_sessions",
    "audit_events",
  ]) {
    assert.match(
      control,
      new RegExp(`/rest/v1/${table}\\?select=id&limit=0", "PGRST205"`),
    );
  }
  assert.match(
    control,
    /\/rest\/v1\/rpc\/requested_organization_id", "PGRST202"/,
  );
  assert.match(
    control,
    /\/rest\/v1\/leads\?select=organization_id&limit=0", "PGRST204"/,
  );
  assert.match(control, /if \(response\.ok \|\| body\?\.code !== expectedCode\) process\.exit\(1\)/);
  assert.match(control, /catch \{\s*process\.exit\(1\);\s*\}/);
  assert.doesNotMatch(control, /console\.(?:log|error)/);
  assert.doesNotMatch(control, /--request\s+(?:PATCH|PUT|DELETE)/);
});
