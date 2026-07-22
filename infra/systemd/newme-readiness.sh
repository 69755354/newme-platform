#!/usr/bin/env bash
set -u

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3001/api/ready || true)
  if [ "$code" = "200" ]; then
    echo "readiness passed on attempt $attempt"
    exit 0
  fi
  echo "readiness pending on attempt $attempt: http=$code"
  sleep 2
done

echo "readiness failed after 10 attempts" >&2
exit 1
