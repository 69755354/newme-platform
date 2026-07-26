#!/usr/bin/env bash
set -Eeuo pipefail

SQL_FILE="${1:-}"
EXPECTED_REF="${2:-}"
RUNTIME_ENV_FILE="${3:-/etc/newme-staging/staging.env}"
GATE_ENV_FILE="${4:-/etc/newme-staging/live-gate.env}"
PRODUCTION_REF="vfopmpxlhwzpxqegayew"
POOLER_HOST="aws-0-ap-southeast-1.pooler.supabase.com"

fail() {
  echo "staging live security gate failed: $*" >&2
  exit 1
}

[[ "$EXPECTED_REF" =~ ^[a-z]{20}$ ]] ||
  fail "expected project ref must be 20 lowercase letters"
[ "$EXPECTED_REF" != "$PRODUCTION_REF" ] ||
  fail "production Supabase ref is forbidden"
[ -r "$SQL_FILE" ] || fail "reviewed live gate SQL is missing"
[ -r "$RUNTIME_ENV_FILE" ] || fail "staging runtime environment is missing"
[ -r "$GATE_ENV_FILE" ] || fail "staging live gate environment is missing"
command -v psql >/dev/null 2>&1 || fail "psql is required"

set -a
# shellcheck disable=SC1090
. "$RUNTIME_ENV_FILE"
set +a

[ "${NEWME_STAGING_PROJECT_REF:-}" = "$EXPECTED_REF" ] ||
  fail "NEWME_STAGING_PROJECT_REF does not match"
[ "${SUPABASE_PROJECT_REF:-}" = "$EXPECTED_REF" ] ||
  fail "SUPABASE_PROJECT_REF does not match"
[ -z "${SUPABASE_DB_PASSWORD:-}" ] ||
  fail "database password is forbidden in staging runtime"

if grep -Eq '^(NEWME_STAGING_PROJECT_REF|SUPABASE_PROJECT_REF)=' "$GATE_ENV_FILE"; then
  fail "live gate environment must not redefine project refs"
fi

set -a
# shellcheck disable=SC1090
. "$GATE_ENV_FILE"
set +a

[ -n "${SUPABASE_DB_PASSWORD:-}" ] ||
  fail "cleanroom database password is not configured"

DB_HOST="${SUPABASE_DB_HOST:-$POOLER_HOST}"
DB_PORT="${SUPABASE_DB_PORT:-5432}"
DB_USER="${SUPABASE_DB_USER:-postgres.$EXPECTED_REF}"
DB_NAME="${SUPABASE_DB_NAME:-postgres}"

[ "$DB_HOST" = "$POOLER_HOST" ] ||
  [ "$DB_HOST" = "db.$EXPECTED_REF.supabase.co" ] ||
  fail "database host is not the reviewed staging endpoint"
[[ "$DB_PORT" =~ ^[0-9]{1,5}$ ]] || fail "database port is invalid"
[ "$DB_USER" = "postgres.$EXPECTED_REF" ] ||
  fail "database user must be scoped to the staging project"
[[ "$DB_NAME" =~ ^[a-zA-Z0-9_]+$ ]] || fail "database name is invalid"

OUTPUT="$(mktemp)"
trap 'rm -f -- "$OUTPUT"' EXIT

PGPASSWORD="$SUPABASE_DB_PASSWORD" \
PGCONNECT_TIMEOUT=10 \
PGSSLMODE=verify-full \
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
