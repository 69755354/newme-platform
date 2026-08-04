#!/usr/bin/env bash
set -euo pipefail

: "${SAM_UAT_SUITE:?missing staging UAT suite}"
: "${NEWME_STAGING_PROJECT_REF:?missing staging project ref}"
: "${NEXT_PUBLIC_SUPABASE_URL:?missing staging Supabase URL}"
: "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?missing staging publishable key}"
: "${SUPABASE_SERVICE_ROLE_KEY:?missing staging service key}"

readonly STAGING_REF="bfsiibofuzoglziltgyd"
readonly PRODUCTION_REF="vfopmpxlhwzpxqegayew"

[[ "$NEWME_STAGING_PROJECT_REF" == "$STAGING_REF" ]] || {
  echo "refusing non-staging project" >&2
  exit 64
}
[[ "$NEXT_PUBLIC_SUPABASE_URL" == "https://${STAGING_REF}.supabase.co" ]] || {
  echo "refusing non-staging Supabase URL" >&2
  exit 65
}
for value in "$NEXT_PUBLIC_SUPABASE_URL" "$NEXT_PUBLIC_SUPABASE_ANON_KEY" "$SUPABASE_SERVICE_ROLE_KEY"; do
  [[ "$value" != *"$PRODUCTION_REF"* ]] || {
    echo "production reference detected" >&2
    exit 65
  }
done

case "$SAM_UAT_SUITE" in
  sam26)
    : "${SAM26_EXPECTED_RELEASE_SHA:?missing expected release SHA}"
    : "${SAM26_BASE_URL:?missing staging app URL}"
    : "${SAM26_RELEASE_MANIFEST:?missing read-only release manifest}"
    [[ "$SAM26_EXPECTED_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
      echo "invalid expected release SHA" >&2
      exit 64
    }
    [[ "$SAM26_BASE_URL" == "https://staging.newme.ae" ]] || {
      echo "refusing non-staging application URL" >&2
      exit 65
    }
    [[ "$SAM26_RELEASE_MANIFEST" == "/runner/release/manifest.json" && -r "$SAM26_RELEASE_MANIFEST" ]] || {
      echo "refusing missing or non-fixed release manifest" >&2
      exit 65
    }
    [[ "$SAM26_BASE_URL" != *"$PRODUCTION_REF"* ]] || exit 65
    exec node /runner/verify-staging-sam26-roles.mjs
    ;;
  sam70)
    : "${SAM70_EXPECTED_RELEASE_SHA:?missing expected release SHA}"
    : "${SAM70_BASE_URL:?missing staging app URL}"
    : "${SAM70_RELEASE_MANIFEST:?missing read-only release manifest}"
    : "${SAM70_UAT_CONFIRM:?missing staging-only confirmation}"
    [[ "$SAM70_EXPECTED_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
      echo "invalid expected release SHA" >&2
      exit 64
    }
    [[ "$SAM70_BASE_URL" == "https://staging.newme.ae" ]] || {
      echo "refusing non-staging application URL" >&2
      exit 65
    }
    [[ "$SAM70_RELEASE_MANIFEST" == "/runner/release/manifest.json" && -r "$SAM70_RELEASE_MANIFEST" ]] || {
      echo "refusing missing or non-fixed release manifest" >&2
      exit 65
    }
    [[ "$SAM70_UAT_CONFIRM" == "SAM70_STAGING_ONLY" ]] || {
      echo "refusing missing staging-only confirmation" >&2
      exit 65
    }
    [[ "$SAM70_BASE_URL" != *"$PRODUCTION_REF"* ]] || exit 65
    exec node /runner/verify-staging-sam70-xlsx.mjs
    ;;
  sam23)
    : "${SAM23_RELEASE_SHA:?missing expected release SHA}"
    : "${SAM23_UAT_BASE_URL:?missing staging app URL}"
    : "${SAM23_RELEASE_MANIFEST:?missing read-only release manifest}"
    : "${SAM23_UAT_CONFIRM:?missing staging-only confirmation}"
    [[ "$SAM23_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
      echo "invalid expected release SHA" >&2
      exit 64
    }
    [[ "$SAM23_UAT_BASE_URL" == "http://127.0.0.1:3101" ]] || {
      echo "refusing non-loopback staging application URL" >&2
      exit 65
    }
    [[ "$SAM23_RELEASE_MANIFEST" == "/runner/release/manifest.json" && -r "$SAM23_RELEASE_MANIFEST" ]] || {
      echo "refusing missing or non-fixed release manifest" >&2
      exit 65
    }
    [[ "$SAM23_UAT_CONFIRM" == "SAM23_STAGING_ONLY" ]] || {
      echo "refusing missing staging-only confirmation" >&2
      exit 65
    }
    exec node /runner/sam23-organization-commercial-core.mjs
    ;;
  product-saas-final)
    : "${PRODUCT_UAT_RELEASE_SHA:?missing expected release SHA}"
    : "${PRODUCT_UAT_BASE_URL:?missing staging app URL}"
    : "${PRODUCT_UAT_RELEASE_MANIFEST:?missing read-only release manifest}"
    : "${PRODUCT_UAT_CONFIRM:?missing staging-only confirmation}"
    [[ "$PRODUCT_UAT_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
      echo "invalid expected release SHA" >&2
      exit 64
    }
    [[ "$PRODUCT_UAT_BASE_URL" == "https://staging.newme.ae" ]] || {
      echo "refusing non-staging application URL" >&2
      exit 65
    }
    [[ "$PRODUCT_UAT_RELEASE_MANIFEST" == "/runner/release/manifest.json" && -r "$PRODUCT_UAT_RELEASE_MANIFEST" ]] || {
      echo "refusing missing or non-fixed release manifest" >&2
      exit 65
    }
    [[ "$PRODUCT_UAT_CONFIRM" == "PRODUCT_SAAS_STAGING_ONLY" ]] || {
      echo "refusing missing staging-only confirmation" >&2
      exit 65
    }
    [[ "$PRODUCT_UAT_BASE_URL" != *"$PRODUCTION_REF"* ]] || exit 65
    exec node /runner/product-saas-final.mjs
    ;;
  sam78)
    : "${SAM78_EXPECTED_RELEASE_SHA:?missing expected release SHA}"
    : "${SAM78_BASE_URL:?missing staging app URL}"
    : "${SAM78_RELEASE_MANIFEST:?missing read-only release manifest}"
    : "${SAM78_UAT_CONFIRM:?missing staging-only confirmation}"
    [[ "$SAM78_EXPECTED_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
      echo "invalid expected release SHA" >&2
      exit 64
    }
    [[ "$SAM78_BASE_URL" == "http://127.0.0.1:3101" ]] || {
      echo "refusing non-loopback staging application URL" >&2
      exit 65
    }
    [[ "$SAM78_RELEASE_MANIFEST" == "/runner/release/manifest.json" && -r "$SAM78_RELEASE_MANIFEST" ]] || {
      echo "refusing missing or non-fixed release manifest" >&2
      exit 65
    }
    [[ "$SAM78_UAT_CONFIRM" == "SAM78_STAGING_TENANT_CLOSURE_ONLY" ]] || {
      echo "refusing missing staging-only confirmation" >&2
      exit 65
    }
    exec node /runner/sam78-staging-tenant-closure.mjs
    ;;
  *)
    echo "refusing unknown staging UAT suite" >&2
    exit 64
    ;;
esac
