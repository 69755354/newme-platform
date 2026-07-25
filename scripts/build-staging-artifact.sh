#!/usr/bin/env bash
set -Eeuo pipefail

SHA="${1:-}"
ENV_FILE="${2:-}"
OUTPUT_DIR="${3:-/output}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
  echo "staging artifact build failed: $*" >&2
  exit 1
}

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "a full 40-character staging SHA is required"
[ -r "$ENV_FILE" ] || fail "a readable public-only staging build environment is required"
install -d -m 0750 "$OUTPUT_DIR"

export NEWME_STAGING_BOUNDARY_MODE=build
export NEWME_STAGING_ENV_FILE="$ENV_FILE"

cd "$ROOT"
npm ci --no-audit --no-fund
npm run check:staging-boundaries
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
export NODE_OPTIONS=--max_old_space_size=832
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
