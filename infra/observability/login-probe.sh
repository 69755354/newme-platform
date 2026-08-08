#!/usr/bin/env bash
# Production login-boundary probe. It uses no employee credentials and creates
# no users or business data.
set -euo pipefail

source /opt/hermes-scripts/observability/sentry-cron-checkin.sh
sentry_checkin_start "login-probe"

SITE_URL="${SITE_URL:-http://localhost:3001}"
SITE_ORIGIN="${SITE_ORIGIN:-https://app.newme.ae}"
ALERT_SCRIPT="${HERMES_ALERT_STATE_SCRIPT:-/opt/hermes-scripts/observability/hermes-alert-state-v1.sh}"
AUTH_LOG_PROBE="${AUTH_LOG_PROBE:-/opt/hermes-scripts/observability/auth-log-probe.py}"
AUTH_LOG_WINDOW_SECONDS="${AUTH_LOG_WINDOW_SECONDS:-600}"
MAX_RETRIES=2
TIMEOUT=10
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

record_alert() {
  local event="$1"
  local summary="$2"
  local transition=""
  local status=0
  transition="$(bash "$ALERT_SCRIPT" "login-probe" "$event" "$summary" 2>&1)" || status=$?
  printf '%s\n' "$transition"
  if printf '%s' "$transition" | grep -q 'capture=1'; then
    /opt/hermes-scripts/observability/incident-capture.sh "login-probe" "$summary" &
  fi
  if [ "$status" -ne 0 ]; then
    echo "[$TIMESTAMP] ALERT_STATE_FAILED: retry will occur on the next run" >&2
  fi
  return "$status"
}

fail_probe() {
  local code="$1"
  local summary="$2"
  local alert_status=0
  echo "[$TIMESTAMP] $code: $summary"
  record_alert failure "$summary" || alert_status=$?
  sentry_checkin_finish "login-probe" 1
  if [ "$alert_status" -ne 0 ]; then
    echo "[$TIMESTAMP] alert transport remains pending" >&2
  fi
  exit 1
}

# 1. Basic application liveness must be exactly HTTP 200.
HEALTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  "${SITE_URL}/api/health" 2>/dev/null) || HEALTH_CODE="000"
if [ "$HEALTH_CODE" != "200" ]; then
  fail_probe "HEALTH_PROBE_FAIL" "health endpoint returned HTTP $HEALTH_CODE"
fi

# 2. A valid production Origin must reach body validation. HTTP 403 here is
# the exact failure mode caused by a bad NEXT_PUBLIC_SITE_URL runtime value.
SESSION_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  -X POST "${SITE_URL}/api/auth/session" \
  -H "Origin: ${SITE_ORIGIN}" \
  -H "Content-Type: application/json" \
  --data '{}' 2>/dev/null) || SESSION_CODE="000"
if [ "$SESSION_CODE" != "400" ]; then
  fail_probe "SESSION_ORIGIN_PROBE_FAIL" \
    "valid-origin session probe expected HTTP 400 and received $SESSION_CODE"
fi

# 3. Detect real traffic that reached either authentication endpoint and
# returned 5xx. This closes the blind spot where an anonymous auth/me request
# was 401 while every signed-in user received 500.
AUTH_LOG_STATUS=0
AUTH_LOG_RESULT=$(python3 "$AUTH_LOG_PROBE" \
  --window-seconds "$AUTH_LOG_WINDOW_SECONDS" 2>&1) || AUTH_LOG_STATUS=$?
case "$AUTH_LOG_STATUS" in
  0) ;;
  1) fail_probe "AUTH_5XX_PROBE_FAIL" "recent auth endpoint 5xx detected" ;;
  *) fail_probe "AUTH_LOG_PROBE_ERROR" "auth access-log probe unavailable: $AUTH_LOG_RESULT" ;;
esac

# 4. The anonymous auth boundary must remain a bounded 401. Retry transport
# failures, while authenticated 5xx responses are covered by the log probe.
attempt=0
last_error=""
while [ "$attempt" -le "$MAX_RETRIES" ]; do
  AUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    "${SITE_URL}/api/auth/me" \
    -H "Content-Type: application/json" 2>/dev/null) || AUTH_CODE="000"

  if [ "$AUTH_CODE" = "401" ]; then
    if ! record_alert recovery "login probe recovered"; then
      sentry_checkin_finish "login-probe" 1
      exit 1
    fi
    sentry_checkin_finish "login-probe" 0
    echo "[$TIMESTAMP] login boundary OK (health 200, session/origin 400, auth/me 401, auth 5xx 0, attempt $((attempt + 1)))"
    exit 0
  fi

  [ "$AUTH_CODE" = "000" ] && last_error="connection timeout" || last_error="HTTP $AUTH_CODE"
  attempt=$((attempt + 1))
  [ "$attempt" -le "$MAX_RETRIES" ] && sleep 2
done

fail_probe "AUTH_ME_PROBE_FAIL" \
  "anonymous auth/me failed after $MAX_RETRIES retries: $last_error"
