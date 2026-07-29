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
  assert.match(
    control,
    /build\|deploy\|uat\|uat-sam20\|rollback\) ;;/,
  );
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
    /--read-only/,
    /--env-file "\$ENV_FILE"/,
    /SAM26_EXPECTED_RELEASE_SHA=\$SHA/,
    /SAM26_RELEASE_MANIFEST=\/runner\/release\/manifest\.json/,
  ]) assert.match(control, pattern);
  assert.doesNotMatch(control, /docker\.sock/);
  assert.doesNotMatch(control, new RegExp(`--env[^\\n]*${"SUPABASE_SERVICE_ROLE_KEY"}=`));
});

test("SAM-20 UAT uses the current release, fixed runner, local manifest, and zero cleanup", async () => {
  const control = await read("scripts/newme-staging-control.sh");
  for (const pattern of [
    /verify_current_release "\$SHA"/,
    /SAM20_RUNNER="scripts\/uat\/sam20-lead-organization-isolation\.mjs"/,
    /copy_commit_blob "\$SHA" "\$SAM20_RUNNER" "\$runner"/,
    /SAM20_RELEASE_MANIFEST="\$RELEASES\/\$SHA\/manifest\.json"/,
    /SAM20_UAT_CONFIRM="SAM20_STAGING_ONLY"/,
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
    "profiles",
    "auth_fixtures",
  ]) assert.ok(control.includes(`"${fixture}"`));
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
