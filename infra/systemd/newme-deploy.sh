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
readonly MIGRATION_DB_URL_FILE=/etc/newme/migration-db.url

# Defined here, above the finalize branch, because both entry points need it: the
# deployment gates the release on production's migration history, and finalization
# gates completion on the database phase (Round-4 C8). The URL itself is read by the
# node gate from the file descriptor, never passed as an argument and never echoed —
# a connection string is a credential — so what this checks is the file: not a
# symlink, root-owned, and unreadable by anyone else.
validate_migration_db_url_file() {
  [ -f "$MIGRATION_DB_URL_FILE" ] && [ ! -L "$MIGRATION_DB_URL_FILE" ] || {
    echo "root-owned migration database URL file is missing" >&2
    return 1
  }
  [ "$(stat -c '%U:%G' "$MIGRATION_DB_URL_FILE")" = root:root ] || {
    echo "migration database URL file ownership is invalid" >&2
    return 1
  }
  case "$(stat -c '%a' "$MIGRATION_DB_URL_FILE")" in
    400|600) ;;
    *) echo "migration database URL file mode must be 0400 or 0600" >&2; return 1 ;;
  esac
}

require_node() {
  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
    echo "node is required to gate this deployment and was not found" >&2
    return 1
  }
}

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
  # Round-4 review C8, the other half: "contract history can say applied while mode
  # is compat", so completion must require strict. `complete` is the claim that this
  # release is fully live — it is what makes the candidate a rollback target for the
  # next deployment, and what resolve_target_asset_backup() reads. While the mode is
  # compat the deferred contract migration has not closed the direct-write path,
  # whichever way the migration history reads, so the deferred half of the release
  # is not deployed and the claim would be false. A `fail` finalization records
  # uat_failed and is never gated: it does not claim the release is live.
  if [ "$UAT_STATUS" = pass ]; then
    require_node || exit 65
    validate_migration_db_url_file || exit 65
    # No bypass when the gate is absent. A tree that carries this wrapper carries the
    # gate — install-systemd-assets.sh installs the wrapper from the same tree, and
    # CI asserts both — so "the release has no gate" is not the pre-mechanism case,
    # it is a release someone took the gate out of. Skipping the check there is the
    # false green this whole review round exists to remove.
    FINALIZE_PHASE_GATE="$FINALIZE_TARGET/scripts/check-release-phase.mjs"
    [ -f "$FINALIZE_PHASE_GATE" ] && [ ! -L "$FINALIZE_PHASE_GATE" ] || {
      echo "the current release carries no scripts/check-release-phase.mjs; completion cannot be gated on the database phase" >&2
      exit 70
    }
    "$NODE_BIN" "$FINALIZE_PHASE_GATE" --for-completion \
      --url-file "$MIGRATION_DB_URL_FILE" \
      --modules-dir "$FINALIZE_TARGET/node_modules" >/dev/null || {
      echo "the database phase does not allow this release to be completed" >&2
      exit 70
    }
  fi
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
GATE_RECORD=""
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
# The run object says nothing about which jobs ran. A run is green when nothing
# that ran failed, and a job skipped by its `if:` condition does not make it
# anything else — so the required set has to be read off the jobs endpoint.
JOBS_JSON="$(curl --fail --silent --show-error --max-time 20 \
  --config "$GITHUB_CURL_CONFIG" \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/69755354/newme-platform/actions/runs/$RUN_ID/jobs?per_page=100&filter=latest")"
cleanup_github_config
trap - EXIT HUP INT TERM

# The required set travels with the release: read from the root-owned mirror at
# the canonical main SHA, never from a host-local copy.
REQUIRED_JOBS_JSON="$(git --git-dir="$MIRROR" show \
  "$MAIN_SHA:infra/release/required-jobs.json" 2>/dev/null || true)"
[ -n "$REQUIRED_JOBS_JSON" ] || {
  echo "main does not carry infra/release/required-jobs.json" >&2
  exit 65
}

python3 -c '
import json, sys
expected_sha, expected_run, run_payload, jobs_payload, required_payload = sys.argv[1:]


def refuse(reason):
    sys.stderr.write("release evidence refused: %s\n" % reason)
    raise SystemExit(65)


try:
    run = json.loads(run_payload)
    jobs_response = json.loads(jobs_payload)
    manifest = json.loads(required_payload)
except ValueError as exc:
    refuse("a GitHub API or manifest payload was not JSON (%s)" % exc)

required = manifest.get("required_jobs")
tolerated = manifest.get("tolerated_conclusions")
if not isinstance(required, list) or not required:
    refuse("the required-jobs manifest lists no jobs")
if tolerated != ["success"]:
    refuse("the required-jobs manifest tolerates conclusions other than success")
required_names = []
for entry in required:
    name = entry.get("name") if isinstance(entry, dict) else None
    if not isinstance(name, str) or not name:
        refuse("the required-jobs manifest has an entry without a job name")
    required_names.append(name)
if len(set(required_names)) != len(required_names):
    refuse("the required-jobs manifest lists a job twice")

# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------
# The reviewed revision required event == "push" on main. That is not merely
# narrow, it is unsatisfiable together with the required set below: the
# "Release-final taskboard completion" job is gated on
#     if: github.event_name == "workflow_dispatch" && inputs.release_final
# so no push run can ever contain it. The comment there also claimed a push run
# has a larger job set than a pull_request run, which was the opposite of true.
#
# The runs API does not expose workflow_dispatch inputs, so release_final cannot
# be read directly. The presence of that job in the job list IS the proof.
if str(run.get("id")) != expected_run:
    refuse("the run is not the one named in the claim")
if run.get("head_sha") != expected_sha:
    refuse("the run head_sha is not the release SHA")
if run.get("name") != manifest.get("workflow"):
    refuse("a different workflow is a different gate set")
if run.get("status") != "completed":
    refuse("the run has not completed")
if run.get("conclusion") != "success":
    refuse("the run did not conclude success")
if run.get("event") != manifest.get("event"):
    refuse("the run event %r is not %r" % (run.get("event"), manifest.get("event")))
if run.get("head_branch") != manifest.get("head_branch"):
    refuse("the run is not from %r" % manifest.get("head_branch"))

# ---------------------------------------------------------------------------
# The jobs
# ---------------------------------------------------------------------------
jobs = jobs_response.get("jobs")
total = jobs_response.get("total_count")
if not isinstance(jobs, list) or not jobs:
    refuse("the run reported no jobs")
if total != len(jobs):
    # Fail closed rather than silently gating on the first page: a run large
    # enough to paginate would otherwise be judged on a subset of its jobs.
    refuse("the job list is paginated (%s of %s returned); this gate reads one page" % (len(jobs), total))

seen = {}
for job in jobs:
    name = job.get("name")
    if not isinstance(name, str):
        refuse("a job in the run has no name")
    if job.get("head_sha") not in (None, expected_sha):
        refuse("job %r ran against a different commit" % name)
    conclusion = job.get("conclusion")
    if name in required_names:
        if name in seen:
            refuse("required job %r appears twice in the job list" % name)
        if job.get("status") != "completed":
            refuse("required job %r has not completed" % name)
        if conclusion not in tolerated:
            refuse("required job %r concluded %r" % (name, conclusion))
        seen[name] = conclusion
    elif conclusion not in ("success", "skipped", None):
        # A non-required job that failed still means this commit is not green.
        refuse("job %r concluded %r" % (name, conclusion))

missing = [name for name in required_names if name not in seen]
if missing:
    refuse("required job(s) absent from the run: %s" % ", ".join(missing))
' "$SHA" "$RUN_ID" "$RUN_JSON" "$JOBS_JSON" "$REQUIRED_JOBS_JSON" || {
  echo "GitHub Actions evidence is not a release-final main dispatch of ci with every required job green" >&2
  exit 65
}
CI_RUN_URL="https://github.com/69755354/newme-platform/actions/runs/$RUN_ID"
CI_CONCLUSION=success
# Recorded and re-validated downstream by deploy-immutable.sh, which cannot see
# the API response.
CI_EVENT=workflow_dispatch

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
# The gate record is evidence about one installer invocation, not a durable fact.
# It is removed as soon as the installer returns and on every exit path, so it can
# never be found later by an installer this wrapper did not gate.
remove_gate_record() {
  [ -n "$GATE_RECORD" ] || return 0
  case "$GATE_RECORD" in
    "$STATE_ROOT"/deploy-gates.*) rm -f -- "$GATE_RECORD" ;;
  esac
  GATE_RECORD=""
}
cleanup() {
  rc=$?
  trap - EXIT HUP INT TERM
  remove_gate_record
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

# ---------------------------------------------------------------------------
# Two host-side gates that CI structurally cannot provide
# ---------------------------------------------------------------------------
# Both run against the root-owned worktree at the canonical main SHA, before any
# asset is installed and before the release is staged, and both abort the
# deployment. Neither can be satisfied by a claim on the command line.
require_node || exit 65

# TASKBOARD completion. The required GitHub job proves it for the dispatched SHA;
# this proves it for the tree that is actually about to be deployed, using the
# checker committed to that same tree. AGENTS.md makes an unfinished board a
# deploy blocker, and until this revision nothing in the canonical path enforced
# that — scripts/deploy.sh Step 0 did, and scripts/deploy.sh is not the canonical
# path.
"$NODE_BIN" "$WORKTREE/scripts/check-taskboard.mjs" --require-complete || {
  echo "TASKBOARD.md at canonical main is not complete; deployment is blocked" >&2
  exit 65
}

# Remote migration history. The replay job proves the migrations in this tree run
# and do what they claim; it cannot prove that production's recorded history is
# the same history. A renamed or rewritten applied migration — the defect that
# rejected the reviewed revision of this branch — is invisible to every other
# gate here.
#
# The gate reads version, name, a statement count and a server-computed
# fingerprint, and compares them against the captured baseline in
# supabase/migration-history-reconciliation.json. Content that cannot be measured,
# a row recorded with no statements, and any difference the baseline's `accepted`
# list does not explicitly account for are all refusals — including on the first
# deploy, where the baseline is uncaptured and therefore explains nothing. That is
# deliberate: see supabase/preflight/migration-history-reconciliation.md.
validate_migration_db_url_file || exit 65
MIGRATION_HISTORY_ARGS=(
  "$WORKTREE/scripts/verify-remote-migration-history.mjs"
  --url-file "$MIGRATION_DB_URL_FILE"
  --migrations-dir "$WORKTREE/supabase/migrations"
  --modules-dir "$LIVE_RELEASE/node_modules"
  --history-fixture "$WORKTREE/supabase/migration-history-reconciliation.json"
)
case "$MIGRATION_STATUS" in
  applied_verified) MIGRATION_HISTORY_ARGS+=(--require-applied "$MIGRATION_IDS") ;;
  not_required)     MIGRATION_HISTORY_ARGS+=(--require-no-pending) ;;
esac
"$NODE_BIN" "${MIGRATION_HISTORY_ARGS[@]}" || {
  echo "production migration history does not match the release being deployed" >&2
  exit 65
}

# Systemd, sudo and observability assets are part of the immutable release
# boundary. Refresh them only from the verified root-owned main worktree.
ASSET_BACKUP_RECORD="$(mktemp "$STATE_ROOT/systemd-assets-backup.XXXXXX")"
chmod 0600 "$ASSET_BACKUP_RECORD"

# The bootstrap precondition (round-3 P1-10). The installer replaces the control
# plane, including this wrapper, so it must not accept the word of a wrapper that
# checked nothing — and production still runs the old f37c203 one, which passes no
# CI_EVENT and runs none of the gates above. This record is that evidence: written
# only here, after every gate has passed, bound to this SHA and this run, and
# verified by scripts/verify-deploy-gate-record.mjs inside the installer before it
# touches anything. A wrapper that does not write it cannot install.
GATE_RECORD="$(mktemp "$STATE_ROOT/deploy-gates.XXXXXX")"
chmod 0600 "$GATE_RECORD"
cat > "$GATE_RECORD" <<EOF
sha=$SHA
event=$CI_EVENT
run=$RUN_ID
gate=canonical-main-verified
gate=github-required-jobs-green
gate=taskboard-complete
gate=remote-migration-history
EOF
sync -f "$STATE_ROOT"

# The installer is invoked with the record still in place; cleanup() removes it on
# every exit path, and it is removed here as soon as the installer returns.
NEWME_ASSET_BACKUP_RECORD="$ASSET_BACKUP_RECORD" \
NEWME_DEPLOY_GATE_RECORD="$GATE_RECORD" \
NEWME_NODE_BIN="$NODE_BIN" \
  bash "$WORKTREE/scripts/install-systemd-assets.sh"
remove_gate_record
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
