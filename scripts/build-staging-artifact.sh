#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SHA="${1:-}"
ENV_FILE="${2:-}"
OUTPUT_DIR="${3:-/output}"
EXPECTED_REF="${4:-${NEWME_STAGING_PROJECT_REF:-}}"
HEAP_MB="${NEWME_STAGING_BUILD_HEAP_MB:-960}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
  echo "staging artifact build failed: $*" >&2
  exit 1
}

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "a full 40-character staging SHA is required"
[[ "$EXPECTED_REF" =~ ^[a-z]{20}$ ]] || fail "an explicit 20-character staging project ref is required"
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
export NEWME_STAGING_LOW_MEMORY=1
export NEXT_PUBLIC_APP_VERSION="$SHA"
npm run build -- --webpack

STANDALONE="$ROOT/.next/standalone"
[ -f "$STANDALONE/server.js" ] || fail "standalone server is missing"
cp -a "$ROOT/public" "$STANDALONE/public"
mkdir -p "$STANDALONE/.next"
cp -a "$ROOT/.next/static" "$STANDALONE/.next/static"
printf '{"git_sha":"%s","created_at":"%s"}\n' \
  "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STANDALONE/manifest.json"

ARTIFACT="$OUTPUT_DIR/$SHA.tar.gz"
CHECKSUM="$ARTIFACT.sha256"
tar -C "$STANDALONE" -czf "$ARTIFACT" .
sha256sum "$ARTIFACT" | awk '{print $1}' > "$CHECKSUM"
echo "staging artifact built SHA=$SHA artifact=$ARTIFACT"
