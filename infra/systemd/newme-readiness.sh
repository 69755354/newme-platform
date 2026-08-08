#!/usr/bin/env bash
set -u
TOKEN="$(sed -n 's/^NEWME_READINESS_TOKEN=//p' /etc/newme/newme-runtime.env 2>/dev/null || true)"
[ -n "$TOKEN" ] || exit 1
CONFIG="$(mktemp /run/newme-readiness.XXXXXX)"
chmod 600 "$CONFIG"
trap 'rm -f -- "$CONFIG"' EXIT
printf 'header = "x-newme-readiness-token: %s"\n' "$TOKEN" >"$CONFIG"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 --config "$CONFIG" http://127.0.0.1:3001/api/ready || true)"
  [ "$code" = 200 ] && exit 0
  sleep 2
done

# Compatibility only for a pre-hotfix release whose readiness route still
# depends on SUPABASE_SERVICE_ROLE_KEY. This keeps the old process available
# while the immutable auth-recovery release is built; new releases must pass
# the protected /api/ready probe above.
LEGACY_READY_SOURCE=/opt/newme/current/src/app/api/ready/route.ts
if grep -Fq SUPABASE_SERVICE_ROLE_KEY "$LEGACY_READY_SOURCE" 2>/dev/null; then
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3001/api/health || true)"
  if [ "$code" = 200 ]; then
    logger -t newme-readiness 'legacy readiness fallback used; service key rotation required'
    exit 0
  fi
fi
exit 1
