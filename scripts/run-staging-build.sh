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
PROVENANCE="/run/newme-staging-build.provenance"
PROVENANCE_TEMP=""
PROVENANCE_CREATED=0
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

restore_archive_gitlinks() {
  local candidate_sha="$1"
  local entry=""
  local metadata=""
  local entry_mode=""
  local entry_type=""
  local entry_object=""
  local entry_path=""

  while IFS= read -r -d '' entry; do
    metadata="${entry%%$'\t'*}"
    entry_path="${entry#*$'\t'}"
    IFS=' ' read -r entry_mode entry_type entry_object <<< "$metadata"
    [ "$entry_mode" = "160000" ] || continue
    [ "$entry_type" = "commit" ] ||
      fail "canonical gitlink tree entry has an unexpected object type"
    [[ "$entry_object" =~ ^[0-9a-f]{40}$ ]] ||
      fail "canonical gitlink object is malformed"
    [ -n "$entry_path" ] || fail "canonical gitlink path is empty"
    git -C "$WORK" update-index --add --cacheinfo \
      "$entry_mode" "$entry_object" "$entry_path"
  done < <(git --git-dir="$REPOSITORY" ls-tree -rz --full-tree "$candidate_sha")
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  stop_build
  if [ "$PROVENANCE_CREATED" -eq 1 ]; then
    rm -f -- "$PROVENANCE"
  fi
  if [ -n "$PROVENANCE_TEMP" ]; then
    rm -f -- "$PROVENANCE_TEMP"
  fi
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
if [ -e "$PROVENANCE" ] || [ -L "$PROVENANCE" ]; then
  fail "staging archive provenance path is not clean"
fi

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
restore_archive_gitlinks "$SHA"

REGISTRY="$WORK/docs/v4-frontend-increment/contracts/v4-id-registry.v1.json"
[ -f "$REGISTRY" ] && [ ! -L "$REGISTRY" ] ||
  fail "V4 canonical source registry is missing from the archive"
UPSTREAM_SHA="$(
  sed -n '/"canonical_source"[[:space:]]*:/,/^[[:space:]]*}/ {
    s/.*"commit"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p
  }' "$REGISTRY"
)"
UPSTREAM_PATH="$(
  sed -n '/"canonical_source"[[:space:]]*:/,/^[[:space:]]*}/ {
    s/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p
  }' "$REGISTRY"
)"
UPSTREAM_BLOB="$(
  sed -n '/"canonical_source"[[:space:]]*:/,/^[[:space:]]*}/ {
    s/.*"blob"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p
  }' "$REGISTRY"
)"
[[ "$UPSTREAM_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  fail "V4 canonical upstream commit is malformed"
[[ "$UPSTREAM_PATH" =~ ^[A-Za-z0-9._/-]+$ ]] ||
  fail "V4 canonical upstream path is malformed"
[[ "$UPSTREAM_BLOB" =~ ^[0-9a-f]{40}$ ]] ||
  fail "V4 canonical upstream blob is malformed"
git --git-dir="$REPOSITORY" merge-base --is-ancestor "$UPSTREAM_SHA" "$SHA" ||
  fail "V4 canonical upstream is not an ancestor of the staging SHA"
ACTUAL_UPSTREAM_BLOB="$(
  git --git-dir="$REPOSITORY" rev-parse "$UPSTREAM_SHA:$UPSTREAM_PATH"
)"
[ "$ACTUAL_UPSTREAM_BLOB" = "$UPSTREAM_BLOB" ] ||
  fail "V4 canonical upstream blob does not match the registry"
EXPECTED_TREE="$(git --git-dir="$REPOSITORY" rev-parse "$SHA^{tree}")"
ARCHIVE_TREE="$(git -C "$WORK" write-tree)"
[[ "$EXPECTED_TREE" =~ ^[0-9a-f]{40}$ ]] ||
  fail "staging candidate tree is malformed"
[ "$ARCHIVE_TREE" = "$EXPECTED_TREE" ] ||
  fail "staging archive tree does not match the candidate commit"

chown -R newme-staging:newme-staging "$WORK" "$INCOMING"

PROVENANCE_TEMP="$(mktemp /run/.newme-staging-build.provenance.XXXXXX)"
printf 'candidate_sha=%s\nupstream_sha=%s\nupstream_blob=%s\ntree_sha=%s\n' \
  "$SHA" "$UPSTREAM_SHA" "$UPSTREAM_BLOB" "$EXPECTED_TREE" > "$PROVENANCE_TEMP"
chown root:root "$PROVENANCE_TEMP"
chmod 0400 "$PROVENANCE_TEMP"
PROVENANCE_SHA256="$(sha256sum "$PROVENANCE_TEMP" | awk '{print $1}')"
[[ "$PROVENANCE_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
  fail "staging archive provenance digest is malformed"
mv -T -- "$PROVENANCE_TEMP" "$PROVENANCE"
PROVENANCE_TEMP=""
PROVENANCE_CREATED=1

production_healthy || fail "production health changed before staging build"
setsid runuser -u newme-staging --group newme-staging --supp-group docker -- env -i \
  CI=true \
  HOME="$ROOT" \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  XDG_CACHE_HOME="$ROOT/cache" \
  npm_config_cache="$ROOT/cache/npm" \
  NEXT_PUBLIC_APP_VERSION="$SHA" \
  NEWME_STAGING_EXPECTED_SHA="$SHA" \
  NEWME_STAGING_UPSTREAM_SHA="$UPSTREAM_SHA" \
  NEWME_STAGING_UPSTREAM_BLOB="$UPSTREAM_BLOB" \
  NEWME_STAGING_EXPECTED_TREE="$EXPECTED_TREE" \
  NEWME_STAGING_ARCHIVE_PROVENANCE_PATH="$PROVENANCE" \
  NEWME_STAGING_ARCHIVE_PROVENANCE_SHA256="$PROVENANCE_SHA256" \
  NEWME_STAGING_PROJECT_REF="$EXPECTED_REF" \
  NEWME_STAGING_BUILD_HEAP_MB="${NEWME_STAGING_BUILD_HEAP_MB:-896}" \
  bash "$WORK/scripts/build-staging-artifact.sh" \
    "$SHA" "$PUBLIC_ENV" "$INCOMING" "$EXPECTED_REF" "$PROVENANCE" &
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
