#!/usr/bin/env bash
set -euo pipefail

: "${NEWME_STAGING_PROJECT_REF:?missing staging project ref}"
: "${SAM26_EXPECTED_RELEASE_SHA:?missing expected release SHA}"
: "${NEXT_PUBLIC_SUPABASE_URL:?missing staging Supabase URL}"
: "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?missing staging publishable key}"
: "${SUPABASE_SERVICE_ROLE_KEY:?missing staging service key}"
: "${SAM26_BASE_URL:?missing staging app URL}"
: "${SAM26_RELEASE_MANIFEST:?missing read-only release manifest}"

readonly STAGING_REF="bfsiibofuzoglziltgyd"
readonly PRODUCTION_REF="vfopmpxlhwzpxqegayew"

[[ "$NEWME_STAGING_PROJECT_REF" == "$STAGING_REF" ]] || {
  echo "refusing non-staging project" >&2
  exit 64
}
[[ "$SAM26_EXPECTED_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "invalid expected release SHA" >&2
  exit 64
}
[[ "$NEXT_PUBLIC_SUPABASE_URL" == "https://${STAGING_REF}.supabase.co" ]] || {
  echo "refusing non-staging Supabase URL" >&2
  exit 65
}
[[ "$SAM26_BASE_URL" == "https://staging.newme.ae" ]] || {
  echo "refusing non-staging application URL" >&2
  exit 65
}
[[ "$SAM26_RELEASE_MANIFEST" == "/runner/release/manifest.json" && -r "$SAM26_RELEASE_MANIFEST" ]] || {
  echo "refusing missing or non-fixed release manifest" >&2
  exit 65
}
for value in "$NEXT_PUBLIC_SUPABASE_URL" "$NEXT_PUBLIC_SUPABASE_ANON_KEY" "$SUPABASE_SERVICE_ROLE_KEY" "$SAM26_BASE_URL"; do
  [[ "$value" != *"$PRODUCTION_REF"* ]] || {
    echo "production reference detected" >&2
    exit 65
  }
done

exec node /runner/verify-staging-sam26-roles.mjs
