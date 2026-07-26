#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "a full 40-character staging SHA is required" >&2
  exit 64
}
[ "$(id -u)" -eq 0 ] || {
  echo "run-staging-build.sh must run as root" >&2
  exit 77
}

ROOT="/opt/newme-staging"
REPOSITORY="$ROOT/repository.git"
BUILD_ROOT="$ROOT/build"
INCOMING="$ROOT/incoming"
PUBLIC_ENV="/etc/newme-staging/build.env"
DEPLOY_KEY="/etc/newme-staging/github_deploy_key"
KNOWN_HOSTS="/etc/newme-staging/github_known_hosts"
BRANCH="${NEWME_STAGING_BRANCH:-agent/saas-staging-isolation}"
EXPECTED_REF="${NEWME_STAGING_PROJECT_REF:-${SUPABASE_PROJECT_REF:-}}"
LOCK="/run/lock/newme-staging-build.lock"
WINDOW_OVERRIDE="/run/newme-staging-window-override"
WORK="$BUILD_ROOT/$SHA"
ARTIFACT="$INCOMING/$SHA.tar.gz"
CHECKSUM="$ARTIFACT.sha256"
BUILD_PID=""
BUILD_PGID=""

fail() {
  echo "staging build failed: $*" >&2
  exit 1
}

production_healthy() {
  curl -fsS --max-time 5 http://127.0.0.1:3001/api/health |
    grep -Eq '"status"[[:space:]]*:[[:space:]]*"(ok|healthy)"'
}

stop_build() {
  if [ -n "$BUILD_PGID" ]; then
    kill -TERM -- "-$BUILD_PGID" 2>/dev/null || true
    sleep 2
    kill -KILL -- "-$BUILD_PGID" 2>/dev/null || true
    wait "$BUILD_PID" 2>/dev/null || true
    BUILD_PID=""
    BUILD_PGID=""
  fi
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  stop_build
  if [ -d "$WORK" ]; then
    rm -rf -- "$WORK"
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
      fail "build window is 18:00-06:00 Asia/Dubai"
    echo "staging build running outside the normal Dubai window under date-bound no-active-users approval: $TODAY_UTC"
    ;;
esac

[[ "$EXPECTED_REF" =~ ^[a-z]{20}$ ]] ||
  fail "an explicit 20-character staging project ref is required"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "invalid staging branch"
production_healthy || fail "production health is not green"
[ -d "$REPOSITORY" ] || fail "isolated staging repository is missing"
[ -r "$PUBLIC_ENV" ] || fail "public-only staging build environment is missing"
[ -r "$DEPLOY_KEY" ] || fail "dedicated staging GitHub deploy key is missing"
[ -r "$KNOWN_HOSTS" ] || fail "dedicated GitHub known-hosts file is missing"
[ ! -e "$ARTIFACT" ] || fail "artifact already exists"
[ ! -e "$CHECKSUM" ] || fail "artifact checksum already exists"
[ ! -e "$WORK" ] || fail "build workspace already exists"

mkdir -p "$BUILD_ROOT" "$INCOMING"
exec 9>"$LOCK"
flock -n 9 || exit 75

export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS"
git --git-dir="$REPOSITORY" fetch origin \
  "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
REMOTE_SHA="$(git --git-dir="$REPOSITORY" rev-parse "refs/remotes/origin/$BRANCH")"
[ "$SHA" = "$REMOTE_SHA" ] ||
  fail "build SHA must equal the canonical remote staging branch"

mkdir "$WORK"
git --git-dir="$REPOSITORY" archive "$SHA" | tar -x -C "$WORK"
git -C "$WORK" init --quiet
git -C "$WORK" add --force --all
chown -R newme-staging:newme-staging "$WORK" "$INCOMING"

production_healthy || fail "production health changed before staging build"
setsid runuser -u newme-staging -- env -i \
  HOME="$ROOT" \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  XDG_CACHE_HOME="$ROOT/cache" \
  npm_config_cache="$ROOT/cache/npm" \
  NEWME_STAGING_PROJECT_REF="$EXPECTED_REF" \
  NEWME_STAGING_BUILD_HEAP_MB="${NEWME_STAGING_BUILD_HEAP_MB:-896}" \
  bash "$WORK/scripts/build-staging-artifact.sh" \
    "$SHA" "$PUBLIC_ENV" "$INCOMING" "$EXPECTED_REF" &
BUILD_PID=$!
BUILD_PGID=$BUILD_PID

while kill -0 "$BUILD_PID" 2>/dev/null; do
  if ! production_healthy; then
    stop_build
    fail "production health changed during staging build"
  fi
  sleep 5
done

build_rc=0
wait "$BUILD_PID" || build_rc=$?
BUILD_PID=""
BUILD_PGID=""
[ "$build_rc" -eq 0 ] || fail "isolated staging build exited with status $build_rc"
[ -f "$ARTIFACT" ] || fail "staging artifact was not produced"
[ -f "$CHECKSUM" ] || fail "staging artifact checksum was not produced"

chown root:root "$ARTIFACT" "$CHECKSUM"
chmod 0640 "$ARTIFACT" "$CHECKSUM"
production_healthy || fail "production health changed after staging build"
echo "staging artifact ready SHA=$SHA artifact=$ARTIFACT"
