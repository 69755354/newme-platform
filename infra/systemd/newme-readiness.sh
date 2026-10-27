#!/usr/bin/env bash
set -u -o pipefail
CONFIG="$(mktemp /run/newme-readiness.XXXXXX)"
chmod 600 "$CONFIG"
trap 'rm -f -- "$CONFIG"' EXIT
cat >"$CONFIG" <<'EOF'
header = "Host: app.newme.ae"
header = "Origin: https://app.newme.ae"
header = "Content-Type: application/json"
EOF

# Process supervision tests local liveness and the production Origin boundary.
# Supabase availability is checked before a release switch and continuously by
# dependency-probe.sh; an upstream outage must not trigger a restart storm.
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  health_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 \
    http://127.0.0.1:3001/api/health 2>/dev/null || true)"
  session_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 \
    --config "$CONFIG" -X POST --data '{}' \
    http://127.0.0.1:3001/api/auth/session 2>/dev/null || true)"
  if [ "$health_code" = 200 ] && [ "$session_code" = 400 ]; then
    exit 0
  fi
  sleep 2
done
logger -t newme-readiness "local startup verification failed health=${health_code:-000} session=${session_code:-000}"
exit 1
