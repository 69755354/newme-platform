#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHA="${RELEASE_SHA:-${1:-}}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "a full 40-character release SHA is required" >&2; exit 64; }
git -C "$ROOT" cat-file -e "$SHA^{commit}" 2>/dev/null || exit 65
PREFLIGHT_SHA="$(RELEASE_SHA="$SHA" bash "$ROOT/scripts/verify-release-preflight.sh")"
[ "$PREFLIGHT_SHA" = "$SHA" ] || { echo "release preflight SHA mismatch" >&2; exit 65; }

RELEASES="${NEWME_RELEASES_ROOT:-/opt/newme/releases}"
CURRENT="${NEWME_CURRENT_LINK:-/opt/newme/current}"
ROLLBACK="${NEWME_ROLLBACK_LINK:-/opt/newme/current.rollback}"
LOCK="${NEWME_DEPLOY_LOCK:-/run/lock/newme-deploy.lock}"
CONTROL="${NEWME_SERVICE_CONTROL:-/usr/local/sbin/newme-service-control}"
RUNTIME_ENV="${NEWME_RUNTIME_ENV:-/etc/newme/newme-runtime.env}"
FAILURE="${NEWME_DEPLOY_TEST_FAILURE:-}"
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

fail() { echo "deploy failed: $*" >&2; return 1; }

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
    ln -s "$PREVIOUS_ROLLBACK" "$ROLLBACK_NEXT"
    mv -Tf "$ROLLBACK_NEXT" "$ROLLBACK"
  else
    rm -f -- "$ROLLBACK"
  fi
  ROLLBACK_CHANGED=0
}

rollback_release() {
  [ "$SWITCHED" -eq 1 ] || return 0
  if [ -z "$PREVIOUS" ] || [ ! -d "$PREVIOUS" ]; then
    echo "rollback unavailable: previous release is missing" >&2
    return 1
  fi
  ln -s "$PREVIOUS" "$CURRENT_NEXT"
  mv -Tf "$CURRENT_NEXT" "$CURRENT"
  restore_rollback_link
  "$CONTROL" reset-failed "deploy:$ID:reset-before-rollback"
  "$CONTROL" restart "deploy:$ID:rollback"
  curl -fsS --max-time 10 http://127.0.0.1:3001/api/health >/dev/null
  SWITCHED=0
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  stop_candidate || rc=1
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
    rm -rf -- "$RELEASE" || rc=2
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

mkdir -p "$RELEASES"
exec 9>"$LOCK"
flock -n 9 || exit 75

case "$PREVIOUS" in "$RELEASES"/*) ;; *) fail "current is not an immutable release symlink"; exit 1;; esac
[ -d "$PREVIOUS" ] || { fail "current release is missing"; exit 1; }
[ ! -e "$RELEASE" ] || { fail "release already exists"; exit 1; }
[ -r "$PREVIOUS/.env.local" ] || { fail "current release environment is missing"; exit 1; }

for asset in /etc/systemd/system/newme-platform.service "$RUNTIME_ENV" /usr/local/libexec/newme/newme-readiness.sh /usr/local/sbin/newme-service-control /usr/local/sbin/newme-production-rollback /etc/cron.d/newme-observability /etc/logrotate.d/newme-forensic /etc/nginx/sites-enabled/newme-platform /opt/hermes-scripts/observability/health-check.sh /opt/hermes-scripts/observability/login-probe.sh /opt/hermes-scripts/observability/dependency-probe.sh /opt/hermes-scripts/observability/l0-composite-probe.sh; do
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
setsid node node_modules/next/dist/bin/next start -p 3002 >"/tmp/newme-candidate-$ID.log" 2>&1 &
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

printf 'protected_release=true\ngit_sha=%s\nbuild_id=%s\ncreated_at_utc=%s\n' \
  "$SHA" "$BUILD" "$(date -u +%Y%m%dT%H%M%SZ)" > "$STAGE/.newme-protect"
if [ "$(id -u)" -eq 0 ]; then
  chown -R ubuntu:ubuntu "$STAGE"
  chown root:root "$STAGE/.newme-protect"
fi
chmod -R a-w "$STAGE"
mv "$STAGE" "$RELEASE"
STAGE=""
CREATED_RELEASE=1
ln -s "$PREVIOUS" "$ROLLBACK_NEXT"
mv -Tf "$ROLLBACK_NEXT" "$ROLLBACK"
ROLLBACK_CHANGED=1
ln -s "$RELEASE" "$CURRENT_NEXT"
mv -Tf "$CURRENT_NEXT" "$CURRENT"
SWITCHED=1
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

python3 - "$EVIDENCE_FILE" "$SHA" "$BUILD" "$PREVIOUS" "$PREVIOUS_BUILD" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path, git_sha, build_id, previous, previous_build = sys.argv[1:]
evidence = {
    "git_sha": git_sha,
    "build_id": build_id,
    "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "release_status": "awaiting_uat",
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
    },
    "migration": {
        "status": os.environ["MIGRATION_STATUS"],
        "ids": [value for value in os.environ.get("MIGRATION_IDS", "").split(",") if value],
    },
    "rollback": {
        "git_sha": os.environ["ROLLBACK_GIT_SHA"],
        "build_id": previous_build,
        "backup_dir": previous,
    },
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(evidence, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

SWITCHED=0
ROLLBACK_CHANGED=0
CREATED_RELEASE=0
for old in "$RELEASES"/*; do
  [ -d "$old" ] || continue
  ROLLBACK_TARGET="$(readlink -f "$ROLLBACK" 2>/dev/null || true)"
  [ "$old" = "$TARGET" ] || [ "$old" = "$ROLLBACK_TARGET" ] || rm -rf -- "$old" || { fail "old release cleanup failed"; exit 1; }
done
echo "deployed SHA=$SHA BUILD_ID=$BUILD evidence=$EVIDENCE_FILE status=awaiting_uat"
