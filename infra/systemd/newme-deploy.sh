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
[ -d "$MIRROR" ] || { echo "root-owned release mirror is missing" >&2; exit 65; }
[ "$(stat -c '%U:%G' "$MIRROR")" = "root:root" ] || { echo "release mirror ownership is invalid" >&2; exit 65; }
case "$(git --git-dir="$MIRROR" remote get-url origin)" in
  "$ORIGIN_HTTPS"|"$ORIGIN_SSH") ;;
  *) echo "release mirror origin is invalid" >&2; exit 65 ;;
esac

git --git-dir="$MIRROR" fetch --quiet --prune origin '+refs/heads/main:refs/remotes/origin/main'
MAIN_SHA="$(git --git-dir="$MIRROR" rev-parse refs/remotes/origin/main)"
[ "$SHA" = "$MAIN_SHA" ] || { echo "release SHA must equal canonical main" >&2; exit 65; }

service_control_source=$(git --git-dir="$MIRROR" show \
  "$MAIN_SHA:infra/systemd/newme-service-control.sh" 2>/dev/null || true)
rollback_source=$(git --git-dir="$MIRROR" show \
  "$MAIN_SHA:infra/systemd/newme-production-rollback.sh" 2>/dev/null || true)
sudoers_source=$(git --git-dir="$MIRROR" show \
  "$MAIN_SHA:infra/sudoers/newme-platform" 2>/dev/null || true)
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

RUN_JSON="$(curl --fail --silent --show-error --max-time 15 \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/69755354/newme-platform/actions/runs/$RUN_ID")"
python3 -c '
import json, sys
expected_sha, expected_run, payload = sys.argv[1:]
run = json.loads(payload)
if (
    str(run.get("id")) != expected_run
    or run.get("head_sha") != expected_sha
    or run.get("name") != "ci"
    or run.get("conclusion") != "success"
):
    raise SystemExit(65)
' "$SHA" "$RUN_ID" "$RUN_JSON" || {
  echo "GitHub Actions evidence is not a successful main run" >&2
  exit 65
}
CI_RUN_URL="https://github.com/69755354/newme-platform/actions/runs/$RUN_ID"
CI_CONCLUSION=success

mkdir -p -m 0700 "$WORKTREE_ROOT"
WORKTREE="$(mktemp -d "$WORKTREE_ROOT/release.XXXXXX")"
cleanup() {
  git --git-dir="$MIRROR" worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf -- "$WORKTREE"
}
trap cleanup EXIT INT TERM

git --git-dir="$MIRROR" branch -f main "$MAIN_SHA"
rmdir "$WORKTREE"
git --git-dir="$MIRROR" worktree add --force "$WORKTREE" main >/dev/null
chown -R root:root "$WORKTREE"

# Systemd, sudo and observability assets are part of the immutable release
# boundary. Refresh them only from the verified root-owned main worktree.
bash "$WORKTREE/scripts/install-systemd-assets.sh"

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
NEWME_MANUAL_VERIFICATION=0 \
MIGRATION_STATUS="$MIGRATION_STATUS" \
MIGRATION_IDS="$MIGRATION_IDS" \
ROLLBACK_GIT_SHA="$ROLLBACK_SHA" \
bash "$WORKTREE/scripts/deploy-immutable.sh" "$SHA"
