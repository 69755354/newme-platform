#!/usr/bin/env bash
set -u
TOKEN="$(sed -n 's/^NEWME_READINESS_TOKEN=//p' /etc/newme/newme-runtime.env 2>/dev/null || true)"
[ -n "$TOKEN" ] || exit 1
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -H "x-newme-readiness-token: $TOKEN" http://127.0.0.1:3001/api/ready || true)"
  [ "$code" = 200 ] && exit 0
  sleep 2
done
exit 1
