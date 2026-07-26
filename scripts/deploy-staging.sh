#!/usr/bin/env bash
set -Eeuo pipefail

SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "a full 40-character staging SHA is required" >&2; exit 64; }
[ "$(id -u)" -eq 0 ] || { echo "deploy-staging.sh must run as root" >&2; exit 77; }

ROOT="/opt/newme-staging"
RELEASES="$ROOT/releases"
INCOMING="$ROOT/incoming"
CURRENT="$ROOT/current"
BARE_REPO="$ROOT/repository.git"
ENV_FILE="/etc/newme-staging/staging.env"
BOUNDARY_CHECK="$ROOT/control/check-staging-boundaries.sh"
BRANCH="${NEWME_STAGING_BRANCH:-agent/saas-staging-isolation}"
LOCK="/run/lock/newme-staging-deploy.lock"
WINDOW_OVERRIDE="/run/newme-staging-window-override"
DEPLOY_KEY="/etc/newme-staging/github_deploy_key"
KNOWN_HOSTS="/etc/newme-staging/github_known_hosts"
ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
STAGE="$RELEASES/.staging-$ID"
RELEASE="$RELEASES/$SHA"
ARTIFACT="$INCOMING/$SHA.tar.gz"
CHECKSUM="$ARTIFACT.sha256"
CURRENT_NEXT="$CURRENT.next-$ID"
PREVIOUS="$(readlink -f "$CURRENT" 2>/dev/null || true)"
CANDIDATE_PID=""
CANDIDATE_PGID=""
SWITCHED=0

fail() {
  echo "staging deploy failed: $*" >&2
  exit 1
}

production_healthy() {
  curl -fsS --max-time 5 http://127.0.0.1:3001/api/health |
    grep -Eq '"status"[[:space:]]*:[[:space:]]*"(ok|healthy)"'
}

stop_candidate() {
  if [ -n "$CANDIDATE_PGID" ]; then
    kill -TERM -- "-$CANDIDATE_PGID" 2>/dev/null || true
    wait "$CANDIDATE_PID" 2>/dev/null || true
    CANDIDATE_PID=""
    CANDIDATE_PGID=""
  fi
}

rollback() {
  [ "$SWITCHED" -eq 1 ] || return 0
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    ln -s "$PREVIOUS" "$CURRENT_NEXT"
    mv -Tf "$CURRENT_NEXT" "$CURRENT"
    systemctl restart newme-staging.service
  else
    rm -f -- "$CURRENT"
    systemctl stop newme-staging.service
  fi
  SWITCHED=0
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  stop_candidate
  rm -f -- "$CURRENT_NEXT" 2>/dev/null || true
  if [ -d "$STAGE" ]; then
    rm -rf -- "$STAGE"
  fi
  if [ "$rc" -ne 0 ] && [ "$SWITCHED" -eq 1 ]; then
    rollback || rc=2
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

DUBAI_HOUR="$(TZ=Asia/Dubai date +%H)"
TODAY_UTC="$(date -u +%F)"
case "$DUBAI_HOUR" in
  00|01|02|03|04|05|18|19|20|21|22|23) ;;
  *)
    [ "$(cat "$WINDOW_OVERRIDE" 2>/dev/null || true)" = "$TODAY_UTC" ] ||
      fail "deploy window is 18:00-06:00 Asia/Dubai"
    echo "staging deploy running outside the normal Dubai window under date-bound no-active-users approval: $TODAY_UTC"
    ;;
esac

production_healthy || fail "production health is not green"
[ -r "$ENV_FILE" ] || fail "staging environment is missing"
[ -x "$BOUNDARY_CHECK" ] || fail "staging boundary check is missing"
[ -d "$BARE_REPO" ] || fail "canonical bare repository is missing"
[ -r "$DEPLOY_KEY" ] || fail "dedicated staging GitHub deploy key is missing"
[ -r "$KNOWN_HOSTS" ] || fail "dedicated GitHub known-hosts file is missing"
[ -f "$ARTIFACT" ] || fail "prebuilt staging artifact is missing"
[ -f "$CHECKSUM" ] || fail "prebuilt staging artifact checksum is missing"
[ ! -e "$RELEASE" ] || fail "release already exists"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "invalid staging branch"

mkdir -p "$RELEASES" "$INCOMING"
exec 9>"$LOCK"
flock -n 9 || exit 75

export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS"
git --git-dir="$BARE_REPO" fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
REMOTE_SHA="$(git --git-dir="$BARE_REPO" rev-parse "refs/remotes/origin/$BRANCH")"
[ "$SHA" = "$REMOTE_SHA" ] || fail "release SHA must equal canonical remote staging branch"

EXPECTED_CHECKSUM="$(tr -d '\r\n' < "$CHECKSUM")"
[[ "$EXPECTED_CHECKSUM" =~ ^[0-9a-f]{64}$ ]] || fail "artifact checksum must be lowercase SHA-256"
ACTUAL_CHECKSUM="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
[ "$ACTUAL_CHECKSUM" = "$EXPECTED_CHECKSUM" ] || fail "artifact checksum mismatch"

ARCHIVE_LIST="$(tar -tzf "$ARTIFACT")"
if printf '%s\n' "$ARCHIVE_LIST" |
  grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  fail "artifact contains an unsafe path"
fi
tar -tvzf "$ARTIFACT" |
  awk '$1 !~ /^[-d]/ { unsafe=1 } END { exit unsafe }' ||
  fail "artifact contains links or special files"

mkdir "$STAGE"
tar --no-same-owner --no-same-permissions -xzf "$ARTIFACT" -C "$STAGE"
[ -f "$STAGE/server.js" ] || fail "standalone server is missing"
[ -f "$STAGE/manifest.json" ] || fail "release manifest is missing"
[ -d "$STAGE/.next/static" ] || fail "standalone static assets are missing"
if find "$STAGE" -type f -name '.env*' -print -quit | grep -q .; then
  fail "artifact must not contain environment files"
fi

MANIFEST_SHA="$(
  node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!/^[0-9a-f]{40}$/.test(value.git_sha)) process.exit(1);
    process.stdout.write(value.git_sha);
  ' "$STAGE/manifest.json"
)" || fail "release manifest is invalid"
[ "$MANIFEST_SHA" = "$SHA" ] || fail "release manifest SHA does not match requested SHA"

env \
  NEWME_STAGING_PROJECT_REF="${NEWME_STAGING_PROJECT_REF:-}" \
  NEWME_STAGING_ENV_FILE="$ENV_FILE" \
  NEWME_STAGING_BOUNDARY_MODE=runtime \
  "$BOUNDARY_CHECK"
chown -R newme-staging:newme-staging "$STAGE"

production_healthy || fail "production health changed before candidate validation"
setsid runuser -u newme-staging -- env \
  NODE_ENV=production \
  PORT=3102 \
  HOSTNAME=127.0.0.1 \
  bash -lc "set -a; . '$ENV_FILE'; set +a; exec /usr/bin/node '$STAGE/server.js'" \
  >"/tmp/newme-staging-candidate-$ID.log" 2>&1 &
CANDIDATE_PID=$!
CANDIDATE_PGID=$CANDIDATE_PID

ready=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:3102/api/health |
    grep -Eq '"status"[[:space:]]*:[[:space:]]*"(ok|healthy)"'; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail "candidate health check failed"
stop_candidate

mv "$STAGE" "$RELEASE"
STAGE=""

ln -s "$RELEASE" "$CURRENT_NEXT"
mv -Tf "$CURRENT_NEXT" "$CURRENT"
SWITCHED=1
systemctl restart newme-staging.service
curl -fsS --max-time 10 http://127.0.0.1:3101/api/health |
  grep -Eq '"status"[[:space:]]*:[[:space:]]*"(ok|healthy)"' ||
  fail "post-switch staging health check failed"
production_healthy || fail "production health changed after staging switch"

SWITCHED=0
rm -f -- "$ARTIFACT" "$CHECKSUM"
echo "staging deployed SHA=$SHA"
