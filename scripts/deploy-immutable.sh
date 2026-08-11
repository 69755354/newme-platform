#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHA="${RELEASE_SHA:-${1:-}}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "a full 40-character release SHA is required" >&2; exit 64; }

RELEASES="${NEWME_RELEASES_ROOT:-/opt/newme/releases}"
CURRENT="${NEWME_CURRENT_LINK:-/opt/newme/current}"
ROLLBACK="${NEWME_ROLLBACK_LINK:-/opt/newme/current.rollback}"
LOCK="${NEWME_DEPLOY_LOCK:-/run/lock/newme-deploy.lock}"
CONTROL="${NEWME_SERVICE_CONTROL:-/usr/local/sbin/newme-service-control}"
RUNTIME_ENV="${NEWME_RUNTIME_ENV:-/etc/newme/newme-runtime.env}"
FAILURE="${NEWME_DEPLOY_TEST_FAILURE:-}"
EXPECTED_ROLLBACK_SHA="${ROLLBACK_GIT_SHA:-}"
ASSET_BACKUP="${NEWME_ASSET_BACKUP:-}"
DEPLOY_STATE_RECORD="${NEWME_DEPLOY_STATE_RECORD:-}"
DEPLOY_STATE_TMP=""
OWN_DEPLOY_STATE_RECORD=0
PARENT_DEPLOY_STATE_RECORD=0
ASSET_BACKUP_TRUSTED=0
STATE_ROOT=/var/lib/newme/deploy-state
PENDING_ASSET_RECORD="$STATE_ROOT/systemd-assets.pending"
PENDING_ASSET_CLEARED=0
APP_WAS_SWITCHED=0
ASSETS_ROLLED_BACK=0
ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
STAGE="$RELEASES/.staging-$ID"
RELEASE="$RELEASES/$SHA"
CURRENT_NEXT="$CURRENT.next-$ID"
ROLLBACK_NEXT="$ROLLBACK.next-$ID"
PREVIOUS="$(readlink -f "$CURRENT" 2>/dev/null || true)"
PREVIOUS_ROLLBACK="$(readlink -f "$ROLLBACK" 2>/dev/null || true)"
PREVIOUS_BUILD="$(tr -d '\r\n' < "$CURRENT/.next/BUILD_ID" 2>/dev/null || true)"
EVIDENCE_DIR="${NEWME_EVIDENCE_DIR:-}"
EVIDENCE_FILE=""
REGRESSION_FILE=""
PID=""
PGID=""
READINESS_CONFIG=""
SWITCHED=0
ROLLBACK_CHANGED=0
CREATED_RELEASE=0
CANDIDATE_REMOVAL_VERIFIED=1

fail() { echo "deploy failed: $*" >&2; return 1; }

# ── Release-claim validation ────────────────────────────────────────────────
#
# The evidence file written at the end of this script records a CI result and a
# migration result. Everything else in that file is MEASURED here — the release
# manifest, BUILD_ID, systemd invocation id, health, smoke, logs, regression —
# but the ci.* and migration.* blocks were read straight out of the environment
# and serialised verbatim:
#
#     "ci":        { "run_id": os.environ["CI_RUN_ID"], ...
#                    "conclusion": os.environ["CI_CONCLUSION"] },
#     "migration": { "status": os.environ["MIGRATION_STATUS"], ... }
#
# Nothing checked that CI_HEAD_SHA was the SHA being deployed, that
# CI_CONCLUSION said success, that CI_RUN_URL pointed at CI_RUN_ID, or that a
# MIGRATION_STATUS of "applied" came with any migration ids. So
# `CI_CONCLUSION=success CI_HEAD_SHA=$(git rev-parse HEAD~20) MIGRATION_STATUS=applied`
# produced a fully green, permanently archived audit record for a release whose
# CI had never run — the exact false-green class this repo already booked as
# F-05. Presence was enforced only incidentally, by KeyError.
#
# The canonical wrapper, infra/systemd/newme-deploy.sh, does query the GitHub API
# and check the run's id, head_sha, name and conclusion — that part of the review
# finding is refuted for that entry point. But this script is also the target of
# scripts/deploy.sh, which passes nothing but environment variables and performs
# no verification at all. Every check below therefore has to exist here, at the
# layer that actually writes the record.
#
# These claims cannot be re-measured here (no network, by design), so they are
# validated for internal consistency and for agreement with the SHA actually
# being deployed. A claim that cannot be checked is not accepted as a default:
# every variable is required, and the deploy aborts before it touches anything.
validate_release_claims() {
  local run_id="${CI_RUN_ID:-}" run_url="${CI_RUN_URL:-}" head_sha="${CI_HEAD_SHA:-}"
  local conclusion="${CI_CONCLUSION:-}" event="${CI_EVENT:-}"
  local migration_status="${MIGRATION_STATUS:-}" migration_ids="${MIGRATION_IDS:-}"

  [ -n "$run_id" ]           || { echo "CI_RUN_ID is required" >&2; return 1; }
  [ -n "$run_url" ]          || { echo "CI_RUN_URL is required" >&2; return 1; }
  [ -n "$head_sha" ]         || { echo "CI_HEAD_SHA is required" >&2; return 1; }
  [ -n "$conclusion" ]       || { echo "CI_CONCLUSION is required" >&2; return 1; }
  [ -n "$event" ]            || { echo "CI_EVENT is required" >&2; return 1; }
  [ -n "$migration_status" ] || { echo "MIGRATION_STATUS is required" >&2; return 1; }

  [[ "$run_id" =~ ^[0-9]+$ ]] ||
    { echo "CI_RUN_ID must be a numeric GitHub run id" >&2; return 1; }

  # The URL must name the same run id, so the archived link cannot point at a
  # different (green) run than the one being claimed.
  [[ "$run_url" =~ ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/actions/runs/${run_id}(/job/[0-9]+)?$ ]] ||
    { echo "CI_RUN_URL must be the github.com actions run URL for CI_RUN_ID" >&2; return 1; }

  # The claim has to be about the commit being deployed. This is the check whose
  # absence made every other one decorative.
  [ "$head_sha" = "$SHA" ] ||
    { echo "CI_HEAD_SHA does not match the release SHA being deployed" >&2; return 1; }

  [ "$conclusion" = success ] ||
    { echo "CI_CONCLUSION must be 'success' (got: $conclusion)" >&2; return 1; }

  # Wrong-event claims: a pull_request run tests the merge commit, not this SHA,
  # and a workflow_run/schedule run proves nothing about it either.
  #
  # `push` was accepted here until this revision, and that made the two layers
  # disagree in the direction that mattered. infra/release/required-jobs.json
  # requires the "Release-final taskboard completion" job, which .github/workflows/ci.yml
  # gates on `github.event_name == 'workflow_dispatch' && inputs.release_final`,
  # so a push run cannot carry the required set at all. Accepting `push` here
  # meant this layer would archive as complete a claim the wrapper can no longer
  # produce.
  [ "$event" = workflow_dispatch ] ||
    { echo "CI_EVENT must be 'workflow_dispatch' (got: $event)" >&2; return 1; }

  # Values are the ones infra/systemd/newme-deploy.sh accepts on its command
  # line, so the two layers cannot disagree about what a valid claim looks like.
  case "$migration_status" in
    applied_verified)
      [ -n "$migration_ids" ] ||
        { echo "MIGRATION_STATUS=applied_verified requires MIGRATION_IDS" >&2; return 1; }
      [[ "$migration_ids" =~ ^[0-9A-Za-z_.-]+(,[0-9A-Za-z_.-]+)*$ ]] ||
        { echo "MIGRATION_IDS must be a comma-separated list of migration ids" >&2; return 1; }
      ;;
    not_required)
      [ -z "$migration_ids" ] ||
        { echo "MIGRATION_STATUS=not_required must not carry MIGRATION_IDS" >&2; return 1; }
      ;;
    *)
      echo "MIGRATION_STATUS must be 'applied_verified' or 'not_required' (got: $migration_status)" >&2
      return 1
      ;;
  esac
}

# Validated before any staging directory, symlink, service action or asset
# backup exists, so a bad claim costs nothing.
validate_release_claims || { echo "deploy failed: release claims rejected" >&2; exit 64; }

load_pending_asset_backup() {
  local pending_sha="" pending_backup="" pending_previous="" pending_previous_rollback=""
  [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || return 1
  [ "$(stat -c '%U:%G' "$STATE_ROOT")" = root:root ] || return 1
  [ "$(stat -c '%a' "$STATE_ROOT")" = 700 ] || return 1
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
  pending_previous="$(sed -n 's/^previous=//p' "$PENDING_ASSET_RECORD")"
  pending_previous_rollback="$(sed -n 's/^previous_rollback=//p' "$PENDING_ASSET_RECORD")"
  if [ -n "$ASSET_BACKUP" ]; then
    [ "$ASSET_BACKUP" = "$pending_backup" ] || return 1
  else
    ASSET_BACKUP="$pending_backup"
  fi
  case "$ASSET_BACKUP" in
    /var/backups/newme-systemd-assets/*) ;;
    *) return 1 ;;
  esac
  [ -d "$ASSET_BACKUP/rootfs" ] &&
    [ -f "$ASSET_BACKUP/managed.list" ] &&
    [ -f "$ASSET_BACKUP/present.list" ] &&
    [ -f "$ASSET_BACKUP/manifest.sha256" ] &&
    [ -f "$ASSET_BACKUP/symlink.sha256" ] || return 1
  ASSET_BACKUP_TRUSTED=1
  [ "$pending_previous" = "$PREVIOUS" ] || return 1
  [ "$pending_previous_rollback" = "$PREVIOUS_ROLLBACK" ] || return 1
  [ "$pending_sha" = "$SHA" ] || return 1
}
clear_matching_pending_asset_record() {
  if [ ! -e "$PENDING_ASSET_RECORD" ] && [ ! -L "$PENDING_ASSET_RECORD" ]; then
    PENDING_ASSET_CLEARED=1
    return 0
  fi
  load_pending_asset_backup || return 1
  rm -f -- "$PENDING_ASSET_RECORD" || return 1
  sync -f "$STATE_ROOT" || return 1
  PENDING_ASSET_CLEARED=1
}

# The production host may still be running the previous canonical wrapper on
# the first deployment of this protocol. Arm an early asset rollback before
# parsing or validating its pending pointer and before creating the child state
# record so a setup failure cannot strand the newly installed assets.
if [ -n "$DEPLOY_STATE_RECORD" ]; then
  PARENT_DEPLOY_STATE_RECORD=1
fi
early_asset_cleanup() {
  local rc=$?
  trap - EXIT HUP INT TERM
  if [ "$rc" -ne 0 ] && [ "$PARENT_DEPLOY_STATE_RECORD" -eq 0 ]; then
    if [ "$ASSET_BACKUP_TRUSTED" -eq 0 ]; then
      load_pending_asset_backup >/dev/null 2>&1 || true
    fi
    if [ "$ASSET_BACKUP_TRUSTED" -eq 1 ]; then
      echo "immutable deploy setup failed; restoring versioned assets from $ASSET_BACKUP" >&2
      if bash "$ROOT/scripts/rollback-systemd-assets.sh" "$ASSET_BACKUP"; then
        rm -f -- "$PENDING_ASSET_RECORD" || echo "CRITICAL: stale pending asset record could not be removed" >&2
      else
        echo "CRITICAL: early versioned asset rollback failed for $ASSET_BACKUP" >&2
      fi
    else
      echo "CRITICAL: pending versioned asset backup could not be validated; protected pointer retained" >&2
    fi
  fi
  if [ "$OWN_DEPLOY_STATE_RECORD" -eq 1 ] && [ -n "$DEPLOY_STATE_RECORD" ]; then
    rm -f -- "$DEPLOY_STATE_RECORD" 2>/dev/null || true
  fi
  exit "$rc"
}
trap early_asset_cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

load_pending_asset_backup || { fail "pending versioned asset backup is missing or stale"; exit 65; }
[[ "$EXPECTED_ROLLBACK_SHA" =~ ^[0-9a-f]{40}$ ]] || { fail "expected rollback SHA is missing"; exit 65; }
[ "$PREVIOUS" = "$RELEASES/$EXPECTED_ROLLBACK_SHA" ] || { fail "expected rollback SHA does not match current"; exit 65; }

if [ -z "$DEPLOY_STATE_RECORD" ]; then
  DEPLOY_STATE_RECORD="$(mktemp "$STATE_ROOT/deploy-state.XXXXXX")"
  OWN_DEPLOY_STATE_RECORD=1
  chmod 0600 "$DEPLOY_STATE_RECORD"
fi
case "$DEPLOY_STATE_RECORD" in
  "$STATE_ROOT"/deploy-state.*) ;;
  *) fail "protected deploy state record is missing"; exit 65 ;;
esac
[ -f "$DEPLOY_STATE_RECORD" ] && [ ! -L "$DEPLOY_STATE_RECORD" ] || { fail "deploy state record is invalid"; exit 65; }
[ "$(stat -c '%U:%G' "$DEPLOY_STATE_RECORD")" = root:root ] || { fail "deploy state record ownership is invalid"; exit 65; }
[ "$(stat -c '%a' "$DEPLOY_STATE_RECORD")" = 600 ] || { fail "deploy state record mode is invalid"; exit 65; }

write_deploy_state() {
  local state="$1"
  DEPLOY_STATE_TMP="${DEPLOY_STATE_RECORD}.tmp.$$"
  umask 077
  printf '%s\n' "$state" > "$DEPLOY_STATE_TMP" || return 1
  chown root:root "$DEPLOY_STATE_TMP" || return 1
  chmod 0600 "$DEPLOY_STATE_TMP" || return 1
  mv -f "$DEPLOY_STATE_TMP" "$DEPLOY_STATE_RECORD" || return 1
  DEPLOY_STATE_TMP=""
  sync -f "$STATE_ROOT" || return 1
}

deploy_state_is_complete() {
  [ "$(tr -d '\r\n' < "$DEPLOY_STATE_RECORD" 2>/dev/null || true)" = "complete=$SHA" ]
}

stop_candidate() {
  if [ -n "$PGID" ]; then
    kill -TERM -- "-$PGID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$PGID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    if ss -ltn "( sport = :3002 )" 2>/dev/null | grep -q :3002; then
      return 1
    fi
    PID=""
    PGID=""
  fi
}

restore_rollback_link() {
  if [ -n "$PREVIOUS_ROLLBACK" ] && [ -d "$PREVIOUS_ROLLBACK" ]; then
    ln -s "$PREVIOUS_ROLLBACK" "$ROLLBACK_NEXT" || return 1
    mv -Tf "$ROLLBACK_NEXT" "$ROLLBACK" || return 1
  else
    rm -f -- "$ROLLBACK" || return 1
  fi
  sync -f "$(dirname "$ROLLBACK")" || return 1
  ROLLBACK_CHANGED=0
}

rollback_release() {
  [ "$SWITCHED" -eq 1 ] || return 0
  if [ -z "$PREVIOUS" ] || [ ! -d "$PREVIOUS" ]; then
    echo "rollback unavailable: previous release is missing" >&2
    return 1
  fi
  write_deploy_state app_rollback_pending || return 1
  ln -s "$PREVIOUS" "$CURRENT_NEXT" || return 1
  mv -Tf "$CURRENT_NEXT" "$CURRENT" || return 1
  restore_rollback_link || return 1
  "$CONTROL" reset-failed "deploy:$ID:reset-before-rollback" || return 1
  "$CONTROL" restart "deploy:$ID:rollback" || return 1
  curl -fsS --max-time 10 http://127.0.0.1:3001/api/health >/dev/null || return 1
  SWITCHED=0
  write_deploy_state app_rolled_back || return 1
}

rollback_assets() {
  local current_release=""
  current_release="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  if [ "$current_release" = "$RELEASE" ]; then
    echo "CRITICAL: refusing to restore prior assets while the candidate release remains active" >&2
    return 1
  fi
  bash "$ROOT/scripts/rollback-systemd-assets.sh" "$ASSET_BACKUP" || return 1
  # Do not publish assets_rolled_back until the direct rollback release pointer
  # is also restored. Otherwise the parent could discard the only durable copy
  # of PREVIOUS_ROLLBACK after an interrupted application rollback.
  restore_rollback_link || return 1
  if [ "$APP_WAS_SWITCHED" -eq 1 ]; then
    "$CONTROL" reset-failed "deploy:$ID:asset-rollback-reset" || true
    "$CONTROL" restart "deploy:$ID:asset-rollback" || return 1
    curl -fsS --max-time 10 http://127.0.0.1:3001/api/health >/dev/null || return 1
  fi
  write_deploy_state assets_rolled_back || return 1
  rm -f -- "$PENDING_ASSET_RECORD" || return 1
  sync -f "$STATE_ROOT" || return 1
  PENDING_ASSET_CLEARED=1
  ASSETS_ROLLED_BACK=1
}

cleanup() {
  local rc=$?
  trap - EXIT HUP INT TERM
  if [ "$(readlink -f "$CURRENT" 2>/dev/null || true)" = "$RELEASE" ]; then
    SWITCHED=1
    APP_WAS_SWITCHED=1
  fi
  if deploy_state_is_complete; then
    SWITCHED=0
    ROLLBACK_CHANGED=0
    CREATED_RELEASE=0
    if ! clear_matching_pending_asset_record; then
      echo "CRITICAL: completed deployment pending asset pointer could not be cleared" >&2
      rc=2
    fi
  fi
  stop_candidate || rc=1
  [ -z "$DEPLOY_STATE_TMP" ] || rm -f -- "$DEPLOY_STATE_TMP" 2>/dev/null || true
  [ -n "$READINESS_CONFIG" ] && rm -f -- "$READINESS_CONFIG" 2>/dev/null || true
  rm -f -- "$CURRENT_NEXT" 2>/dev/null || true
  rm -f -- "$ROLLBACK_NEXT" 2>/dev/null || true
  [ -n "$STAGE" ] && [ -d "$STAGE" ] && rm -rf -- "$STAGE" || true
  if [ "$rc" -ne 0 ] && [ "$SWITCHED" -eq 1 ]; then
    rollback_release || rc=2
  fi
  if [ "$rc" -ne 0 ] && [ "$SWITCHED" -eq 0 ] && [ "$ROLLBACK_CHANGED" -eq 1 ]; then
    restore_rollback_link || rc=2
  fi
  if [ "$rc" -ne 0 ] &&
    [ "$CREATED_RELEASE" -eq 1 ] &&
    [ "$(readlink -f "$CURRENT" 2>/dev/null || true)" != "$RELEASE" ] &&
    [ "$(readlink -f "$ROLLBACK" 2>/dev/null || true)" != "$RELEASE" ]; then
    CANDIDATE_REMOVAL_VERIFIED=0
    rm -rf -- "$RELEASE" || rc=2
    if [ ! -e "$RELEASE" ] && [ ! -L "$RELEASE" ] && sync -f "$RELEASES"; then
      CANDIDATE_REMOVAL_VERIFIED=1
    else
      rc=2
    fi
  fi
  if [ "$rc" -ne 0 ] && ! deploy_state_is_complete &&
    [ "$ASSETS_ROLLED_BACK" -eq 0 ] && [ "$CANDIDATE_REMOVAL_VERIFIED" -eq 1 ]; then
    rollback_assets || rc=2
  fi
  if [ "$OWN_DEPLOY_STATE_RECORD" -eq 1 ] &&
    { { deploy_state_is_complete && [ "$PENDING_ASSET_CLEARED" -eq 1 ]; } || [ "$ASSETS_ROLLED_BACK" -eq 1 ]; }; then
    rm -f -- "$DEPLOY_STATE_RECORD"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

write_deploy_state prepared
git -C "$ROOT" cat-file -e "$SHA^{commit}" 2>/dev/null || exit 65
PREFLIGHT_SHA="$(RELEASE_SHA="$SHA" bash "$ROOT/scripts/verify-release-preflight.sh")"
[ "$PREFLIGHT_SHA" = "$SHA" ] || { fail "release preflight SHA mismatch"; exit 65; }

mkdir -p "$RELEASES"
exec 7>"$LOCK"
flock -n 7 || exit 75

case "$PREVIOUS" in "$RELEASES"/*) ;; *) fail "current is not an immutable release symlink"; exit 1;; esac
[ -d "$PREVIOUS" ] || { fail "current release is missing"; exit 1; }
if [ -n "$PREVIOUS_ROLLBACK" ]; then
  case "$PREVIOUS_ROLLBACK" in "$RELEASES"/*) ;; *) fail "rollback is not an immutable release symlink"; exit 1;; esac
  [[ "$(basename "$PREVIOUS_ROLLBACK")" =~ ^[0-9a-f]{40}$ ]] || { fail "rollback release SHA is invalid"; exit 1; }
  [ -d "$PREVIOUS_ROLLBACK" ] && [ ! -L "$PREVIOUS_ROLLBACK" ] &&
    [ -f "$PREVIOUS_ROLLBACK/.newme-protect" ] && [ -f "$PREVIOUS_ROLLBACK/.next/BUILD_ID" ] || {
    fail "rollback release is not protected and complete"
    exit 1
  }
fi
[ ! -e "$RELEASE" ] || { fail "release already exists"; exit 1; }
[ -r "$PREVIOUS/.env.local" ] || { fail "current release environment is missing"; exit 1; }

for asset in /etc/systemd/system/newme-platform.service "$RUNTIME_ENV" /usr/local/libexec/newme/newme-readiness.sh /usr/local/libexec/newme/newme-install-systemd-assets /usr/local/libexec/newme/newme-rollback-systemd-assets /usr/local/sbin/newme-service-control /usr/local/sbin/newme-production-rollback /etc/cron.d/newme-observability /etc/logrotate.d/newme-forensic /etc/nginx/sites-enabled/newme-platform /opt/hermes-scripts/observability/health-check.sh /opt/hermes-scripts/observability/login-probe.sh /opt/hermes-scripts/observability/dependency-probe.sh /opt/hermes-scripts/observability/l0-composite-probe.sh; do
  [ -e "$asset" ] || { fail "missing versioned release asset: $asset"; exit 1; }
done
FRAGMENT="$(systemctl show newme-platform.service -p FragmentPath --value 2>/dev/null || true)"
DROP_INS="$(systemctl show newme-platform.service -p DropInPaths --value 2>/dev/null || true)"
[ "$FRAGMENT" = /etc/systemd/system/newme-platform.service ] || { fail "unexpected FragmentPath"; exit 1; }
[ -z "$DROP_INS" ] || { fail "legacy drop-in ownership remains"; exit 1; }
grep -Fqx '*/2 * * * * ubuntu /usr/bin/flock -n /run/lock/newme-observability-l0.lock /opt/hermes-scripts/observability/l0-composite-probe.sh' /etc/cron.d/newme-observability || { fail "cron drift"; exit 1; }

[ "$FAILURE" != build ] || { fail "injected build failure"; exit 1; }
mkdir -p "$STAGE"
git -C "$ROOT" archive "$SHA" | tar -x -C "$STAGE"
install -m 0600 "$PREVIOUS/.env.local" "$STAGE/.env.local"
python3 "$STAGE/scripts/validate-production-config.py" \
  --release-env "$STAGE/.env.local" \
  --runtime-env "$RUNTIME_ENV" \
  --network
cd "$STAGE"
npm ci --no-audit --no-fund
[ -x node_modules/.bin/next ] || { fail "next missing"; exit 1; }
NEXT_PUBLIC_APP_VERSION="$SHA" SENTRY_RELEASE="$SHA" \
  NODE_OPTIONS="${NODE_OPTIONS:---max_old_space_size=2048}" npm run build
BUILD="$(tr -d '\r\n' < .next/BUILD_ID)"
[ -n "$BUILD" ] || { fail "BUILD_ID missing"; exit 1; }
printf '{"git_sha":"%s","build_id":"%s"}\n' "$SHA" "$BUILD" > manifest.json

[ "$FAILURE" != candidate ] || { fail "injected candidate failure"; exit 1; }
set -a
# shellcheck disable=SC1090
. "$RUNTIME_ENV"
set +a
[ -n "${NEWME_READINESS_TOKEN:-}" ] || { fail "readiness token missing"; exit 1; }
READINESS_CONFIG="$(mktemp "${TMPDIR:-/tmp}/newme-readiness.XXXXXX")"
chmod 600 "$READINESS_CONFIG"
printf 'header = "x-newme-readiness-token: %s"\n' "$NEWME_READINESS_TOKEN" >"$READINESS_CONFIG"
printf 'header = "Host: app.newme.ae"\nheader = "Origin: https://app.newme.ae"\nheader = "Content-Type: application/json"\n' >>"$READINESS_CONFIG"
setsid node node_modules/next/dist/bin/next start -p 3002 9>&- 7>&- >"/tmp/newme-candidate-$ID.log" 2>&1 &
PID=$!
PGID=$PID
ready=0
for _ in $(seq 1 30); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 --config "$READINESS_CONFIG" http://127.0.0.1:3002/api/ready || true)"
  if [ "$code" = 200 ]; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || { fail "candidate readiness failed"; exit 1; }
session_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
  --config "$READINESS_CONFIG" -X POST --data '{}' \
  http://127.0.0.1:3002/api/auth/session || true)"
[ "$session_code" = 400 ] || { fail "candidate production Origin boundary returned $session_code"; exit 1; }
auth_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
  http://127.0.0.1:3002/api/auth/me || true)"
[ "$auth_code" = 401 ] || { fail "candidate anonymous auth boundary returned $auth_code"; exit 1; }
for route in / /api/health; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:3002$route" || true)"
  case "$code" in 2??|3??) ;; *) fail "candidate $route returned $code"; exit 1;; esac
done
[ "$FAILURE" != cleanup ] || { fail "injected cleanup failure"; exit 1; }
stop_candidate || { fail "candidate cleanup failed"; exit 1; }

HOST_LOADAVG_FILE=/proc/loadavg \
HOST_LOAD_READER= \
HOST_LOAD_NPROC_BIN=/usr/bin/nproc \
HOST_LOAD_AWK_BIN=/usr/bin/awk \
HOST_LOAD_SLEEP_BIN=/usr/bin/sleep \
HOST_LOAD_SETTLE_INTERVAL_SECONDS=10 \
HOST_LOAD_SETTLE_TIMEOUT_SECONDS=120 \
HOST_LOAD_SETTLE_REQUIRED_SAMPLES=2 \
HOST_LOAD_SETTLE_THRESHOLD_PCT=90 \
  bash "$ROOT/scripts/wait-for-host-load.sh"

printf 'protected_release=true\ngit_sha=%s\nbuild_id=%s\ncreated_at_utc=%s\n' \
  "$SHA" "$BUILD" "$(date -u +%Y%m%dT%H%M%SZ)" > "$STAGE/.newme-protect"
if [ "$(id -u)" -eq 0 ]; then
  chown -R ubuntu:ubuntu "$STAGE"
  chown root:root "$STAGE/.newme-protect"
fi
chmod -R a-w "$STAGE"
mv "$STAGE" "$RELEASE"
CREATED_RELEASE=1
sync -f "$RELEASES"
STAGE=""
ln -s "$PREVIOUS" "$ROLLBACK_NEXT"
mv -Tf "$ROLLBACK_NEXT" "$ROLLBACK"
sync -f "$(dirname "$ROLLBACK")"
ROLLBACK_CHANGED=1
write_deploy_state switch_pending
ln -s "$RELEASE" "$CURRENT_NEXT"
mv -Tf "$CURRENT_NEXT" "$CURRENT"
sync -f "$(dirname "$CURRENT")"
SWITCHED=1
APP_WAS_SWITCHED=1
write_deploy_state switched
[ "$FAILURE" != switch ] || { fail "injected switch failure"; exit 1; }

"$CONTROL" reset-failed "deploy:$ID:reset-before-switch"
"$CONTROL" restart "deploy:$ID:switch"
TARGET="$(readlink -f "$CURRENT")"
[ "$TARGET" = "$RELEASE" ] || { fail "release symlink mismatch"; exit 1; }
grep -Fqx "{\"git_sha\":\"$SHA\",\"build_id\":\"$BUILD\"}" "$TARGET/manifest.json" || { fail "release manifest mismatch"; exit 1; }
[ "$(tr -d '\r\n' < "$TARGET/.next/BUILD_ID")" = "$BUILD" ] || { fail "BUILD_ID mismatch"; exit 1; }
curl -fsS --max-time 10 http://127.0.0.1:3001/api/health >/dev/null || { fail "post-switch health failed"; exit 1; }
bash "$TARGET/scripts/check-smoke.sh" http://127.0.0.1:3001
bash /opt/hermes-scripts/observability/l0-composite-probe.sh
INVOCATION_ID="$(systemctl show newme-platform.service -p InvocationID --value)"
[[ "$INVOCATION_ID" =~ ^[0-9a-f]{32}$ ]] || { fail "service invocation id missing"; exit 1; }
NEWME_INVOCATION_ID="$INVOCATION_ID" bash "$TARGET/scripts/check-logs.sh" "2 minutes ago"
if [ -z "$EVIDENCE_DIR" ]; then
  EVIDENCE_DIR="$TARGET/.audit"
  install -d -o root -g root -m 0700 "$EVIDENCE_DIR"
else
  mkdir -p "$EVIDENCE_DIR"
fi
EVIDENCE_FILE="$EVIDENCE_DIR/deploy-$ID.json"
REGRESSION_FILE="$EVIDENCE_DIR/crm-regression-$ID.json"
CRM_REGRESSION_RESULT_FILE="$REGRESSION_FILE" bash "$TARGET/scripts/deploy-verify.sh" --no-git

python3 - "$EVIDENCE_FILE" "$SHA" "$BUILD" "$PREVIOUS" "$PREVIOUS_BUILD" "$PREVIOUS_ROLLBACK" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path, git_sha, build_id, previous, previous_build, previous_rollback = sys.argv[1:]
evidence = {
    "git_sha": git_sha,
    "build_id": build_id,
    "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "release_status": "awaiting_uat",
    "candidate_preexisting": False,
    "build": {"status": "pass"},
    "systemd": {"status": "pass"},
    "smoke": {"status": "pass"},
    "logs": {"status": "pass"},
    "regression": {"status": "pass"},
    "health": {"status": "pass"},
    "ci": {
        "run_id": os.environ["CI_RUN_ID"],
        "run_url": os.environ["CI_RUN_URL"],
        "head_sha": os.environ["CI_HEAD_SHA"],
        "conclusion": os.environ["CI_CONCLUSION"],
        "event": os.environ["CI_EVENT"],
        # validate_release_claims() has already proved: run_url names run_id,
        # head_sha == the deployed SHA, conclusion == success, event is
        # workflow_dispatch, and migration status/ids agree with each other.
        # infra/systemd/newme-deploy.sh additionally proved, against the GitHub
        # API, that every job in infra/release/required-jobs.json concluded
        # success for this run.
        "claims_validated": True,
    },
    "migration": {
        "status": os.environ["MIGRATION_STATUS"],
        "ids": [value for value in os.environ.get("MIGRATION_IDS", "").split(",") if value],
    },
    "rollback": {
        "git_sha": os.environ["ROLLBACK_GIT_SHA"],
        "build_id": previous_build,
        "backup_dir": previous,
        "asset_backup": os.environ["NEWME_ASSET_BACKUP"],
        "previous_rollback": {
            "git_sha": previous_rollback.rsplit("/", 1)[-1] if previous_rollback else "",
            "backup_dir": previous_rollback,
        },
    },
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(evidence, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

for durable_evidence_path in "$EVIDENCE_FILE" "$REGRESSION_FILE" "$EVIDENCE_DIR"; do
  sync -f "$durable_evidence_path" || {
    fail "deployment evidence could not be flushed"
    exit 1
  }
done
write_deploy_state "complete=$SHA"
clear_matching_pending_asset_record || { fail "completed deployment pending asset pointer could not be cleared"; exit 1; }
SWITCHED=0
ROLLBACK_CHANGED=0
CREATED_RELEASE=0
for old in "$RELEASES"/*; do
  [ -d "$old" ] || continue
  ROLLBACK_TARGET="$(readlink -f "$ROLLBACK" 2>/dev/null || true)"
  [ "$old" = "$TARGET" ] || [ "$old" = "$ROLLBACK_TARGET" ] ||
    { [ -n "$PREVIOUS_ROLLBACK" ] && [ "$old" = "$PREVIOUS_ROLLBACK" ]; } ||
    rm -rf -- "$old" || echo "warning: old release cleanup failed: $old" >&2
done
echo "deployed SHA=$SHA BUILD_ID=$BUILD evidence=$EVIDENCE_FILE status=awaiting_uat"
