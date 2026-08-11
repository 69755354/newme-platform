#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "newme-deploy must run as root" >&2
  exit 77
fi
exec 9>/run/lock/newme-production-release.lock
flock -n 9 || {
  echo "another production release operation is active" >&2
  exit 69
}
STATE_ROOT=/var/lib/newme/deploy-state
PENDING_ASSET_RECORD="$STATE_ROOT/systemd-assets.pending"
PRODUCTION_ROLLBACK_PENDING="$STATE_ROOT/production-rollback.pending"

if [ "${1:-}" = "finalize" ]; then
  FINALIZE_SHA=${2:-}
  UAT_STATUS=${3:-}
  UAT_ACTOR=${4:-}
  UAT_FIXTURE_IDS=${5:-}
  FIXTURE_CLEANUP_STATUS=${6:-}
  if [ "$#" -ne 6 ] || ! [[ "$FINALIZE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
    ! [[ "$UAT_ACTOR" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    echo "usage: newme-deploy finalize <current-sha> <pass|fail> <uat-actor-uuid> <fixture-uuid-list> <not_required|archived_verified|removed_verified>" >&2
    exit 64
  fi
  case "$UAT_STATUS" in pass|fail) ;; *) exit 64 ;; esac
  case "$FIXTURE_CLEANUP_STATUS" in
    not_required) [ -z "$UAT_FIXTURE_IDS" ] || exit 64 ;;
    archived_verified|removed_verified)
      [[ "$UAT_FIXTURE_IDS" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$ ]] || exit 64
      ;;
    *) exit 64 ;;
  esac
  [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || { echo "persistent deploy-state directory is invalid" >&2; exit 65; }
  [ "$(stat -c '%U:%G' "$STATE_ROOT")" = root:root ] || { echo "persistent deploy-state directory ownership is invalid" >&2; exit 65; }
  [ "$(stat -c '%a' "$STATE_ROOT")" = 700 ] || { echo "persistent deploy-state directory mode is invalid" >&2; exit 65; }
  if [ -e "$PENDING_ASSET_RECORD" ] || [ -L "$PENDING_ASSET_RECORD" ] ||
    [ -e "$PRODUCTION_ROLLBACK_PENDING" ] || [ -L "$PRODUCTION_ROLLBACK_PENDING" ]; then
    echo "unresolved deployment or rollback state must be recovered before finalization" >&2
    exit 75
  fi
  FINALIZE_TARGET="$(readlink -f /opt/newme/current 2>/dev/null || true)"
  [ "$FINALIZE_TARGET" = "/opt/newme/releases/$FINALIZE_SHA" ] || {
    echo "finalize SHA must equal the current immutable release" >&2
    exit 65
  }
  FINALIZE_ROLLBACK_TARGET="$(readlink -f /opt/newme/current.rollback 2>/dev/null || true)"
  case "$FINALIZE_ROLLBACK_TARGET" in /opt/newme/releases/*) ;; *) exit 65 ;; esac
  [[ "$(basename "$FINALIZE_ROLLBACK_TARGET")" =~ ^[0-9a-f]{40}$ ]] || exit 65
  [ -d "$FINALIZE_ROLLBACK_TARGET" ] && [ ! -L "$FINALIZE_ROLLBACK_TARGET" ] &&
    [ -f "$FINALIZE_ROLLBACK_TARGET/.newme-protect" ] &&
    [ -f "$FINALIZE_ROLLBACK_TARGET/.next/BUILD_ID" ] || exit 65
  mapfile -t EVIDENCE_FILES < <(find "$FINALIZE_TARGET/.audit" -maxdepth 1 -type f -name 'deploy-*.json' -print)
  [ "${#EVIDENCE_FILES[@]}" -eq 1 ] || {
    echo "current release must contain exactly one deployment evidence file" >&2
    exit 65
  }
  EVIDENCE_FILE=${EVIDENCE_FILES[0]}
  python3 - "$EVIDENCE_FILE" "$FINALIZE_SHA" "$FINALIZE_ROLLBACK_TARGET" \
    "$UAT_STATUS" "$UAT_ACTOR" "$UAT_FIXTURE_IDS" "$FIXTURE_CLEANUP_STATUS" <<'PY'
import json
import os
import re
import stat
import sys

path, expected_sha, rollback_target, requested_status, actor, fixture_text, cleanup = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    evidence = json.load(handle)
if evidence.get("git_sha") != expected_sha:
    raise SystemExit(65)
release_status = evidence.get("release_status")
if release_status in {"complete", "uat_failed"}:
    uat = evidence.get("uat", {})
    fixtures = [value.strip() for value in fixture_text.split(",") if value.strip()]
    expected_status = "pass" if release_status == "complete" else "fail"
    if (
        requested_status != expected_status
        or uat.get("status") != expected_status
        or uat.get("actor") != actor
        or uat.get("fixture_ids") != fixtures
        or uat.get("cleanup_status") != cleanup
    ):
        raise SystemExit(65)
elif release_status != "awaiting_uat":
    raise SystemExit(65)
rollback = evidence.get("rollback", {})
asset_backup = rollback.get("asset_backup", "")
previous_rollback = rollback.get("previous_rollback", {})
if (
    evidence.get("candidate_preexisting") is not False
    or rollback.get("git_sha") != rollback_target.rsplit("/", 1)[-1]
    or rollback.get("backup_dir") != rollback_target
    or not re.fullmatch(r"/var/backups/newme-systemd-assets/[^\s]+", asset_backup)
    or os.path.realpath(asset_backup) != asset_backup
    or not os.path.isdir(asset_backup)
    or os.path.islink(asset_backup)
):
    raise SystemExit(65)
if not isinstance(previous_rollback, dict):
    raise SystemExit(65)
previous_rollback_sha = previous_rollback.get("git_sha", "")
previous_rollback_dir = previous_rollback.get("backup_dir", "")
if previous_rollback_dir:
    if (
        not re.fullmatch(r"/opt/newme/releases/[0-9a-f]{40}", previous_rollback_dir)
        or previous_rollback_sha != previous_rollback_dir.rsplit("/", 1)[-1]
    ):
        raise SystemExit(65)
    if release_status != "complete" and (
        os.path.realpath(previous_rollback_dir) != previous_rollback_dir
        or not os.path.isdir(previous_rollback_dir)
        or os.path.islink(previous_rollback_dir)
        or not os.path.isfile(os.path.join(previous_rollback_dir, ".newme-protect"))
        or not os.path.isfile(os.path.join(previous_rollback_dir, ".next", "BUILD_ID"))
    ):
        raise SystemExit(65)
elif previous_rollback_sha:
    raise SystemExit(65)
metadata = os.stat(asset_backup)
if metadata.st_uid != 0 or metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) != 0o700:
    raise SystemExit(65)
if not os.path.isdir(os.path.join(asset_backup, "rootfs")):
    raise SystemExit(65)
for required in ("managed.list", "present.list", "manifest.sha256", "symlink.sha256"):
    required_path = os.path.join(asset_backup, required)
    if not os.path.isfile(required_path) or os.path.islink(required_path):
        raise SystemExit(65)
PY
  UAT_STATUS="$UAT_STATUS" \
  UAT_ACTOR="$UAT_ACTOR" \
  UAT_FIXTURE_IDS="$UAT_FIXTURE_IDS" \
  FIXTURE_CLEANUP_STATUS="$FIXTURE_CLEANUP_STATUS" \
    bash "$FINALIZE_TARGET/scripts/finalize-deploy-evidence.sh" "$EVIDENCE_FILE"
  sync -f "$EVIDENCE_FILE"
  sync -f "$FINALIZE_TARGET/.audit"
  if [ "$UAT_STATUS" = pass ]; then
    echo "finalized SHA=$FINALIZE_SHA evidence=$EVIDENCE_FILE status=complete"
    exit 0
  fi
  echo "finalized SHA=$FINALIZE_SHA evidence=$EVIDENCE_FILE status=uat_failed" >&2
  exit 1
fi

SHA=${1:-}
RUN_ID=${2:-}
MIGRATION_STATUS=${3:-}
MIGRATION_IDS=${4:-}
ROLLBACK_SHA=${5:-}
if [ "$#" -ne 5 ] || ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || ! [[ "$ROLLBACK_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: newme-deploy <main-sha> <successful-run-id> <not_required|applied_verified> <migration-ids> <rollback-sha>" >&2
  exit 64
fi
case "$MIGRATION_STATUS" in
  not_required) [ -z "$MIGRATION_IDS" ] || exit 64 ;;
  applied_verified) [[ "$MIGRATION_IDS" =~ ^[0-9A-Za-z_.-]+(,[0-9A-Za-z_.-]+)*$ ]] || exit 64 ;;
  *) exit 64 ;;
esac
if [ "$RUN_ID" = "manual" ]; then
  echo "manual production deployment is disabled; an exact successful GitHub Actions run is required" >&2
  exit 65
fi
[[ "$RUN_ID" =~ ^[0-9]+$ ]] || exit 64

readonly ORIGIN_HTTPS="https://github.com/69755354/newme-platform.git"
readonly ORIGIN_SSH="git@github.com:69755354/newme-platform.git"
readonly MIRROR="/opt/newme/repository.git"
readonly WORKTREE_ROOT="/var/lib/newme/deploy-worktrees"
readonly LEGACY_EVIDENCELESS_BASELINE="945d1b5e0615c963c19e116483fcc8c4253d03ea"
ASSET_BACKUP_RECORD=""
ASSET_BACKUP=""
DEPLOY_STATE_RECORD=""
DEPLOY_STATE=""
DEPLOY_SUCCEEDED=0
RESTART_AFTER_ASSET_ROLLBACK=0
PRESERVE_DEPLOY_STATE_RECORD=0
PRESERVE_ASSET_BACKUP_RECORD=0
PENDING_PREVIOUS=""
PENDING_PREVIOUS_ROLLBACK=""
[ -d "$MIRROR" ] || { echo "root-owned release mirror is missing" >&2; exit 65; }
[ "$(stat -c '%U:%G' "$MIRROR")" = "root:root" ] || { echo "release mirror ownership is invalid" >&2; exit 65; }
case "$(git --git-dir="$MIRROR" remote get-url origin)" in
  "$ORIGIN_HTTPS"|"$ORIGIN_SSH") ;;
  *) echo "release mirror origin is invalid" >&2; exit 65 ;;
esac

git --git-dir="$MIRROR" fetch --quiet --prune origin '+refs/heads/main:refs/remotes/origin/main'
MAIN_SHA="$(git --git-dir="$MIRROR" rev-parse refs/remotes/origin/main)"
[ "$SHA" = "$MAIN_SHA" ] || { echo "release SHA must equal canonical main" >&2; exit 65; }
LIVE_RELEASE="$(readlink -f /opt/newme/current 2>/dev/null || true)"
[ "$LIVE_RELEASE" = "/opt/newme/releases/$ROLLBACK_SHA" ] || {
  echo "rollback SHA must equal the current immutable production release" >&2
  exit 65
}
if [ "$ROLLBACK_SHA" != "$LEGACY_EVIDENCELESS_BASELINE" ]; then
  [ -d "$LIVE_RELEASE/.audit" ] && [ ! -L "$LIVE_RELEASE/.audit" ] || {
    echo "current release lacks protected deployment evidence" >&2
    exit 65
  }
  mapfile -t CURRENT_EVIDENCE_FILES < <(find "$LIVE_RELEASE/.audit" -maxdepth 1 -type f -name 'deploy-*.json' -print)
  [ "${#CURRENT_EVIDENCE_FILES[@]}" -eq 1 ] || {
    echo "current release must have exactly one finalized deployment evidence file before another deployment" >&2
    exit 65
  }
  python3 - "${CURRENT_EVIDENCE_FILES[0]}" "$ROLLBACK_SHA" <<'PY'
import json
import sys

path, expected_sha = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    evidence = json.load(handle)
if evidence.get("git_sha") != expected_sha or evidence.get("release_status") != "complete":
    raise SystemExit(65)
PY
fi

service_control_source=$(git --git-dir="$MIRROR" show \
  "$MAIN_SHA:infra/systemd/newme-service-control.sh" 2>/dev/null || true)
rollback_source=$(git --git-dir="$MIRROR" show \
  "$MAIN_SHA:infra/systemd/newme-production-rollback.sh" 2>/dev/null || true)
sudoers_source=$(git --git-dir="$MIRROR" show \
  "$MAIN_SHA:infra/sudoers/newme-platform" 2>/dev/null || true)
immutable_deploy_source=$(git --git-dir="$MIRROR" show \
  "$MAIN_SHA:scripts/deploy-immutable.sh" 2>/dev/null || true)
[[ "$service_control_source" == *"only newme-platform.service can be controlled"* ]] || {
  echo "main lacks the production service-control unit-token guard" >&2
  exit 65
}
[[ "$rollback_source" == *"/opt/newme/current.rollback"* ]] || {
  echo "main lacks the protected production rollback controller" >&2
  exit 65
}
[[ "$sudoers_source" == *"/usr/local/sbin/newme-production-rollback"* ]] || {
  echo "main lacks the restricted production rollback sudo policy" >&2
  exit 65
}
[[ "$immutable_deploy_source" == *'ROLLBACK="${NEWME_ROLLBACK_LINK:-/opt/newme/current.rollback}"'* ]] &&
  [[ "$immutable_deploy_source" == *"protected_release=true"* ]] || {
  echo "main lacks rollback-preserving immutable deployment" >&2
  exit 65
}

readonly GITHUB_API_TOKEN_FILE=/etc/newme/github-actions-read.token
[ -f "$GITHUB_API_TOKEN_FILE" ] && [ ! -L "$GITHUB_API_TOKEN_FILE" ] || {
  echo "root-owned GitHub Actions read token is missing" >&2
  exit 65
}
[ "$(stat -c '%U:%G' "$GITHUB_API_TOKEN_FILE")" = root:root ] || {
  echo "GitHub Actions read token ownership is invalid" >&2
  exit 65
}
case "$(stat -c '%a' "$GITHUB_API_TOKEN_FILE")" in
  400|600) ;;
  *) echo "GitHub Actions read token mode must be 0400 or 0600" >&2; exit 65 ;;
esac
IFS= read -r github_token < "$GITHUB_API_TOKEN_FILE" || true
[[ "$github_token" =~ ^[A-Za-z0-9_]{20,512}$ ]] || {
  echo "GitHub Actions read token format is invalid" >&2
  exit 65
}
GITHUB_CURL_CONFIG="$(mktemp /run/newme-github-api.XXXXXX)"
cleanup_github_config() {
  rm -f -- "$GITHUB_CURL_CONFIG"
}
trap cleanup_github_config EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 0600 "$GITHUB_CURL_CONFIG"
printf 'header = "Authorization: Bearer %s"\n' "$github_token" > "$GITHUB_CURL_CONFIG"
unset github_token
RUN_JSON="$(curl --fail --silent --show-error --max-time 15 \
  --config "$GITHUB_CURL_CONFIG" \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/69755354/newme-platform/actions/runs/$RUN_ID")"
cleanup_github_config
trap - EXIT HUP INT TERM
python3 -c '
import json, sys
expected_sha, expected_run, payload = sys.argv[1:]
run = json.loads(payload)
# The error message below has always said "successful main run", but the check
# never established either half of that. A `pull_request` run of the ci workflow
# reports head_sha = the PR head commit, name = "ci" and conclusion = "success",
# so a green run on any topic branch satisfied every condition and was accepted
# as main-branch evidence. That matters beyond provenance: .github/workflows
# gates the release-final jobs on
#     if: github.event_name == "workflow_dispatch" && inputs.release_final
# so a pull_request run is green with a strictly smaller set of jobs than a main
# push. An incomplete gate set was being recorded as a complete one.
#
# event and head_branch are now part of the claim.
if (
    str(run.get("id")) != expected_run
    or run.get("head_sha") != expected_sha
    or run.get("name") != "ci"
    or run.get("conclusion") != "success"
    or run.get("event") != "push"
    or run.get("head_branch") != "main"
):
    raise SystemExit(65)
' "$SHA" "$RUN_ID" "$RUN_JSON" || {
  echo "GitHub Actions evidence is not a successful main-branch push run of the ci workflow" >&2
  exit 65
}
CI_RUN_URL="https://github.com/69755354/newme-platform/actions/runs/$RUN_ID"
CI_CONCLUSION=success
# Recorded and re-validated downstream by deploy-immutable.sh, which cannot see
# the API response.
CI_EVENT=push

mkdir -p -m 0700 "$WORKTREE_ROOT"
install -d -o root -g root -m 0700 "$STATE_ROOT"
[ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || { echo "persistent deploy-state directory is invalid" >&2; exit 65; }
[ "$(stat -c '%U:%G' "$STATE_ROOT")" = root:root ] || { echo "persistent deploy-state directory ownership is invalid" >&2; exit 65; }
[ "$(stat -c '%a' "$STATE_ROOT")" = 700 ] || { echo "persistent deploy-state directory mode is invalid" >&2; exit 65; }
if [ -e "$PRODUCTION_ROLLBACK_PENDING" ] || [ -L "$PRODUCTION_ROLLBACK_PENDING" ]; then
  echo "an unresolved production rollback must be recovered before deployment" >&2
  exit 75
fi
WORKTREE="$(mktemp -d "$WORKTREE_ROOT/release.XXXXXX")"
load_asset_backup_from_record() {
  local candidate=""
  [ -n "$ASSET_BACKUP_RECORD" ] && [ -f "$ASSET_BACKUP_RECORD" ] && [ ! -L "$ASSET_BACKUP_RECORD" ] || return 1
  [ "$(stat -c '%U:%G' "$ASSET_BACKUP_RECORD")" = root:root ] || return 1
  [ "$(stat -c '%a' "$ASSET_BACKUP_RECORD")" = 600 ] || return 1
  IFS= read -r candidate < "$ASSET_BACKUP_RECORD" || return 1
  case "$candidate" in
    /var/backups/newme-systemd-assets/*) ;;
    *) return 1 ;;
  esac
  [ -d "$candidate/rootfs" ] && [ -f "$candidate/managed.list" ] || return 1
  ASSET_BACKUP="$candidate"
}
load_deploy_state() {
  local state=""
  [ -n "$DEPLOY_STATE_RECORD" ] && [ -f "$DEPLOY_STATE_RECORD" ] && [ ! -L "$DEPLOY_STATE_RECORD" ] || return 1
  [ "$(stat -c '%U:%G' "$DEPLOY_STATE_RECORD")" = root:root ] || return 1
  [ "$(stat -c '%a' "$DEPLOY_STATE_RECORD")" = 600 ] || return 1
  IFS= read -r state < "$DEPLOY_STATE_RECORD" || return 1
  case "$state" in
    prepared|switch_pending|switched|app_rollback_pending|app_rolled_back|assets_rolled_back|complete="$SHA") ;;
    *) return 1 ;;
  esac
  DEPLOY_STATE="$state"
}
load_matching_pending_asset_record() {
  local pending_sha="" pending_backup=""
  [ -f "$PENDING_ASSET_RECORD" ] && [ ! -L "$PENDING_ASSET_RECORD" ] || return 1
  [ "$(stat -c '%U:%G' "$PENDING_ASSET_RECORD")" = root:root ] || return 1
  [ "$(stat -c '%a' "$PENDING_ASSET_RECORD")" = 600 ] || return 1
  [ "$(wc -l < "$PENDING_ASSET_RECORD")" -eq 5 ] || return 1
  [ "$(grep -Ec '^sha=[0-9a-f]{40}$' "$PENDING_ASSET_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^backup=/var/backups/newme-systemd-assets/[^[:space:]]+$' "$PENDING_ASSET_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^previous=/opt/newme/releases/[0-9a-f]{40}$' "$PENDING_ASSET_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^previous_rollback=(/opt/newme/releases/[0-9a-f]{40})?$' "$PENDING_ASSET_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^candidate_preexisting=0$' "$PENDING_ASSET_RECORD")" -eq 1 ] || return 1
  pending_sha="$(sed -n 's/^sha=//p' "$PENDING_ASSET_RECORD")"
  pending_backup="$(sed -n 's/^backup=//p' "$PENDING_ASSET_RECORD")"
  PENDING_PREVIOUS="$(sed -n 's/^previous=//p' "$PENDING_ASSET_RECORD")"
  PENDING_PREVIOUS_ROLLBACK="$(sed -n 's/^previous_rollback=//p' "$PENDING_ASSET_RECORD")"
  [ "$pending_sha" = "$SHA" ] &&
    [ "$pending_backup" = "$ASSET_BACKUP" ] &&
    [ "$PENDING_PREVIOUS" = "/opt/newme/releases/$ROLLBACK_SHA" ] || return 1
}
restore_pending_rollback_link() {
  local rollback_next="/opt/newme/current.rollback.recovery-$$"
  load_matching_pending_asset_record || return 1
  [ "$(readlink -f /opt/newme/current 2>/dev/null || true)" = "$PENDING_PREVIOUS" ] || return 1
  rm -f -- "$rollback_next" || return 1
  if [ -n "$PENDING_PREVIOUS_ROLLBACK" ]; then
    ln -s "$PENDING_PREVIOUS_ROLLBACK" "$rollback_next" || return 1
    mv -Tf "$rollback_next" /opt/newme/current.rollback || return 1
  else
    rm -f -- /opt/newme/current.rollback || return 1
  fi
  sync -f /opt/newme || return 1
}
remove_interrupted_candidate_release() {
  local candidate="/opt/newme/releases/$SHA"
  if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
    sync -f /opt/newme/releases || return 1
    return 0
  fi
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(readlink -f /opt/newme/current 2>/dev/null || true)" != "$candidate" ] || return 1
  [ "$(readlink -f /opt/newme/current.rollback 2>/dev/null || true)" != "$candidate" ] || return 1
  rm -rf --one-file-system -- "$candidate" || return 1
  [ ! -e "$candidate" ] && [ ! -L "$candidate" ] || return 1
  sync -f /opt/newme/releases || return 1
}
clear_matching_pending_asset_record() {
  local disposition="${1:-recovery}"
  if [ ! -e "$PENDING_ASSET_RECORD" ] && [ ! -L "$PENDING_ASSET_RECORD" ]; then
    return 0
  fi
  load_matching_pending_asset_record || return 1
  case "$disposition" in
    complete) ;;
    recovery) remove_interrupted_candidate_release || return 1 ;;
    *) return 1 ;;
  esac
  rm -f -- "$PENDING_ASSET_RECORD"
}
cleanup() {
  rc=$?
  trap - EXIT HUP INT TERM
  load_deploy_state || DEPLOY_STATE="unknown"
  if [ "$DEPLOY_STATE" = "complete=$SHA" ]; then
    DEPLOY_SUCCEEDED=1
    [ "$rc" -eq 0 ] || echo "canonical wrapper was interrupted after durable deployment completion; release retained" >&2
    if ! clear_matching_pending_asset_record complete; then
      echo "CRITICAL: completed deployment pending asset pointer could not be cleared" >&2
      PRESERVE_DEPLOY_STATE_RECORD=1
      PRESERVE_ASSET_BACKUP_RECORD=1
      rc=2
    fi
  fi
  if [ "$rc" -ne 0 ] && [ "$DEPLOY_SUCCEEDED" -eq 0 ]; then
    current_release="$(readlink -f /opt/newme/current 2>/dev/null || true)"
    if { [ "$DEPLOY_STATE" = switched ] || [ "$DEPLOY_STATE" = switch_pending ] || [ "$DEPLOY_STATE" = app_rollback_pending ] || [ "$DEPLOY_STATE" = unknown ]; } &&
      [ "$current_release" = "/opt/newme/releases/$SHA" ]; then
      echo "CRITICAL: failed canonical child left the candidate release active; versioned assets retained for consistency" >&2
      PRESERVE_DEPLOY_STATE_RECORD=1
      PRESERVE_ASSET_BACKUP_RECORD=1
    elif [ "$DEPLOY_STATE" = assets_rolled_back ]; then
      echo "immutable deploy already restored versioned assets" >&2
      if ! clear_matching_pending_asset_record recovery; then
        echo "CRITICAL: matching pending asset pointer could not be cleared after child rollback" >&2
        PRESERVE_DEPLOY_STATE_RECORD=1
        PRESERVE_ASSET_BACKUP_RECORD=1
      fi
    elif [ -n "$ASSET_BACKUP" ] || load_asset_backup_from_record; then
      if [ "$DEPLOY_STATE" = app_rollback_pending ] || [ "$DEPLOY_STATE" = app_rolled_back ] ||
        { { [ "$DEPLOY_STATE" = switch_pending ] || [ "$DEPLOY_STATE" = switched ] || [ "$DEPLOY_STATE" = unknown ]; } &&
          [ "$current_release" = "/opt/newme/releases/$ROLLBACK_SHA" ]; }; then
        RESTART_AFTER_ASSET_ROLLBACK=1
      fi
      echo "canonical deploy failed; restoring versioned assets from $ASSET_BACKUP" >&2
      if bash "$WORKTREE/scripts/rollback-systemd-assets.sh" "$ASSET_BACKUP"; then
        ASSET_ROLLBACK_VERIFIED=1
        if ! restore_pending_rollback_link; then
          echo "CRITICAL: prior rollback release pointer could not be restored" >&2
          PRESERVE_DEPLOY_STATE_RECORD=1
          PRESERVE_ASSET_BACKUP_RECORD=1
          ASSET_ROLLBACK_VERIFIED=0
        fi
        if [ "$ASSET_ROLLBACK_VERIFIED" -eq 1 ] && [ "$RESTART_AFTER_ASSET_ROLLBACK" -eq 1 ]; then
          /usr/local/sbin/newme-service-control reset-failed "deploy:asset-rollback:reset-before-restart" || true
          if ! /usr/local/sbin/newme-service-control restart "deploy:asset-rollback:canonical-failure" ||
            ! curl -fsS --max-time 10 http://127.0.0.1:3001/api/health >/dev/null; then
            echo "CRITICAL: application verification failed after asset rollback" >&2
            PRESERVE_DEPLOY_STATE_RECORD=1
            PRESERVE_ASSET_BACKUP_RECORD=1
            ASSET_ROLLBACK_VERIFIED=0
          fi
        fi
        if [ "$ASSET_ROLLBACK_VERIFIED" -eq 1 ] && ! clear_matching_pending_asset_record recovery; then
          echo "CRITICAL: matching pending asset pointer could not be cleared after rollback" >&2
          PRESERVE_DEPLOY_STATE_RECORD=1
          PRESERVE_ASSET_BACKUP_RECORD=1
        fi
      else
        echo "CRITICAL: canonical deploy asset rollback failed for $ASSET_BACKUP" >&2
        PRESERVE_DEPLOY_STATE_RECORD=1
        PRESERVE_ASSET_BACKUP_RECORD=1
      fi
    elif [ -s "$ASSET_BACKUP_RECORD" ]; then
      echo "CRITICAL: canonical deploy could not validate its asset backup record" >&2
      PRESERVE_DEPLOY_STATE_RECORD=1
      PRESERVE_ASSET_BACKUP_RECORD=1
    fi
  fi
  if [ -n "$ASSET_BACKUP_RECORD" ] && [ "$PRESERVE_ASSET_BACKUP_RECORD" -eq 0 ]; then rm -f -- "$ASSET_BACKUP_RECORD"; fi
  if [ -n "$DEPLOY_STATE_RECORD" ] && [ "$PRESERVE_DEPLOY_STATE_RECORD" -eq 0 ]; then rm -f -- "$DEPLOY_STATE_RECORD"; fi
  sync -f "$STATE_ROOT" || true
  git --git-dir="$MIRROR" worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf -- "$WORKTREE"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

git --git-dir="$MIRROR" branch -f main "$MAIN_SHA"
rmdir "$WORKTREE"
git --git-dir="$MIRROR" worktree add --force "$WORKTREE" main >/dev/null
chown -R root:root "$WORKTREE"

# Systemd, sudo and observability assets are part of the immutable release
# boundary. Refresh them only from the verified root-owned main worktree.
ASSET_BACKUP_RECORD="$(mktemp "$STATE_ROOT/systemd-assets-backup.XXXXXX")"
chmod 0600 "$ASSET_BACKUP_RECORD"
NEWME_ASSET_BACKUP_RECORD="$ASSET_BACKUP_RECORD" bash "$WORKTREE/scripts/install-systemd-assets.sh"
load_asset_backup_from_record || { echo "installer did not return a valid asset backup" >&2; exit 65; }
DEPLOY_STATE_RECORD="$(mktemp "$STATE_ROOT/deploy-state.XXXXXX")"
chmod 0600 "$DEPLOY_STATE_RECORD"

/usr/bin/logger --journald <<EOF
MESSAGE=newme canonical deployment request
PRIORITY=5
SYSLOG_IDENTIFIER=newme-deploy
NEWME_ACTOR=${SUDO_USER:-root}
NEWME_RELEASE_SHA=$SHA
NEWME_CI_RUN_ID=$RUN_ID
NEWME_MIGRATION_STATUS=$MIGRATION_STATUS
EOF

CI_RUN_ID="$RUN_ID" \
CI_RUN_URL="$CI_RUN_URL" \
CI_HEAD_SHA="$SHA" \
CI_CONCLUSION="$CI_CONCLUSION" \
CI_EVENT="$CI_EVENT" \
NEWME_MANUAL_VERIFICATION=0 \
MIGRATION_STATUS="$MIGRATION_STATUS" \
MIGRATION_IDS="$MIGRATION_IDS" \
ROLLBACK_GIT_SHA="$ROLLBACK_SHA" \
NEWME_ASSET_BACKUP="$ASSET_BACKUP" \
NEWME_DEPLOY_STATE_RECORD="$DEPLOY_STATE_RECORD" \
bash "$WORKTREE/scripts/deploy-immutable.sh" "$SHA"
load_deploy_state && [ "$DEPLOY_STATE" = "complete=$SHA" ] || { echo "immutable deploy did not record durable completion" >&2; exit 65; }
DEPLOY_SUCCEEDED=1
