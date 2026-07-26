#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${NEWME_STAGING_ENV_FILE:-$ROOT/.env.local}"
EXPECTED_REF="${NEWME_STAGING_PROJECT_REF:-}"
MODE="${NEWME_STAGING_BOUNDARY_MODE:-runtime}"
PRODUCTION_REF="vfopmpxlhwzpxqegayew"

fail() {
  echo "staging boundary check failed: $*" >&2
  exit 1
}

[[ "$EXPECTED_REF" =~ ^[a-z]{20}$ ]] || fail "NEWME_STAGING_PROJECT_REF must be an explicit 20-character project ref"
[ "$EXPECTED_REF" != "$PRODUCTION_REF" ] || fail "the production Supabase ref is forbidden in staging"
[ "$MODE" = "build" ] || [ "$MODE" = "runtime" ] || fail "boundary mode must be build or runtime"
[ -r "$ENV_FILE" ] || fail "staging environment file is not readable"
[ ! -e "$ROOT/supabase/.temp/project-ref" ] || fail "tracked Supabase link state is forbidden"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

[ "${SUPABASE_PROJECT_REF:-}" = "$EXPECTED_REF" ] || fail "SUPABASE_PROJECT_REF does not match the approved staging ref"
[ "${NEXT_PUBLIC_SUPABASE_URL:-}" = "https://${EXPECTED_REF}.supabase.co" ] || fail "NEXT_PUBLIC_SUPABASE_URL does not match the approved staging ref"
[ "${NEXT_PUBLIC_SITE_URL:-}" = "https://staging.newme.ae" ] || fail "NEXT_PUBLIC_SITE_URL must be the staging hostname"
if [ "$MODE" = "runtime" ]; then
  [[ "${SUPABASE_SERVICE_ROLE_KEY:-}" == sb_secret_* ]] || fail "a dedicated modern Supabase secret key is required"
else
  [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ] || fail "Supabase secret keys are forbidden on external builders"
fi
[ -z "${SUPABASE_PAT:-}" ] || fail "SUPABASE_PAT is forbidden in staging runtime"
[ -z "${SUPABASE_DB_PASSWORD:-}" ] || fail "SUPABASE_DB_PASSWORD is forbidden in staging runtime"
[ -z "${SENTRY_AUTH_TOKEN:-}" ] || fail "SENTRY_AUTH_TOKEN is forbidden in staging runtime"
[ -z "${NEXT_PUBLIC_SENTRY_DSN:-}" ] || fail "production Sentry must be disabled in staging"
[ -z "${SENTRY_DSN:-}" ] || fail "production Sentry must be disabled in staging"
for forbidden_integration in \
  SENTRY_ORG \
  SENTRY_PROJECT \
  META_APP_ID \
  META_APP_SECRET \
  META_CAPI_WEBHOOK_SECRET \
  META_REDIRECT_URI \
  NEXT_PUBLIC_POSTHOG_HOST \
  NEXT_PUBLIC_POSTHOG_KEY \
  COS_BUCKET \
  COS_REGION \
  COS_SECRET_ID \
  COS_SECRET_KEY; do
  [ -z "${!forbidden_integration:-}" ] ||
    fail "${forbidden_integration} is forbidden in isolated staging"
done

echo "staging ${MODE} boundaries verified for project ref ${EXPECTED_REF}"
