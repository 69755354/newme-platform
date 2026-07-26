#!/usr/bin/env bash
set -Eeuo pipefail

SQL_FILE="${1:-}"
EXPECTED_REF="${2:-}"
ENV_FILE="${3:-/etc/newme-staging/staging.env}"
PRODUCTION_REF="vfopmpxlhwzpxqegayew"

fail() {
  echo "staging live security gate failed: $*" >&2
  exit 1
}

[[ "$EXPECTED_REF" =~ ^[a-z]{20}$ ]] ||
  fail "expected project ref must be 20 lowercase letters"
[ "$EXPECTED_REF" != "$PRODUCTION_REF" ] ||
  fail "production Supabase ref is forbidden"
[ -r "$SQL_FILE" ] || fail "reviewed live gate SQL is missing"
[ -r "$ENV_FILE" ] || fail "staging environment is missing"
command -v psql >/dev/null 2>&1 || fail "psql is required"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

[ "${NEWME_STAGING_PROJECT_REF:-}" = "$EXPECTED_REF" ] ||
  fail "NEWME_STAGING_PROJECT_REF does not match"
[ "${SUPABASE_PROJECT_REF:-}" = "$EXPECTED_REF" ] ||
  fail "SUPABASE_PROJECT_REF does not match"
[ -n "${SUPABASE_DB_PASSWORD:-}" ] ||
  fail "cleanroom database password is not configured"

DB_HOST="${SUPABASE_DB_HOST:-aws-0-ap-southeast-1.pooler.supabase.com}"
DB_PORT="${SUPABASE_DB_PORT:-5432}"
DB_USER="${SUPABASE_DB_USER:-postgres.$EXPECTED_REF}"
DB_NAME="${SUPABASE_DB_NAME:-postgres}"

[[ "$DB_HOST" =~ ^[a-z0-9.-]+$ ]] || fail "database host is invalid"
[[ "$DB_PORT" =~ ^[0-9]{1,5}$ ]] || fail "database port is invalid"
[ "$DB_USER" = "postgres.$EXPECTED_REF" ] ||
  fail "database user must be scoped to the staging project"
[[ "$DB_NAME" =~ ^[a-zA-Z0-9_]+$ ]] || fail "database name is invalid"

OUTPUT="$(mktemp)"
trap 'rm -f -- "$OUTPUT"' EXIT

PGPASSWORD="$SUPABASE_DB_PASSWORD" \
PGCONNECT_TIMEOUT=10 \
PGSSLMODE=require \
psql \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --no-psqlrc \
  --set=ON_ERROR_STOP=1 \
  --tuples-only \
  --no-align \
  --quiet \
  --file="$SQL_FILE" >"$OUTPUT"

if grep -q '[^[:space:]]' "$OUTPUT"; then
  fail "cleanroom returned SECURITY DEFINER allowlist violations"
fi

echo "staging live security gate passed project=$EXPECTED_REF"
