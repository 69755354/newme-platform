import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

function extractPythonHeredoc(source, marker) {
  const normalized = source.replaceAll("\r\n", "\n");
  const markerIndex = normalized.indexOf(marker);
  assert.ok(markerIndex >= 0, `missing Python heredoc marker: ${marker}`);
  const codeStart = normalized.indexOf("\n", markerIndex) + 1;
  const codeEnd = normalized.indexOf("\nPY\n", codeStart);
  assert.ok(codeStart > 0 && codeEnd > codeStart, `unterminated Python heredoc: ${marker}`);
  return normalized.slice(codeStart, codeEnd);
}

function runEmbeddedPython(code, args) {
  return spawnSync("python3", ["-", ...args], { input: code, encoding: "utf8" });
}

test("immutable deploy seals the release tree against application-user rewrites", async () => {
  const immutableDeploy = await read("scripts/deploy-immutable.sh");

  assert.match(immutableDeploy, /deploy-immutable must run as root/);
  assert.doesNotMatch(immutableDeploy, /chown -R ubuntu:ubuntu "\$STAGE"/);
  assert.match(immutableDeploy, /chown -hR root:ubuntu "\$STAGE"/);
  assert.match(immutableDeploy, /find "\$STAGE" -xdev -type d -exec chmod 0550 \{\} \+/);
  assert.match(immutableDeploy, /find "\$STAGE" -xdev -type f -perm \/111 -exec chmod 0550 \{\} \+/);
  assert.match(immutableDeploy, /find "\$STAGE" -xdev -type f ! -perm \/111 -exec chmod 0440 \{\} \+/);
  assert.match(immutableDeploy, /release_tree_root="\$\(readlink -f -- "\$STAGE"\)"/);
  assert.match(immutableDeploy, /readlink -f -- "\$release_link"/);
  assert.match(immutableDeploy, /protected release symlink escapes the immutable tree/);
  assert.match(immutableDeploy, /! -user root -o ! -group ubuntu/);
  assert.match(immutableDeploy, /protected release ownership is not root:ubuntu/);
  assert.match(immutableDeploy, /protected release directory mode is not 0550/);
  assert.match(immutableDeploy, /protected release executable mode is not 0550/);
  assert.match(immutableDeploy, /protected release data mode is not 0440/);
});

test("production rollback controller restores app and versioned assets transactionally", async () => {
  const source = await read("infra/systemd/newme-production-rollback.sh");

  assert.match(source, /newme-production-rollback must run as root/);
  assert.match(source, /exec 9>\/run\/lock\/newme-production-release\.lock/);
  assert.match(source, /flock -n 9/);
  assert.match(source, /another production release operation is active/);
  assert.match(source, /case "\$action" in[\s\S]*status\)[\s\S]*execute\)/);
  assert.match(source, /\/opt\/newme\/current\.rollback/);
  assert.match(source, /case "\$release" in[\s\S]*\/opt\/newme\/releases\/\*/);
  assert.match(source, /\.newme-protect/);
  assert.match(source, /\.next\/BUILD_ID/);
  assert.match(source, /current and rollback are identical/);
  assert.match(source, /STATE_ROOT=\/var\/lib\/newme\/deploy-state/);
  assert.match(source, /PENDING_RECORD="\$STATE_ROOT\/production-rollback\.pending"/);
  assert.match(source, /ROLLBACK_MAP="\$STATE_ROOT\/production-rollback\.map"/);
  assert.match(source, /transaction_kind=%s[\s\S]*remove_original_on_complete=%s[\s\S]*original_current=%s[\s\S]*original_rollback=%s[\s\S]*target_release=%s[\s\S]*target_rollback=%s[\s\S]*target_asset_backup=%s[\s\S]*live_asset_backup=%s[\s\S]*state=%s/);
  assert.match(source, /prepared\|app_switched\|target_assets_restored\|complete/);
  assert.match(source, /sync -f "\$STATE_ROOT"/);
  assert.match(source, /resolve_target_asset_backup/);
  assert.match(source, /or status not in \{"awaiting_uat", "acceptance_verified", "uat_failed", "complete"\}/);
  assert.match(source, /or target\.get\("git_sha"\) != rollback\.rsplit\("\/", 1\)\[-1\]/);
  assert.match(source, /if status in \{"awaiting_uat", "acceptance_verified", "uat_failed"\}:/);
  assert.match(source, /if evidence\.get\("candidate_preexisting"\) is not False or not isinstance\(previous_rollback, dict\):/);
  assert.match(source, /previous_dir = ""\r?\nif status in \{"awaiting_uat", "acceptance_verified", "uat_failed"\}:/);
  assert.match(source, /target\.get\("asset_backup", ""\)/);
  assert.match(source, /SYSTEMD_PENDING_RECORD="\$STATE_ROOT\/systemd-assets\.pending"/);
  assert.match(source, /CREDENTIAL_TRANSITION_PENDING="\$STATE_ROOT\/credential-transition\.pending\.json"/);
  assert.match(source, /\[ -e "\$CREDENTIAL_TRANSITION_PENDING" \] \|\| \[ -L "\$CREDENTIAL_TRANSITION_PENDING" \]/);
  assert.match(source, /sudo \/usr\/local\/sbin\/newme-deploy credential-recover/);
  const actionParse = source.indexOf("action=${1:-}");
  const credentialExecuteFence = source.indexOf('if [ "$action" = execute ]; then');
  assert.ok(
    actionParse >= 0 && credentialExecuteFence > actionParse &&
      source.indexOf('if [ -e "$CREDENTIAL_TRANSITION_PENDING" ]', credentialExecuteFence) > credentialExecuteFence &&
      credentialExecuteFence < source.indexOf("load_pending_state()"),
    "credential recovery must gate the mutating execute path while status remains readable",
  );
  assert.match(source, /POSTDEPLOY_ACCEPTANCE_STATE_ROOT=\/var\/lib\/newme\/postdeploy-acceptance-state-v1/);
  assert.match(source, /POSTDEPLOY_ACCEPTANCE_RUNNER=scripts\/run-postdeploy-acceptance\.mjs/);
  assert.match(source, /CANONICAL_RELEASE_MIRROR=\/opt\/newme\/repository\.git/);
  assert.match(source, /select_postdeploy_operations_runner\(\)/);
  assert.match(source, /\/opt\/newme\/current \/opt\/newme\/current\.rollback/);
  assert.match(source, /git --git-dir="\$CANONICAL_RELEASE_MIRROR" show[\s\S]*"\$release_sha:\$POSTDEPLOY_ACCEPTANCE_RUNNER"/);
  assert.match(source, /\/usr\/bin\/node "\$POSTDEPLOY_OPERATIONS_RUNNER" --assert-operations-clear >\/dev\/null/);
  assert.match(source, /run canonical newme-deploy accept-recover and accept-abort/);
  const acceptanceGuard = source.indexOf("require_postdeploy_operations_clear || exit 75");
  assert.ok(
    acceptanceGuard > actionParse && acceptanceGuard < source.indexOf('case "$action" in'),
    "postdeploy recovery must block execute after parsing the read-only status action",
  );
  assert.ok(
    source.indexOf('if [ -e "$CREDENTIAL_TRANSITION_PENDING" ]', credentialExecuteFence) < acceptanceGuard,
    "credential recovery remains the first pending-state interlock",
  );
  assert.match(source, /pending_lines="\$\(wc -l < "\$SYSTEMD_PENDING_RECORD"\)"[\s\S]*?case "\$pending_lines" in[\s\S]*?5\) ;;[\s\S]*?8\)[\s\S]*?protected_before_candidate_sha[\s\S]*?protected_before_marker_sha256/);
  assert.match(source, /load_unresolved_deploy_target/);
  assert.match(source, /candidate_preexisting=0/);
  assert.match(source, /remove_interrupted_candidate_release/);
  assert.match(source, /clear_matching_systemd_pending/);
  assert.match(source, /recover_preswitch_deploy/);
  assert.match(source, /recovered interrupted deployment before application switch/);
  assert.match(source, /transaction_kind=deploy_recovery\r?\n\s*remove_original_on_complete=1\r?\n\s*target_release="\$SYSTEMD_PENDING_PREVIOUS"\r?\n\s*target_rollback="\$SYSTEMD_PENDING_PREVIOUS_ROLLBACK"/);
  assert.match(source, /awaiting_uat\|acceptance_verified\|uat_failed\)\r?\n\s*transaction_kind=release_recovery\r?\n\s*remove_original_on_complete=1\r?\n\s*target_rollback="\$RESOLVED_PREVIOUS_ROLLBACK"/);
  assert.match(source, /case "\$PENDING_TRANSACTION_KIND:\$PENDING_REMOVE_ORIGINAL_ON_COMPLETE" in[\s\S]*rollback:0\|deploy_recovery:1\|release_recovery:1/);
  assert.match(source, /PENDING_TRANSACTION_KIND="\$transaction_kind"[\s\S]*PENDING_REMOVE_ORIGINAL_ON_COMPLETE="\$remove_original_on_complete"[\s\S]*PENDING_TARGET_ROLLBACK="\$target_rollback"/);
  assert.match(source, /switch_release_links "\$target_release" "\$target_rollback"/);
  assert.match(source, /rollback_link_matches "\$PENDING_TARGET_ROLLBACK"/);
  assert.match(source, /PENDING_TRANSACTION_KIND" = deploy_recovery[\s\S]*PENDING_STATE" = complete[\s\S]*kill may interrupt recursive removal[\s\S]*load_systemd_pending/);
  assert.match(source, /deploy_recovery\)[\s\S]*clear_matching_systemd_pending[\s\S]*;;/);
  assert.match(source, /release_recovery\)[\s\S]*remove_interrupted_candidate_release "\$PENDING_ORIGINAL_CURRENT"[\s\S]*;;/);
  const finalizeStart = source.indexOf("finalize_completed_transaction() {");
  const finalizeEnd = source.indexOf("\n}\n\nrollback_cleanup()", finalizeStart);
  assert.ok(finalizeStart >= 0 && finalizeEnd > finalizeStart);
  const finalizeBody = source.slice(finalizeStart, finalizeEnd);
  const normalFinalize = finalizeBody.indexOf("rollback)");
  const recoveryFinalize = finalizeBody.indexOf("deploy_recovery)");
  const reverseMapWrite = finalizeBody.indexOf("write_reverse_map");
  assert.ok(normalFinalize >= 0 && reverseMapWrite > normalFinalize && recoveryFinalize > reverseMapWrite);
  assert.doesNotMatch(finalizeBody.slice(recoveryFinalize), /write_reverse_map/);
  assert.match(source, /PENDING_TARGET_RELEASE/);
  assert.match(source, /NEWME_ASSET_SNAPSHOT_RECORD="\$SNAPSHOT_RECORD"/);
  assert.match(source, /NEWME_ASSET_SOURCE_ROOT="\$current" bash "\$ASSET_SNAPSHOT_HELPER" snapshot/);
  assert.match(source, /bash "\$ASSET_ROLLBACK_HELPER" "\$target_asset_backup"/);
  // The helper refuses to restore while a versioned asset record is unresolved unless
  // the caller declares recovery. Both sanctioned exits must declare it, or they are
  // unreachable -- which is exactly how the pre-switch recovery path once bricked a
  // stuck production deployment.
  assert.match(source, /NEWME_VERSIONED_ASSET_RECOVERY=1 bash "\$ASSET_ROLLBACK_HELPER" "\$expected_backup"/);
  assert.match(source, /NEWME_VERSIONED_ASSET_RECOVERY="\$asset_recovery" bash "\$ASSET_ROLLBACK_HELPER" "\$target_asset_backup"/);
  // ...and the declaration stays conditional on the record naming that same backup,
  // so an ordinary rollback never runs with the guard disarmed.
  assert.match(source, /grep -Fxc "backup=\$target_asset_backup" "\$SYSTEMD_PENDING_RECORD"/);
  assert.match(source, /asset_recovery=0/);
  assert.doesNotMatch(source, /NEWME_VERSIONED_ASSET_RECOVERY=1 bash "\$ASSET_ROLLBACK_HELPER" "\$PENDING_LIVE_ASSET_BACKUP"/);
  assert.match(source, /bash "\$ASSET_ROLLBACK_HELPER" "\$PENDING_LIVE_ASSET_BACKUP"/);
  assert.match(source, /restore_original_transaction/);
  assert.match(source, /finalize_completed_transaction/);
  assert.match(source, /trap rollback_cleanup EXIT/);
  assert.match(source, /trap 'exit 129' HUP/);
  assert.match(source, /trap 'exit 130' INT/);
  assert.match(source, /trap 'exit 143' TERM/);
  assert.ok((source.match(/mv -Tf/g) ?? []).length >= 2);
  assert.match(source, /safe_reason=\$\{reason\/\/\[\^A-Za-z0-9\._:/);
  assert.match(source, /newme-service-control restart "production-rollback:\$safe_reason"/);
  assert.match(source, /automatic-rollback-recovery:candidate-verification-failed/);
  assert.match(source, /"\$health" = 200/);
  assert.match(source, /"\$auth" = 401/);
  assert.match(source, /systemctl is-active newme-platform\.service/);
  assert.match(source, /SYSLOG_IDENTIFIER=newme-production-rollback/);
  const statusStart = source.indexOf("  status)");
  const statusEnd = source.indexOf("\n    ;;\n  execute)", statusStart);
  assert.ok(statusStart >= 0 && statusEnd > statusStart);
  const statusBody = source.slice(statusStart, statusEnd).replaceAll("\r\n", "\n");
  assert.match(statusBody, /systemd_asset_transaction=none\n    if \[ -e "\$SYSTEMD_PENDING_RECORD" \] \|\| \[ -L "\$SYSTEMD_PENDING_RECORD" \]; then/);
  assert.match(statusBody, /if ! load_systemd_pending; then\n        systemd_asset_transaction=invalid\n      elif \[ "\$current" = "\/opt\/newme\/releases\/\$SYSTEMD_PENDING_SHA" \]; then\n        systemd_asset_transaction=candidate_active\n      elif \[ "\$current" = "\$SYSTEMD_PENDING_PREVIOUS" \]; then\n        systemd_asset_transaction=pre_switch\n      else\n        systemd_asset_transaction=mismatch/);
  assert.match(
    statusBody,
    /rollback_transaction=%s\\nsystemd_asset_transaction=%s\\ncredential_asset_transaction=%s\\ncredential_transition_transaction=%s\\ncredential_adopt_transaction=%s\\nrollback_db_phase=%s/,
  );
  assert.match(statusBody, /credential_asset_transaction=recovery_required/);
  assert.match(statusBody, /credential_transition_transaction=recovery_required/);
  assert.match(source, /receipt-key-inspect\)[\s\S]*\[ "\$#" -eq 1 \]/);
  assert.match(source, /require_canonical_installed_credential_attestor \|\|/);
  assert.match(source, /refs\/remotes\/origin\/main/);
  assert.match(source, /show "\$candidate_sha:scripts\/credential-live-attestation\.mjs"/);
  assert.match(source, /show "\$candidate_sha:infra\/release\/credential-live-attestation-policy-v1\.json"/);
  assert.match(source, /\/usr\/bin\/node "\$CREDENTIAL_LIVE_HELPER" inspect-receipt-key/);

  assert.doesNotMatch(source, /systemctl\s+(?:restart|start|stop)/);
  assert.doesNotMatch(source, /\$(?:current|PENDING_ORIGINAL_CURRENT)\/scripts\/(?:install|rollback)-systemd-assets\.sh/);
  assert.deepEqual(source.match(/rm -rf[^\n]*/g), ['rm -rf --one-file-system -- "$candidate" || return 1']);
  assert.doesNotMatch(source, /eval\s|source\s+.*\.env|cat\s+.*\.env/);
  assert.doesNotMatch(source, /SUPABASE|SERVICE_ROLE|READINESS_TOKEN/);
});

test("production rollback status remains readable while unresolved fixtures block execute", async () => {
  const source = await read("infra/systemd/newme-production-rollback.sh");
  const guardFunction = source.slice(
    source.indexOf("require_postdeploy_operations_clear() {"),
    source.indexOf("\n}\n", source.indexOf("require_postdeploy_operations_clear() {")) + 3,
  );
  assert.match(
    guardFunction,
    /\[ ! -e "\$POSTDEPLOY_ACCEPTANCE_STATE_ROOT" \] && \[ ! -L "\$POSTDEPLOY_ACCEPTANCE_STATE_ROOT" \]/,
    "a symlinked state root must not be treated as absent",
  );
  assert.match(guardFunction, /select_postdeploy_operations_runner \|\|/);
  assert.match(guardFunction, /--assert-operations-clear/);
  assert.match(guardFunction, /accept-recover and accept-abort/);
  const gate = source.indexOf("require_postdeploy_operations_clear || exit 75");
  const actionParse = source.indexOf("action=${1:-}");
  const executeFence = source.lastIndexOf('if [ "$action" = execute ]; then', gate);
  const actionCase = source.indexOf("case \"$action\" in");
  assert.ok(actionParse >= 0 && executeFence > actionParse && gate > executeFence && gate < actionCase);
  assert.doesNotMatch(source.slice(executeFence, actionCase), /\|\| true|continue-on-error/);
});

test("rollback evidence parsing keeps previous rollback mandatory only for recovery states", async () => {
  const source = await read("infra/systemd/newme-production-rollback.sh");
  const code = extractPythonHeredoc(
    source,
    'metadata="$(python3 - "${evidence_files[0]}" "$current" "$rollback" <<\'PY\'',
  );
  const directory = await mkdtemp(join(tmpdir(), "newme-rollback-evidence-"));
  const evidencePath = join(directory, "deploy.json");
  const currentSha = "a".repeat(40);
  const rollbackSha = "b".repeat(40);
  const previousSha = "c".repeat(40);
  const current = `/opt/newme/releases/${currentSha}`;
  const rollback = `/opt/newme/releases/${rollbackSha}`;
  const common = {
    git_sha: currentSha,
    rollback: {
      git_sha: rollbackSha,
      backup_dir: rollback,
      asset_backup: "/var/backups/newme-systemd-assets/test",
    },
  };

  try {
    await writeFile(evidencePath, JSON.stringify({
      ...common,
      release_status: "complete",
      candidate_preexisting: true,
      rollback: { ...common.rollback, previous_rollback: "already-pruned" },
    }));
    const completed = runEmbeddedPython(code, [evidencePath, current, rollback]);
    assert.equal(completed.status, 0, completed.stderr);
    assert.match(completed.stdout, /^complete\t\/var\/backups\/newme-systemd-assets\/test\t-\s*$/);

    const recoveryEvidence = {
      ...common,
      release_status: "awaiting_uat",
      candidate_preexisting: false,
      rollback: {
        ...common.rollback,
        previous_rollback: {
          git_sha: previousSha,
          backup_dir: `/opt/newme/releases/${previousSha}`,
        },
      },
    };
    await writeFile(evidencePath, JSON.stringify(recoveryEvidence));
    const awaiting = runEmbeddedPython(code, [evidencePath, current, rollback]);
    assert.equal(awaiting.status, 0, awaiting.stderr);
    assert.match(awaiting.stdout, /^awaiting_uat\t.*\t\/opt\/newme\/releases\/[c]{40}\s*$/);

    await writeFile(evidencePath, JSON.stringify({ ...recoveryEvidence, release_status: "acceptance_verified" }));
    const accepted = runEmbeddedPython(code, [evidencePath, current, rollback]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /^acceptance_verified\t.*\t\/opt\/newme\/releases\/[c]{40}\s*$/);

    await writeFile(evidencePath, JSON.stringify({ ...recoveryEvidence, release_status: "uat_failed" }));
    const failedUat = runEmbeddedPython(code, [evidencePath, current, rollback]);
    assert.equal(failedUat.status, 0, failedUat.stderr);
    assert.match(failedUat.stdout, /^uat_failed\t.*\t\/opt\/newme\/releases\/[c]{40}\s*$/);

    await writeFile(evidencePath, JSON.stringify({ ...recoveryEvidence, candidate_preexisting: true }));
    assert.notEqual(runEmbeddedPython(code, [evidencePath, current, rollback]).status, 0);

    await writeFile(evidencePath, JSON.stringify({
      ...recoveryEvidence,
      release_status: "uat_failed",
      rollback: {
        ...recoveryEvidence.rollback,
        previous_rollback: { git_sha: previousSha, backup_dir: `/opt/newme/releases/${"d".repeat(40)}` },
      },
    }));
    assert.notEqual(runEmbeddedPython(code, [evidencePath, current, rollback]).status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical chaining gate admits only post-switch contract operations before release completion", async () => {
  const source = await read("infra/systemd/newme-deploy.sh");
  const code = extractPythonHeredoc(
    source,
    'python3 - "${CURRENT_EVIDENCE_FILES[0]}" "$ROLLBACK_SHA" "$SHA" "$DB_TRANSITION_ONLY" "$DB_TRANSITION_OPERATION" <<\'PY\'',
  );
  const directory = await mkdtemp(join(tmpdir(), "newme-deploy-chain-"));
  const evidencePath = join(directory, "deploy.json");
  const sha = "e".repeat(40);

  try {
    for (const [releaseStatus, expectedStatus] of [["complete", 0], ["awaiting_uat", 65], ["acceptance_verified", 65], ["uat_failed", 65]]) {
      await writeFile(evidencePath, JSON.stringify({ git_sha: sha, release_status: releaseStatus }));
      assert.equal(runEmbeddedPython(code, [evidencePath, sha, "f".repeat(40), "0", ""]).status, expectedStatus, `deploy:${releaseStatus}`);
    }
    for (const operation of ["contract-apply", "contract-verify", "contract-rollback", "contract-reenter"]) {
      for (const [releaseStatus, expectedStatus] of [["complete", 0], ["awaiting_uat", 0], ["acceptance_verified", 0], ["uat_failed", 65]]) {
        await writeFile(evidencePath, JSON.stringify({ git_sha: sha, release_status: releaseStatus }));
        assert.equal(
          runEmbeddedPython(code, [evidencePath, sha, sha, "1", operation]).status,
          expectedStatus,
          `${operation}:${releaseStatus}`,
        );
      }
    }
    for (const operation of ["expand-plan", "expand-apply"]) {
      await writeFile(evidencePath, JSON.stringify({ git_sha: sha, release_status: "awaiting_uat" }));
      assert.equal(runEmbeddedPython(code, [evidencePath, sha, "f".repeat(40), "1", operation]).status, 65, operation);
      await writeFile(evidencePath, JSON.stringify({ git_sha: sha, release_status: "complete" }));
      assert.equal(
        runEmbeddedPython(code, [evidencePath, sha, "f".repeat(40), "1", operation]).status,
        0,
        `${operation}:live-complete-candidate-main`,
      );
    }
    await writeFile(evidencePath, JSON.stringify({ git_sha: sha, release_status: "awaiting_uat" }));
    assert.equal(
      runEmbeddedPython(code, [evidencePath, sha, "f".repeat(40), "1", "contract-apply"]).status,
      65,
      "post-switch contract operations must target the live deployed release SHA",
    );
    await writeFile(evidencePath, JSON.stringify({ git_sha: "f".repeat(40), release_status: "complete" }));
    assert.equal(runEmbeddedPython(code, [evidencePath, sha, sha, "1", "contract-apply"]).status, 65);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical finalize retry accepts complete evidence after its older rollback was pruned", async () => {
  const source = await read("infra/systemd/newme-deploy.sh");
  const validator = extractPythonHeredoc(
    source,
    'python3 - "$EVIDENCE_FILE" "$FINALIZE_RELEASE_SHA" "$FINALIZE_ACCEPTANCE_DIGEST" "$FINALIZE_ROLLBACK_TARGET" <<\'PY\'',
  );
  const directory = await mkdtemp(join(tmpdir(), "newme-finalize-retry-"));
  const evidencePath = join(directory, "deploy.json");
  const currentSha = "1".repeat(40);
  const rollbackSha = "2".repeat(40);
  const prunedSha = "3".repeat(40);
  const rollbackTarget = `/opt/newme/releases/${rollbackSha}`;
  const assetBackup = "/var/backups/newme-systemd-assets/test-finalize";
  const acceptanceDigest = "d".repeat(64);
  const evidence = {
    git_sha: currentSha,
    release_status: "complete",
    candidate_preexisting: false,
    acceptance: { status: "verified", bundle_sha256: acceptanceDigest },
    rollback: {
      git_sha: rollbackSha,
      backup_dir: rollbackTarget,
      asset_backup: assetBackup,
      previous_rollback: {
        git_sha: prunedSha,
        backup_dir: `/opt/newme/releases/${prunedSha}`,
      },
    },
  };
  const fakeFilesystem = `
import os
_real_stat = os.stat
_asset = ${JSON.stringify(assetBackup)}
_normalize = lambda path: path.replace("\\\\", "/")
os.path.realpath = lambda path: _normalize(path)
os.path.isdir = lambda path: True if _normalize(path) in {_asset, _asset + "/rootfs"} else False
os.path.isfile = lambda path: True if _normalize(path).startswith(_asset + "/") else False
os.path.islink = lambda path: False
class _AssetMetadata:
    st_uid = 0
    st_gid = 0
    st_mode = 0o40700
os.stat = lambda path: _AssetMetadata() if path == _asset else _real_stat(path)
`;

  try {
    await writeFile(evidencePath, JSON.stringify(evidence));
    const retry = runEmbeddedPython(fakeFilesystem + validator, [
      evidencePath,
      currentSha,
      acceptanceDigest,
      rollbackTarget,
    ]);
    assert.equal(retry.status, 0, retry.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production deploy and sudo policy require the versioned rollback boundary", async () => {
  const [deploy, immutableDeploy, rollback, sudoers, installer, assetRollback, finalizer, hostLoadHelper] = await Promise.all([
    read("infra/systemd/newme-deploy.sh"),
    read("scripts/deploy-immutable.sh"),
    read("infra/systemd/newme-production-rollback.sh"),
    read("infra/sudoers/newme-platform"),
    read("scripts/install-systemd-assets.sh"),
    read("scripts/rollback-systemd-assets.sh"),
    read("scripts/finalize-deploy-evidence.sh"),
    read("scripts/wait-for-host-load.sh"),
  ]);

  assert.match(deploy, /manual production deployment is disabled/);
  assert.match(deploy, /LEGACY_EVIDENCELESS_BASELINE="945d1b5e0615c963c19e116483fcc8c4253d03ea"/);
  assert.match(deploy, /current release must have exactly one finalized deployment evidence file before another deployment/);
  assert.match(deploy, /if evidence\.get\("git_sha"\) != expected_sha:/);
  assert.match(deploy, /operation in \{[\s\S]*"contract-apply",[\s\S]*"contract-verify",[\s\S]*"contract-rollback",[\s\S]*"contract-reenter",[\s\S]*\}/);
  assert.match(deploy, /release_status not in \{"awaiting_uat", "acceptance_verified", "complete"\}/);
  assert.match(deploy, /exec 9>\/run\/lock\/newme-production-release\.lock/);
  assert.match(deploy, /flock -n 9/);
  assert.match(deploy, /another production release operation is active/);
  assert.match(deploy, /unresolved production rollback must be recovered before deployment/);
  assert.match(deploy, /pending_lines="\$\(wc -l < "\$PENDING_ASSET_RECORD"\)"[\s\S]*?case "\$pending_lines" in[\s\S]*?5\) ;;[\s\S]*?8\)[\s\S]*?protected_before_candidate_sha[\s\S]*?protected_before_marker_sha256/);
  assert.match(deploy, /candidate_preexisting=0/);
  const releaseLock = "exec 9>/run/lock/newme-production-release.lock";
  assert.equal([deploy, rollback].filter((source) => source.includes(releaseLock)).length, 2);
  assert.match(deploy, /run\.get\("head_sha"\) != expected_sha/);
  // The workflow name, event and branch now come from the required-jobs manifest
  // read out of the mirror at the SHA being deployed, so they are versioned with
  // the release instead of hardcoded here. What the manifest requires, and that
  // every job in it concluded success, is executed in
  // tests/release/deploy-release-claim-validation.test.mjs.
  assert.match(deploy, /run\.get\("name"\) != manifest\.get\("workflow"\)/);
  assert.match(deploy, /run\.get\("conclusion"\) != "success"/);
  assert.match(deploy, /"\$MAIN_SHA:infra\/release\/required-jobs\.json"/);
  assert.match(deploy, /actions\/runs\/\$RUN_ID\/jobs\?per_page=100&filter=latest/);
  assert.match(deploy, /infra\/systemd\/newme-production-rollback\.sh/);
  assert.match(deploy, /main lacks the protected production rollback controller/);
  assert.match(deploy, /infra\/sudoers\/newme-platform/);
  assert.match(deploy, /scripts\/deploy-immutable\.sh/);
  assert.match(deploy, /main lacks rollback-preserving immutable deployment/);
  assert.match(deploy, /GITHUB_API_TOKEN_FILE=\/etc\/newme\/github-actions-read\.token/);
  assert.match(deploy, /\[ ! -L "\$GITHUB_API_TOKEN_FILE" \]/);
  assert.match(deploy, /stat -c '%U:%G'/);
  assert.match(deploy, /400\|600/);
  assert.match(deploy, /mktemp \/run\/newme-github-api/);
  assert.match(deploy, /chmod 0600 "\$GITHUB_CURL_CONFIG"/);
  assert.match(deploy, /--config "\$GITHUB_CURL_CONFIG"/);
  assert.match(deploy, /unset github_token/);
  assert.match(deploy, /cleanup_github_config/);
  assert.doesNotMatch(deploy, /curl[^\n]*\$github_token/);
  assert.match(deploy, /NEWME_MANUAL_VERIFICATION=0/);
  assert.match(deploy, /FINALIZE_TARGET=.*readlink -f \/opt\/newme\/current/);
  assert.match(deploy, /usage: newme-deploy <attest\|attest-recover\|attest-abort> <release-sha>/);
  assert.match(deploy, /ATTEST_BUNDLE="\$POSTDEPLOY_INTAKE_ROOT\/\$ATTEST_RELEASE_SHA\/bundle\.json"/);
  assert.match(deploy, /verify-postdeploy-acceptance\.mjs/);
  assert.match(deploy, /record-deploy-acceptance\.mjs/);
  assert.match(deploy, /finalize <release-sha> <acceptance-sha256> <closure-sha> <successful-final-run-id>/);
  assert.match(deploy, /closure SHA must equal canonical main/);
  assert.match(deploy, /final-required-jobs\.json/);
  assert.match(deploy, /status=acceptance_verified/);
  assert.doesNotMatch(deploy, /UAT_ACTOR|UAT_FIXTURE_IDS|FIXTURE_CLEANUP_STATUS|UAT_STATUS/);
  assert.match(deploy, /finalize SHA must equal the current immutable release/);
  assert.match(deploy, /current release must contain exactly one deployment evidence file/);
  assert.match(deploy, /evidence\.get\("git_sha"\) != expected_sha/);
  assert.match(deploy, /release_status not in \{"acceptance_verified", "complete"\}/);
  assert.match(deploy, /acceptance\.get\("bundle_sha256"\) != expected_digest/);
  assert.match(deploy, /if release_status != "complete" and \([\s\S]*os\.path\.isdir\(previous_rollback_dir\)/);
  assert.doesNotMatch(deploy, /manual_verified|CI_RUN_URL="manual"/);
  const finalizedCurrentGate = deploy.indexOf('if [ "$ROLLBACK_SHA" != "$LEGACY_EVIDENCELESS_BASELINE" ]; then');
  const assetInstallerCall = deploy.indexOf('bash "$WORKTREE/scripts/install-systemd-assets.sh"');
  assert.ok(finalizedCurrentGate >= 0 && assetInstallerCall > finalizedCurrentGate);
  const liveReleaseGateStart = deploy.indexOf('LIVE_RELEASE="$(readlink -f /opt/newme/current');
  const controlSourceStart = deploy.indexOf("\nservice_control_source=", liveReleaseGateStart);
  const liveReleaseGate = deploy.slice(liveReleaseGateStart, controlSourceStart).replaceAll("\r\n", "\n").trimEnd();
  assert.match(liveReleaseGate, /fi\nif \[ "\$ROLLBACK_SHA" != "\$LEGACY_EVIDENCELESS_BASELINE" \]; then/);
  assert.match(liveReleaseGate, /if evidence\.get\("git_sha"\) != expected_sha:[\s\S]*operation in \{[\s\S]*"contract-apply",[\s\S]*"contract-verify",[\s\S]*"contract-rollback",[\s\S]*"contract-reenter",[\s\S]*if transition_sha != expected_sha:[\s\S]*elif release_status != "complete":[\s\S]*PY\nfi$/);

  assert.match(immutableDeploy, /ROLLBACK=.*current\.rollback/);
  const immutableExecutableLines = immutableDeploy.split(/\r?\n/).map((line) => line.trim());
  assert.equal(immutableExecutableLines.filter((line) => line === 'exec 7>"$LOCK"').length, 1);
  assert.equal(immutableExecutableLines.filter((line) => line === "flock -n 7 || exit 75").length, 1);
  assert.doesNotMatch(immutableDeploy, /exec 9>"\$LOCK"/);
  assert.deepEqual(
    immutableExecutableLines.filter((line) => line.startsWith("setsid node ")),
    ['setsid node node_modules/next/dist/bin/next start -p 3002 9>&- 7>&- >"/tmp/newme-candidate-$ID.log" 2>&1 &'],
  );
  assert.match(immutableDeploy, /PREVIOUS_ROLLBACK/);
  assert.match(immutableDeploy, /pending_lines="\$\(wc -l < "\$PENDING_ASSET_RECORD"\)"[\s\S]*?case "\$pending_lines" in[\s\S]*?5\) ;;[\s\S]*?8\)[\s\S]*?protected_before_candidate_sha[\s\S]*?protected_before_marker_sha256/);
  assert.match(immutableDeploy, /candidate_preexisting=0/);
  assert.match(immutableDeploy, /restore_rollback_link/);
  assert.match(immutableDeploy, /ROLLBACK_CHANGED/);
  assert.match(immutableDeploy, /protected_release=true/);
  assert.match(immutableDeploy, /newme-production-rollback/);
  assert.match(immutableDeploy, /"asset_backup": os\.environ\["NEWME_ASSET_BACKUP"\]/);
  assert.match(immutableDeploy, /"candidate_preexisting": False/);
  assert.match(immutableDeploy, /"previous_rollback"/);
  assert.match(immutableDeploy, /rollback release is not protected and complete/);
  assert.match(immutableDeploy, /\[ -n "\$PREVIOUS_ROLLBACK" \] && \[ "\$old" = "\$PREVIOUS_ROLLBACK" \]/);
  assert.match(immutableDeploy, /CANDIDATE_REMOVAL_VERIFIED=0[\s\S]*rm -rf -- "\$RELEASE"[\s\S]*sync -f "\$RELEASES"[\s\S]*CANDIDATE_REMOVAL_VERIFIED=1/);
  assert.match(immutableDeploy, /ASSETS_ROLLED_BACK" -eq 0 \] && \[ "\$CANDIDATE_REMOVAL_VERIFIED" -eq 1/);
  assert.match(immutableDeploy, /sync -f "\$durable_evidence_path"/);
  assert.match(immutableDeploy, /\/usr\/local\/libexec\/newme\/newme-install-systemd-assets/);
  assert.match(immutableDeploy, /\/usr\/local\/libexec\/newme\/newme-rollback-systemd-assets/);
  const rollbackSwitch = immutableDeploy.lastIndexOf('mv -Tf "$ROLLBACK_NEXT" "$ROLLBACK"');
  const currentSwitch = immutableDeploy.lastIndexOf('mv -Tf "$CURRENT_NEXT" "$CURRENT"');
  assert.ok(rollbackSwitch >= 0 && currentSwitch > rollbackSwitch);
  const candidateStop = immutableDeploy.indexOf('stop_candidate || { fail "candidate cleanup failed"; exit 1; }');
  const hostLoadSettle = immutableDeploy.indexOf('bash "$ROOT/scripts/wait-for-host-load.sh"', candidateStop);
  const firstReleaseMutation = immutableDeploy.indexOf("printf 'protected_release=true", candidateStop);
  const postSwitchComposite = immutableDeploy.indexOf("bash /opt/hermes-scripts/observability/l0-composite-probe.sh");
  assert.ok(candidateStop >= 0 && hostLoadSettle > candidateStop);
  assert.ok(firstReleaseMutation > hostLoadSettle && postSwitchComposite > firstReleaseMutation);
  assert.match(immutableDeploy, /HOST_LOAD_SETTLE_INTERVAL_SECONDS=10[\s\S]*HOST_LOAD_SETTLE_TIMEOUT_SECONDS=120[\s\S]*HOST_LOAD_SETTLE_REQUIRED_SAMPLES=2[\s\S]*HOST_LOAD_SETTLE_THRESHOLD_PCT=90/);
  assert.match(immutableDeploy, /HOST_LOADAVG_FILE=\/proc\/loadavg[\s\S]*HOST_LOAD_READER=[\s\S]*HOST_LOAD_NPROC_BIN=\/usr\/bin\/nproc[\s\S]*HOST_LOAD_AWK_BIN=\/usr\/bin\/awk[\s\S]*HOST_LOAD_SLEEP_BIN=\/usr\/bin\/sleep/);
  assert.match(hostLoadHelper, /^#!\/usr\/bin\/env bash/);
  assert.match(hostLoadHelper, /HOST_LOAD_SETTLE_REQUIRED_SAMPLES/);
  assert.match(hostLoadHelper, /normalized load remained above/);

  assert.match(sudoers, /NEWME_PRODUCTION_RECOVERY/);
  assert.match(sudoers, /newme-production-rollback status/);
  assert.match(sudoers, /newme-production-rollback receipt-key-inspect/);
  assert.doesNotMatch(sudoers, /newme-production-rollback receipt-key-inspect \*/);
  assert.match(sudoers, /newme-production-rollback execute \*/);
  assert.match(sudoers, /journalctl -t newme-production-rollback \*/);
  assert.doesNotMatch(sudoers, /newme-service-control (?:start|stop|try-restart) \*/);

  assert.match(installer, /\/usr\/local\/sbin\/newme-production-rollback/);
  assert.match(installer, /install_control_script\(\)/);
  assert.match(installer, /mktemp "\$\{dest\}\.new\.XXXXXX"/);
  assert.match(installer, /bash -n "\$temporary"/);
  assert.match(installer, /sync -f "\$temporary"/);
  assert.match(installer, /mv -Tf "\$temporary" "\$dest"/);
  assert.match(installer, /sync -f "\$directory"/);
  assert.match(installer, /install_control_sudoers\(\)/);
  assert.match(installer, /visudo -cf "\$temporary"/);
  assert.match(installer, /test -x \/usr\/local\/sbin\/newme-production-rollback/);
  assert.match(installer, /install:0\|snapshot:1/);
  assert.match(installer, /NEWME_ASSET_SNAPSHOT_RECORD/);
  assert.match(installer, /NEWME_ASSET_SOURCE_ROOT/);
  assert.match(installer, /unresolved production rollback must be recovered before installing assets/);
  assert.match(installer, /\[ "\$MODE" = install \][\s\S]*PENDING_RECORD/);
  assert.match(installer, /sync -f "\$BACKUP"/);
  assert.match(installer, /candidate release already exists before asset installation/);
  assert.match(installer, /candidate_preexisting=0/);
  assert.match(installer, /line_count="\$\(wc -l < "\$record"\)"[\s\S]*?case "\$line_count" in[\s\S]*?5\) ;;[\s\S]*?8\)[\s\S]*?protected_before_candidate_sha[\s\S]*?protected_before_marker_sha256/);
  assert.match(installer, /printf 'version=2\\nsha=%s\\nbackup=%s\\nprevious=%s\\nprevious_rollback=%s\\ncandidate_preexisting=0\\nprotected_before_candidate_sha=%s\\nprotected_before_marker_sha256=%s\\n'/);
  assert.match(installer, /rm -rf --one-file-system -- "\$RECOVERY_CANDIDATE"/);
  assert.match(installer, /sync -f \/opt\/newme\/releases[\s\S]*rm -f -- "\$PENDING_RECORD"/);
  assert.match(assetRollback, /CRON_PATH=\/etc\/cron\.d\/newme-observability/);
  assert.match(assetRollback, /\[ "\$dest" != "\$CRON_PATH" \] \|\| continue/);
  assert.match(assetRollback, /RESTORE_TMP="\$\(mktemp "\$directory\/\.newme-asset-rollback\.XXXXXX"\)" \|\| return 1/);
  assert.match(assetRollback, /^\s*cp -a -- "\$source_root\/\$rel" "\$RESTORE_TMP" \|\| return 1\r?$/m);
  assert.match(assetRollback, /mv -Tf "\$RESTORE_TMP" "\$dest" \|\| return 1/);
  assert.match(assetRollback, /RESTORE_PROTECTED_MARKER_LAST=0/);
  assert.match(assetRollback, /if \[ "\$RESTORE_PROTECTED_MARKER_LAST" -eq 1 \] && \[ "\$dest" = "\$CREDENTIAL_PROTECTION_RECORD" \]; then\r?\n\s*continue/);
  assert.match(assetRollback, /restore_managed_cron[\s\S]*RESTORE_PROTECTED_MARKER_LAST/);
  assert.match(assetRollback, /protected_before_candidate_sha/);
  assert.match(assetRollback, /protected_before_marker_sha256/);
  assert.match(assetRollback, /^\s*sync -f \/etc\/cron\.d \|\| return 1\r?$/m);
  const cronRestore = assetRollback.search(/^restore_managed_cron\r?$/m);
  assert.ok(cronRestore > assetRollback.lastIndexOf("systemctl is-active --quiet nginx"));
  const recoveryBranch = installer.indexOf('if [ "$MODE" = install ] && { [ -e "$PENDING_RECORD" ]');
  const pendingRollbackRestoreSync = installer.indexOf("sync -f /opt/newme", recoveryBranch);
  const recoveredPendingClear = installer.indexOf('rm -f -- "$PENDING_RECORD"', recoveryBranch);
  assert.ok(pendingRollbackRestoreSync >= 0 && pendingRollbackRestoreSync < recoveredPendingClear);

  const managedStart = installer.indexOf("MANAGED=(");
  const managedEnd = installer.indexOf("\n)", managedStart);
  assert.ok(managedStart >= 0 && managedEnd > managedStart);
  const managedAssets = installer.slice(managedStart, managedEnd);
  assert.doesNotMatch(managedAssets, /\/usr\/local\/sbin\/newme-(?:deploy|production-rollback)/);
  assert.doesNotMatch(managedAssets, /\/usr\/local\/sbin\/newme-service-control/);
  assert.doesNotMatch(managedAssets, /\/usr\/local\/libexec\/newme\/newme-(?:install|rollback)-systemd-assets/);
  assert.doesNotMatch(managedAssets, /\/etc\/sudoers\.d\/newme-platform/);
  assert.doesNotMatch(managedAssets, /\/etc\/sudoers\.d\/ubuntu-nopasswd/);
  assert.match(installer, /newme-production-rollback\.sh" \/usr\/local\/sbin\/newme-production-rollback/);
  assert.match(installer, /newme-deploy\.sh" \/usr\/local\/sbin\/newme-deploy/);
  assert.match(installer, /newme-service-control\.sh" \/usr\/local\/sbin\/newme-service-control/);
  assert.match(installer, /install-systemd-assets\.sh" \/usr\/local\/libexec\/newme\/newme-install-systemd-assets/);
  assert.match(installer, /rollback-systemd-assets\.sh" \/usr\/local\/libexec\/newme\/newme-rollback-systemd-assets/);
  const normalControlInstall = installer.indexOf("# The recovery control plane is installed inside the open transaction");
  assert.ok(normalControlInstall >= 0);
  const controlInstallOrder = [
    'install_control_script "$ROOT/scripts/install-systemd-assets.sh" /usr/local/libexec/newme/newme-install-systemd-assets',
    'install_control_script "$ROOT/scripts/rollback-systemd-assets.sh" /usr/local/libexec/newme/newme-rollback-systemd-assets',
    'install_control_script "$ROOT/infra/systemd/newme-service-control.sh" /usr/local/sbin/newme-service-control',
    'install_control_script "$ROOT/infra/systemd/newme-production-rollback.sh" /usr/local/sbin/newme-production-rollback',
    'install_control_script "$ROOT/infra/systemd/newme-deploy.sh" /usr/local/sbin/newme-deploy',
    'install_control_sudoers "$ROOT/infra/sudoers/newme-platform" /etc/sudoers.d/newme-platform',
  ].map((line) => installer.indexOf(line, normalControlInstall));
  assert.deepEqual(controlInstallOrder, [...controlInstallOrder].sort((a, b) => a - b));
  assert.ok(controlInstallOrder.every((index) => index >= 0));
  const pendingPublish = installer.indexOf('ln -- "$PENDING_TMP" "$PENDING_RECORD"');
  const firstRuntimeMutation = installer.indexOf('install -D -o root -g root -m 0644 "$UNIT"');
  const globalVisudo = installer.search(/^visudo -c\r?$/m);
  const failureTrap = installer.search(/^trap rollback_on_error EXIT\r?$/m);
  const backupPointer = installer.indexOf('printf \'%s\\n\' "$BACKUP" > "$NEWME_ASSET_BACKUP_RECORD"');
  // Round-3 P1-10 inverted this ordering deliberately. The control plane used to go
  // in before the failure trap and before either recovery pointer existed, so a
  // failure part-way through replacing newme-deploy/newme-production-rollback left
  // no way back — and the paths were not in the remembered set either. The
  // invariant these assertions protect is unchanged: no runtime asset is touched
  // until the whole recovery plane is live. What changed is that the control plane
  // is now inside the open transaction rather than in front of it.
  assert.ok(failureTrap >= 0 && failureTrap < controlInstallOrder[0]);
  assert.ok(backupPointer >= 0 && backupPointer < controlInstallOrder[0]);
  assert.ok(pendingPublish >= 0 && pendingPublish < controlInstallOrder[0]);
  assert.ok(controlInstallOrder.at(-1) < firstRuntimeMutation);
  assert.ok(installer.indexOf("rm -f -- /etc/sudoers.d/ubuntu-nopasswd") > pendingPublish);
  assert.ok(installer.indexOf("rm -f -- /etc/sudoers.d/ubuntu-nopasswd") < firstRuntimeMutation);
  assert.ok(installer.indexOf("sync -f /etc/sudoers.d") < firstRuntimeMutation);
  assert.ok(globalVisudo >= 0 && globalVisudo > pendingPublish && globalVisudo < firstRuntimeMutation);
  assert.ok(pendingPublish < firstRuntimeMutation);
  // And the control-plane paths, which the round-3 review found were installed
  // without ever being backed up, must now be in the remembered set.
  const controlPlaneStart = installer.indexOf("CONTROL_PLANE=(");
  const controlPlaneSet = installer.slice(controlPlaneStart, installer.indexOf("\n)", controlPlaneStart));
  assert.ok(controlPlaneStart >= 0);
  for (const managedPath of [
    "/usr/local/sbin/newme-deploy",
    "/usr/local/sbin/newme-production-rollback",
    "/usr/local/sbin/newme-service-control",
    "/usr/local/libexec/newme/newme-install-systemd-assets",
    "/usr/local/libexec/newme/newme-rollback-systemd-assets",
    "/etc/sudoers.d/newme-platform",
    "/etc/sudoers.d/ubuntu-nopasswd",
  ]) {
    assert.ok(controlPlaneSet.includes(managedPath), `${managedPath} is not remembered`);
  }
  assert.match(installer, /for p in "\$\{MANAGED\[@\]\}" "\$\{CONTROL_PLANE\[@\]\}"/);
  assert.ok(installer.indexOf('do remember "$p"; done') < failureTrap);
  assert.match(finalizer, /os\.fsync\(handle\.fileno\(\)\)/);
  assert.match(finalizer, /os\.replace\(temporary, path\)/);
  assert.match(finalizer, /os\.fsync\(directory_fd\)/);
  assert.match(finalizer, /"asset_backup"/);
});
