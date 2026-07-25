#!/usr/bin/env bash
set -Eeuo pipefail

SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "a full 40-character staging SHA is required" >&2; exit 64; }
[ "$(id -u)" -eq 0 ] || { echo "deploy-staging.sh must run as root" >&2; exit 77; }

ROOT="/opt/newme-staging"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
BARE_REPO="/opt/newme/repository.git"
ENV_FILE="/etc/newme-staging/staging.env"
BRANCH="${NEWME_STAGING_BRANCH:-staging}"
LOCK="/run/lock/newme-staging-deploy.lock"
DEPLOY_KEY="/home/ubuntu/.ssh/newme_github_deploy_key"
ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
STAGE="$RELEASES/.staging-$ID"
RELEASE="$RELEASES/$SHA"
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
  [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ] || return 1
  ln -s "$PREVIOUS" "$CURRENT_NEXT"
  mv -Tf "$CURRENT_NEXT" "$CURRENT"
  systemctl restart newme-staging.service
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
case "$DUBAI_HOUR" in
  00|01|02|03|04|05|18|19|20|21|22|23) ;;
  *) fail "build window is 18:00-06:00 Asia/Dubai" ;;
esac

production_healthy || fail "production health is not green"
[ -r "$ENV_FILE" ] || fail "staging environment is missing"
[ -d "$BARE_REPO" ] || fail "canonical bare repository is missing"
[ -r "$DEPLOY_KEY" ] || fail "GitHub deploy key is missing"
[ ! -e "$RELEASE" ] || fail "release already exists"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "invalid staging branch"

mkdir -p "$RELEASES"
exec 9>"$LOCK"
flock -n 9 || exit 75

export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
git --git-dir="$BARE_REPO" fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
REMOTE_SHA="$(git --git-dir="$BARE_REPO" rev-parse "refs/remotes/origin/$BRANCH")"
[ "$SHA" = "$REMOTE_SHA" ] || fail "release SHA must equal canonical remote staging branch"

mkdir "$STAGE"
git --git-dir="$BARE_REPO" archive "$SHA" | tar -x -C "$STAGE"
install -m 0600 -o newme-staging -g newme-staging "$ENV_FILE" "$STAGE/.env.local"
chown -R newme-staging:newme-staging "$STAGE"

runuser -u newme-staging -- env \
  NEWME_ISOLATED_BUILD=1 \
  NEWME_STANDALONE_BUILD=1 \
  NEXT_PUBLIC_APP_VERSION="$SHA" \
  NEWME_STAGING_ENV_FILE="$STAGE/.env.local" \
  NODE_OPTIONS=--max_old_space_size=1152 \
  bash -lc "cd '$STAGE' && npm ci --no-audit --no-fund && npm run check:staging-boundaries && npm run build"

STANDALONE="$STAGE/.next/standalone"
[ -f "$STANDALONE/server.js" ] || fail "standalone server is missing"
cp -a "$STAGE/public" "$STANDALONE/public"
mkdir -p "$STANDALONE/.next"
cp -a "$STAGE/.next/static" "$STANDALONE/.next/static"
printf '{"git_sha":"%s","created_at":"%s"}\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STANDALONE/manifest.json"
rm -f -- "$STAGE/.env.local"

production_healthy || fail "production health changed during staging build"
setsid runuser -u newme-staging -- env \
  NODE_ENV=production \
  PORT=3102 \
  HOSTNAME=127.0.0.1 \
  bash -lc "set -a; . '$ENV_FILE'; set +a; exec /usr/bin/node '$STANDALONE/server.js'" \
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

RELEASE_STAGE="$RELEASES/.release-$ID"
mv "$STANDALONE" "$RELEASE_STAGE"
rm -rf -- "$STAGE"
STAGE=""
mv "$RELEASE_STAGE" "$RELEASE"
chown -R newme-staging:newme-staging "$RELEASE"

ln -s "$RELEASE" "$CURRENT_NEXT"
mv -Tf "$CURRENT_NEXT" "$CURRENT"
SWITCHED=1
systemctl restart newme-staging.service
curl -fsS --max-time 10 http://127.0.0.1:3101/api/health |
  grep -Eq '"status"[[:space:]]*:[[:space:]]*"(ok|healthy)"' ||
  fail "post-switch staging health check failed"
production_healthy || fail "production health changed after staging switch"

SWITCHED=0
echo "staging deployed SHA=$SHA"
