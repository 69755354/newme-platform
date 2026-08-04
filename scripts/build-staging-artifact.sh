#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SHA="${1:-}"
ENV_FILE="${2:-}"
OUTPUT_DIR="${3:-/output}"
EXPECTED_REF="${4:-${NEWME_STAGING_PROJECT_REF:-}}"
PROVENANCE_PATH="${5:-}"
HEAP_MB="${NEWME_STAGING_BUILD_HEAP_MB:-896}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly STAGING_ARCHIVE_PROVENANCE="/run/newme-staging-build.provenance"
readonly NODE_VERSION="24.18.0"
readonly NPM_VERSION="11.16.0"
readonly NODE_DIST="node-v${NODE_VERSION}-linux-x64"
readonly NODE_ARCHIVE="${NODE_DIST}.tar.xz"
readonly NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
readonly NODE_SHA256="55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742"
readonly TOOLCHAIN_CACHE="/opt/newme-staging/cache"
readonly NODE_ARCHIVE_PATH="${TOOLCHAIN_CACHE}/${NODE_ARCHIVE}"
readonly NODE_DIR="${TOOLCHAIN_CACHE}/${NODE_DIST}"
readonly TOOLCHAIN_LOCK="${TOOLCHAIN_CACHE}/.${NODE_DIST}.lock"
TOOLCHAIN_TEMP=""

fail() {
  echo "staging artifact build failed: $*" >&2
  exit 1
}

cleanup_toolchain_temp() {
  if [ -n "$TOOLCHAIN_TEMP" ] && [ -e "$TOOLCHAIN_TEMP" ]; then
    rm -rf -- "$TOOLCHAIN_TEMP"
  fi
}
trap cleanup_toolchain_temp EXIT
trap 'cleanup_toolchain_temp; exit 130' INT TERM

bootstrap_toolchain() {
  local actual_node=""
  local actual_npm=""

  [ -d "$TOOLCHAIN_CACHE" ] && [ -w "$TOOLCHAIN_CACHE" ] ||
    fail "toolchain cache is missing or not writable"
  for command in curl flock mktemp mv rm sha256sum tar; do
    command -v "$command" >/dev/null 2>&1 ||
      fail "required toolchain bootstrap command is unavailable: $command"
  done

  exec 8>"$TOOLCHAIN_LOCK"
  flock -n 8 || fail "toolchain cache is locked"

  if [ ! -f "$NODE_ARCHIVE_PATH" ]; then
    TOOLCHAIN_TEMP="$(mktemp "${TOOLCHAIN_CACHE}/.${NODE_ARCHIVE}.download.XXXXXX")"
    curl --fail --silent --show-error --location \
      --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 \
      "$NODE_URL" --output "$TOOLCHAIN_TEMP"
    printf '%s  %s\n' "$NODE_SHA256" "$TOOLCHAIN_TEMP" |
      sha256sum --check --status ||
      fail "downloaded Node archive SHA256 does not match the pinned official digest"
    chmod 0640 "$TOOLCHAIN_TEMP"
    mv -f -- "$TOOLCHAIN_TEMP" "$NODE_ARCHIVE_PATH"
    TOOLCHAIN_TEMP=""
  fi

  printf '%s  %s\n' "$NODE_SHA256" "$NODE_ARCHIVE_PATH" |
    sha256sum --check --status ||
    fail "cached Node archive SHA256 does not match the pinned official digest"

  if [ ! -d "$NODE_DIR" ]; then
    TOOLCHAIN_TEMP="$(mktemp -d "${TOOLCHAIN_CACHE}/.${NODE_DIST}.extract.XXXXXX")"
    if ! tar -xJf "$NODE_ARCHIVE_PATH" -C "$TOOLCHAIN_TEMP" \
      --no-same-owner --no-same-permissions; then
      fail "pinned Node archive extraction failed"
    fi
    [ -x "$TOOLCHAIN_TEMP/$NODE_DIST/bin/node" ] ||
      fail "pinned Node archive does not contain an executable node binary"
    [ -x "$TOOLCHAIN_TEMP/$NODE_DIST/bin/npm" ] ||
      fail "pinned Node archive does not contain an executable npm binary"
    mv -- "$TOOLCHAIN_TEMP/$NODE_DIST" "$NODE_DIR"
    rm -rf -- "$TOOLCHAIN_TEMP"
    TOOLCHAIN_TEMP=""
  fi

  export PATH="$NODE_DIR/bin:/usr/bin:/bin"
  [ "$(command -v node)" = "$NODE_DIR/bin/node" ] ||
    fail "pinned Node binary is not first on PATH"
  actual_node="$(node --version)" ||
    fail "unable to execute pinned Node"
  actual_npm="$(npm --version)" ||
    fail "unable to execute pinned npm"
  [ "$actual_node" = "v$NODE_VERSION" ] ||
    fail "Node version $actual_node does not equal pinned v$NODE_VERSION"
  [ "$actual_npm" = "$NPM_VERSION" ] ||
    fail "npm version $actual_npm does not equal pinned $NPM_VERSION"
}

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "a full 40-character staging SHA is required"
[[ "$EXPECTED_REF" =~ ^[a-z]{20}$ ]] || fail "an explicit 20-character staging project ref is required"
[ "$PROVENANCE_PATH" = "$STAGING_ARCHIVE_PROVENANCE" ] ||
  fail "the fixed staging archive provenance path is required"
[ "${NEWME_STAGING_ARCHIVE_PROVENANCE_PATH:-}" = "$STAGING_ARCHIVE_PROVENANCE" ] ||
  fail "staging archive provenance environment path drifted"
[ "${CI:-}" = "true" ] || fail "staging archive builds require CI=true"
[ "${NEWME_STAGING_EXPECTED_SHA:-}" = "$SHA" ] ||
  fail "staging archive candidate SHA drifted"
[ "${NEXT_PUBLIC_APP_VERSION:-}" = "$SHA" ] ||
  fail "staging application version drifted from the archive candidate"
[[ "${NEWME_STAGING_UPSTREAM_SHA:-}" =~ ^[0-9a-f]{40}$ ]] ||
  fail "staging archive upstream SHA is malformed"
[[ "${NEWME_STAGING_UPSTREAM_BLOB:-}" =~ ^[0-9a-f]{40}$ ]] ||
  fail "staging archive upstream blob is malformed"
[[ "${NEWME_STAGING_EXPECTED_TREE:-}" =~ ^[0-9a-f]{40}$ ]] ||
  fail "staging archive candidate tree is malformed"
[[ "${NEWME_STAGING_ARCHIVE_PROVENANCE_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] ||
  fail "staging archive provenance digest is malformed"
[ -f "$PROVENANCE_PATH" ] && [ ! -L "$PROVENANCE_PATH" ] ||
  fail "staging archive provenance must be a regular non-symlink file"
[ "$(stat -c '%u:%g:%a' "$PROVENANCE_PATH")" = "0:0:400" ] ||
  fail "staging archive provenance must be root:root mode 0400"
[[ "$HEAP_MB" =~ ^[0-9]+$ ]] || fail "build heap must be an integer number of MiB"
[ "$HEAP_MB" -ge 768 ] && [ "$HEAP_MB" -le 1152 ] ||
  fail "build heap must stay between 768 and 1152 MiB"
[ -r "$ENV_FILE" ] || fail "a readable public-only staging build environment is required"
mkdir -p "$OUTPUT_DIR"

export NEWME_STAGING_PROJECT_REF="$EXPECTED_REF"
export NEWME_STAGING_BOUNDARY_MODE=build
export NEWME_STAGING_ENV_FILE="$ENV_FILE"
export NODE_OPTIONS="--max_old_space_size=$HEAP_MB"

cd "$ROOT"
bootstrap_toolchain
node scripts/check-toolchain.mjs
npm ci --no-audit --no-fund
npm run check:staging-boundaries
npm run typecheck
npm run check:security
npm run lint:baseline
npm test
npm run check:supply-chain -- --accept-known
# The checked file contains only public build-time values; runtime secrets stay on
# the staging host and are loaded by systemd after the artifact is transferred.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
export NEWME_ISOLATED_BUILD=1
export NEWME_STANDALONE_BUILD=1
export NEWME_STAGING_LOW_MEMORY=0
export NEXT_PUBLIC_APP_VERSION="$SHA"
unset ANALYZE
npm run build -- --turbopack

STANDALONE="$ROOT/.next/standalone"
[ -f "$STANDALONE/server.js" ] || fail "standalone server is missing"
cp -a "$ROOT/public" "$STANDALONE/public"
mkdir -p "$STANDALONE/.next"
cp -a "$ROOT/.next/static" "$STANDALONE/.next/static"
printf '{"git_sha":"%s","created_at":"%s"}\n' \
  "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STANDALONE/manifest.json"
chmod 0644 "$STANDALONE/manifest.json"

ARTIFACT="$OUTPUT_DIR/$SHA.tar.gz"
CHECKSUM="$ARTIFACT.sha256"
# Turbopack standalone output may contain internal package symlinks. Materialize
# their contents so the immutable release archive contains only regular files
# and directories and continues to satisfy the deployer's fail-closed policy.
tar --dereference -C "$STANDALONE" -czf "$ARTIFACT" .
sha256sum "$ARTIFACT" | awk '{print $1}' > "$CHECKSUM"
echo "staging artifact built SHA=$SHA artifact=$ARTIFACT"
