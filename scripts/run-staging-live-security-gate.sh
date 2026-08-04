#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_REF="${1:-}"
RUNTIME_ENV_FILE="${2:-/etc/newme-staging/staging.env}"
PRODUCTION_REF="vfopmpxlhwzpxqegayew"
GATE_VERSION="sam78-product-rpc-allowlist-v5"

fail() {
  echo "staging live security gate failed: $*" >&2
  exit 1
}

[[ "$EXPECTED_REF" =~ ^[a-z]{20}$ ]] ||
  fail "expected project ref must be 20 lowercase letters"
[ "$EXPECTED_REF" != "$PRODUCTION_REF" ] ||
  fail "production Supabase ref is forbidden"
[ -r "$RUNTIME_ENV_FILE" ] || fail "staging runtime environment is missing"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v node >/dev/null 2>&1 || fail "node is required"

# shellcheck disable=SC1090
. "$RUNTIME_ENV_FILE"

[ "${NEWME_STAGING_PROJECT_REF:-}" = "$EXPECTED_REF" ] ||
  fail "NEWME_STAGING_PROJECT_REF does not match"
[ "${SUPABASE_PROJECT_REF:-}" = "$EXPECTED_REF" ] ||
  fail "SUPABASE_PROJECT_REF does not match"
[ "${NEXT_PUBLIC_SUPABASE_URL:-}" = "https://$EXPECTED_REF.supabase.co" ] ||
  fail "staging Supabase URL does not match"
[[ "${SUPABASE_SERVICE_ROLE_KEY:-}" =~ ^sb_secret_[A-Za-z0-9_-]+$ ]] ||
  fail "dedicated staging Supabase secret key is missing"
[ -z "${SUPABASE_DB_PASSWORD:-}" ] ||
  fail "database password is forbidden in staging runtime"
[ -z "${SUPABASE_PAT:-}" ] ||
  fail "Supabase PAT is forbidden in staging runtime"

OUTPUT="$(mktemp)"
trap 'rm -f -- "$OUTPUT"' EXIT

HTTP_CODE="$(
  printf 'header = "apikey: %s"\n' "$SUPABASE_SERVICE_ROLE_KEY" |
  curl \
    --config - \
    --silent \
    --show-error \
    --output "$OUTPUT" \
    --write-out '%{http_code}' \
    --request POST \
    --proto '=https' \
    --tlsv1.2 \
    --max-time 15 \
    --header 'Content-Type: application/json' \
    --data '{}' \
    "https://$EXPECTED_REF.supabase.co/rest/v1/rpc/security_definer_rpc_allowlist_gate"
)" || fail "cleanroom live gate request failed"

[ "$HTTP_CODE" = "200" ] ||
  fail "cleanroom live gate returned HTTP $HTTP_CODE"

node -e '
  const fs = require("fs");
  const expectedVersion = process.argv[2];
  const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (
    body === null ||
    typeof body !== "object" ||
    body.gate_version !== expectedVersion ||
    !Array.isArray(body.violations) ||
    body.violations.length !== 0
  ) process.exit(1);
' "$OUTPUT" "$GATE_VERSION" ||
  fail "cleanroom returned a stale gate or SECURITY DEFINER violations"

echo "staging live security gate passed project=$EXPECTED_REF version=$GATE_VERSION"

